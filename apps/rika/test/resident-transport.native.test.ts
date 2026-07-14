import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

type Process = ReturnType<typeof Bun.spawn>
type Event = {
  type: string
  role?: string
  id?: string
  clientPid?: number
  hostPid?: number
  text?: string
  tag?: string
  error?: string
}

const processes: Array<Process> = []
const hostPids = new Set<number>()

afterEach(async () => {
  for (const process of processes.splice(0)) process.kill(9)
  for (const pid of hostPids) {
    try {
      globalThis.process.kill(pid, "SIGKILL")
    } catch {}
  }
  hostPids.clear()
})

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitUntil = async (condition: () => boolean | Promise<boolean>, timeout = 2_000) => {
  const expires = Date.now() + timeout
  const poll = async (): Promise<void> => {
    if (await condition()) return
    if (Date.now() >= expires) throw new Error("condition timed out")
    await Bun.sleep(20)
    return poll()
  }
  return poll()
}

const start = (root: string, grace = 350, finalizerDelay = 0, delayedWork = false) => {
  const client = Bun.spawn(["bun", "test/fixtures/resident-client.ts"], {
    cwd: import.meta.dir.replace(/\/test$/, ""),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      RIKA_TEST_RESIDENT_DATA_ROOT: root,
      RIKA_TEST_RESIDENT_GRACE: String(grace),
      RIKA_TEST_RESIDENT_FINALIZER_DELAY: String(finalizerDelay),
      RIKA_TEST_RESIDENT_DELAYED_WORK: delayedWork ? "1" : "0",
    },
  })
  processes.push(client)
  const reader = client.stdout.getReader()
  let buffered = ""
  const readLine = async (): Promise<string> => {
    const index = buffered.indexOf("\n")
    if (index >= 0) {
      const line = buffered.slice(0, index)
      buffered = buffered.slice(index + 1)
      return line
    }
    const value = await reader.read()
    if (value.done) throw new Error(`client exited ${await new Response(client.stderr).text()}`)
    buffered += new TextDecoder().decode(value.value)
    return readLine()
  }
  const next = async () => {
    const line = await readLine()
    try {
      return JSON.parse(line) as Event
    } catch {
      throw new Error(`invalid client event: ${line}`)
    }
  }
  const send = (command: string) => client.stdin.write(new TextEncoder().encode(`${command}\n`))
  const close = async () => {
    send("close")
    expect((await next()).type).toBe("closed")
    client.stdin.end()
    await client.exited
  }
  return { client, next, send, close }
}

const attached = async (client: ReturnType<typeof start>) => {
  const event = await client.next()
  expect(event).toMatchObject({ type: "attached", role: "attached" })
  expect(event.clientPid).toBe(client.client.pid)
  expect(event.hostPid).not.toBe(event.clientPid)
  hostPids.add(event.hostPid!)
  return event
}

const nextType = async (client: ReturnType<typeof start>, type: string) => {
  const event = await client.next()
  return event.type === type ? event : nextType(client, type)
}

describe("resident WebSocket process transport", () => {
  test("keeps a healthy connection through a one-second client stall", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-resident-"))
    try {
      const client = start(root, 2_000)
      await attached(client)
      client.send("stall")
      expect((await client.next()).type).toBe("stall-survived")
      await client.close()
    } finally {
      await chmod(root, 0o700).catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  test("lets the first one-shot client exit without stopping its distinct host", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-resident-"))
    try {
      const oneShot = start(root, 1_000)
      const first = await attached(oneShot)
      await oneShot.close()
      expect(alive(first.hostPid!)).toBe(true)

      const next = start(root, 1_000)
      expect((await attached(next)).hostPid).toBe(first.hostPid)
      next.send("ping")
      expect((await next.next()).type).toBe("pong")
    } finally {
      await chmod(root, 0o700).catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  test("completes forwarded output and client-owned interactive sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-resident-"))
    try {
      const client = start(root)
      const event = await attached(client)

      client.send("output")
      expect(await client.next()).toEqual({ type: "output", text: `{"hostPid":${event.hostPid}}\n` })
      expect((await client.next()).type).toBe("output-completed")

      client.send("interactive")
      expect((await client.next()).type).toBe("interactive-callback")
      expect(await client.next()).toEqual({ type: "interactive-event", tag: "ThreadsListed" })
      expect((await client.next()).type).toBe("interactive-completed")
      await client.close()
    } finally {
      await chmod(root, 0o700).catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  test("reports an interactive operation failure before the client callback starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-resident-"))
    try {
      const client = start(root)
      await attached(client)

      client.send("rejected-interactive")
      expect(await client.next()).toEqual({ type: "interactive-rejected", error: "Interactive setup rejected" })
      await client.close()
    } finally {
      await chmod(root, 0o700).catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  test("delivers a long burst of interactive execution events without overflowing", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-resident-"))
    try {
      const client = start(root)
      await attached(client)

      client.send("burst-interactive")
      expect(await client.next()).toEqual({ type: "burst-completed", text: "2000" })
      await client.close()
    } finally {
      await chmod(root, 0o700).catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  test("cancels a resident interactive action before starting the next action", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-resident-"))
    try {
      const client = start(root)
      await attached(client)

      client.send("cancel-action")
      expect(await client.next()).toEqual({ type: "second-action-event", tag: "ThreadsListed" })
      expect((await client.next()).type).toBe("actions-completed")
      await client.close()
    } finally {
      await chmod(root, 0o700).catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  test("uses one distinct host for simultaneous clients and exits after final-client grace", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-resident-"))
    try {
      const [a, b] = [start(root), start(root)]
      const [aEvent, bEvent] = await Promise.all([attached(a), attached(b)])
      expect(aEvent.hostPid).toBe(bEvent.hostPid)
      expect(aEvent.id).not.toBe(bEvent.id)
      expect((await stat(join(root, "resident.token"))).mode & 0o077).toBe(0)
      expect(await readFile(join(root, "owner-acquisitions.log"), "utf8")).toBe(`${aEvent.hostPid}\n`)

      a.client.kill(9)
      await a.client.exited
      expect(alive(aEvent.hostPid!)).toBe(true)
      b.send("ping")
      expect((await b.next()).type).toBe("pong")

      const c = start(root)
      const cEvent = await attached(c)
      expect(cEvent.hostPid).toBe(aEvent.hostPid)
      await b.close()
      expect(alive(aEvent.hostPid!)).toBe(true)
      c.send("ping")
      expect((await c.next()).type).toBe("pong")
      await c.close()

      await waitUntil(() => !alive(aEvent.hostPid!), 2_000)
      expect(await readFile(join(root, "owner-finalizations.log"), "utf8")).toBe(`${aEvent.hostPid}\n`)
    } finally {
      await chmod(root, 0o700).catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  test("survives starter SIGKILL and replaces a SIGKILLed host", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-resident-"))
    try {
      const starter = start(root, 1_000)
      const first = await attached(starter)
      starter.client.kill(9)
      await starter.client.exited
      expect(alive(first.hostPid!)).toBe(true)

      const survivor = start(root, 1_000)
      expect((await attached(survivor)).hostPid).toBe(first.hostPid)
      process.kill(first.hostPid!, "SIGKILL")
      await waitUntil(() => !alive(first.hostPid!))

      const replacement = start(root, 1_000)
      const second = await attached(replacement)
      expect(second.hostPid).not.toBe(first.hostPid)
      const acquisitions = (await readFile(join(root, "owner-acquisitions.log"), "utf8")).trim().split("\n")
      expect(acquisitions).toEqual([String(first.hostPid), String(second.hostPid)])
      replacement.send("ping")
      expect((await replacement.next()).type).toBe("pong")
    } finally {
      await chmod(root, 0o700).catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  test("rejects admission while the previous owner is draining", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-resident-"))
    try {
      const client = start(root, 100, 1_000)
      const first = await attached(client)
      await client.close()
      await waitUntil(() => Bun.file(join(root, "owner-finalizer-starts.log")).exists())

      const rejected = start(root)
      expect(await rejected.next()).toMatchObject({ type: "rejected", error: "Resident service is draining" })
      expect(await readFile(join(root, "owner-acquisitions.log"), "utf8")).toBe(`${first.hostPid}\n`)

      await waitUntil(() => Bun.file(join(root, "owner-finalizations.log")).exists(), 4_000)
      const replacement = start(root)
      const second = await attached(replacement)
      expect(second.hostPid).not.toBe(first.hostPid)
    } finally {
      await chmod(root, 0o700).catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  test("rejects admission while a signalled owner is draining", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-resident-"))
    try {
      const client = start(root, 1_000, 1_000)
      const first = await attached(client)
      process.kill(first.hostPid!, "SIGTERM")
      await waitUntil(() => Bun.file(join(root, "owner-finalizer-starts.log")).exists())

      const rejected = start(root)
      expect(await rejected.next()).toMatchObject({ type: "rejected", error: "Resident service is draining" })
      expect(await readFile(join(root, "owner-acquisitions.log"), "utf8")).toBe(`${first.hostPid}\n`)

      await waitUntil(() => Bun.file(join(root, "owner-finalizations.log")).exists(), 4_000)
      const replacement = start(root)
      const second = await attached(replacement)
      expect(second.hostPid).not.toBe(first.hostPid)
    } finally {
      await chmod(root, 0o700).catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  test("interrupts host work before owner finalization and rejects work from an attached client while draining", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-resident-"))
    try {
      const client = start(root, 1_000, 750, true)
      const first = await attached(client)
      const existing = start(root, 1_000, 750, true)
      expect((await attached(existing)).hostPid).toBe(first.hostPid)
      client.send("delayed")
      await waitUntil(() => Bun.file(join(root, "delayed-work-starts.log")).exists())
      process.kill(first.hostPid!, "SIGTERM")
      existing.send("rejected")
      expect(await existing.next()).toMatchObject({ type: "rejected-work", error: "Resident service is draining" })
      await waitUntil(() => Bun.file(join(root, "owner-finalizer-starts.log")).exists())

      expect(await readFile(join(root, "owner-finalizer-starts.log"), "utf8")).toBe(`${first.hostPid}:0\n`)
      expect(await readFile(join(root, "delayed-work-finalizations.log"), "utf8")).toBe(`${first.hostPid}\n`)
    } finally {
      await chmod(root, 0o700).catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  test("keeps one interactive callback and restores reads across resident replacements without retrying mutations", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-resident-"))
    try {
      const client = start(root, 1_000)
      await attached(client)
      client.send("reconnect-interactive")
      expect(await client.next()).toMatchObject({ type: "interactive-callback", callbacks: 1 })
      expect(await client.next()).toMatchObject({ type: "initial-read", tag: "ThreadsListed" })
      expect(await nextType(client, "replacement-read")).toMatchObject({ tag: "ThreadsListed" })
      expect(await nextType(client, "mutation-failed")).toMatchObject({ tag: "ExecutionFailed" })
      expect(await nextType(client, "post-mutation-read")).toMatchObject({ tag: "ThreadsListed" })
      expect(await nextType(client, "mutation-attempts")).toMatchObject({ text: "1" })
    } finally {
      await chmod(root, 0o700).catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  test("logical close completes a blocking interactive callback and stops its physical connection", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-resident-"))
    try {
      const client = start(root, 250)
      const event = await attached(client)
      client.send("blocking-interactive")
      expect((await client.next()).type).toBe("interactive-callback")
      client.send("close")
      const completed = [await client.next(), await client.next()]
      expect(completed.map((item) => item.type).sort()).toEqual(["blocking-completed", "closed"])
      client.client.stdin.end()
      await client.client.exited
      await waitUntil(() => !alive(event.hostPid!))
    } finally {
      await chmod(root, 0o700).catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)
})
