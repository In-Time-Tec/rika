import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"

const sqliteSurface = await import("@relayfx/sdk/sqlite").then((module) => "ChildFanOutRuntime" in module)
const script = new URL("../../app/test/multi-agent-process.ts", import.meta.url).pathname
type Host = ReturnType<typeof startHost>

const startHost = (database: string, workspace: string) => {
  const proc = Bun.spawn([process.execPath, script], {
    cwd: process.cwd(),
    env: { ...process.env, RIKA_MULTI_AGENT_DATABASE: database, RIKA_MULTI_AGENT_WORKSPACE: workspace },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  let sequence = 0
  let buffer = ""
  let readyResolve!: (pid: number) => void
  const ready = new Promise<number>((resolve) => (readyResolve = resolve))
  void (async () => {
    for await (const chunk of proc.stdout) {
      buffer += new TextDecoder().decode(chunk)
      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        const message = JSON.parse(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        if (message.type === "ready") readyResolve(message.pid)
        const waiter = pending.get(message.id)
        if (waiter !== undefined) {
          pending.delete(message.id)
          if (message.ok) waiter.resolve(message.value)
          else waiter.reject(new Error(message.error))
        }
        newline = buffer.indexOf("\n")
      }
    }
  })()
  const request = (type: string, value?: unknown) =>
    new Promise<any>((resolve, reject) => {
      const id = `request-${++sequence}`
      pending.set(id, { resolve, reject })
      proc.stdin.write(`${JSON.stringify({ id, type, value })}\n`)
    })
  return { proc, ready, request }
}

const waitFor = async <A>(read: () => Promise<A>, accept: (value: A) => boolean) => {
  const poll = async (remaining: number): Promise<A> => {
    if (remaining === 0) throw new Error("timed out waiting for Rika multi-agent state")
    const value = await read()
    if (accept(value)) return value
    await Bun.sleep(20)
    return poll(remaining - 1)
  }
  return poll(500)
}

const input = (name: string, joinPolicy: "all" | "first-success" | "quorum" | "best-effort", count = 4) => ({
  parentTurnId: `parent-${name}`,
  fanOutId: `fan-out:rika:${name}`,
  tasks: Array.from({ length: count }, (_, ordinal) => ({ id: `${name}-${ordinal}`, prompt: `task ${ordinal}` })),
  maxConcurrency: 2,
  join: joinPolicy,
  ...(joinPolicy === "quorum" ? { quorum: 2 } : {}),
  createdAt: 100,
})

const release = (directory: string, name: string, ordinal: number, status = "completed") =>
  writeFile(
    join(directory, `child:${name}-${ordinal}.json`),
    JSON.stringify({ status, output: [{ _tag: "text", text: `output-${ordinal}` }], completedAt: 200 + ordinal }),
  )

test.skipIf(!sqliteSurface)(
  "Rika ProductAgent fan-outs survive process death without duplicate projections",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "rika-multi-agent-"))
    const database = join(directory, "relay.sqlite")
    let host: Host | undefined
    try {
      host = startHost(database, directory)
      const firstPid = await host.ready
      void host.request("run", input("restart", "all"))
      const dispatches = () =>
        readFile(join(directory, "visible.ndjson"), "utf8").then(
          (text) =>
            text
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line))
              .filter((row) => row.type === "dispatch"),
          () => [],
        )
      await waitFor(dispatches, (rows) => rows.length === 2)
      host.proc.kill("SIGKILL")
      await host.proc.exited

      host = startHost(database, directory)
      expect(await host.ready).not.toBe(firstPid)
      await Promise.all(Array.from({ length: 4 }, (_, ordinal) => release(directory, "restart", ordinal)))
      const resumed = await waitFor(
        () => host!.request("inspect", "fan-out:rika:restart"),
        (inspection) => inspection?.state === "satisfied",
      )
      expect(resumed.members.map((member: any) => member.ordinal)).toEqual([0, 1, 2, 3])
      const projection = await host.request("project", "fan-out:rika:restart")
      expect(new Set(projection.map((member: any) => member.childId)).size).toBe(4)
      expect(projection.every((member: any) => member.state === "completed")).toBe(true)

      const cases = [
        ["all", ["completed", "completed", "completed"], "satisfied"],
        ["first-success", ["failed", "completed", "failed"], "satisfied"],
        ["quorum", ["completed", "failed", "completed"], "satisfied"],
        ["best-effort", ["failed", "completed", "cancelled"], "satisfied"],
      ] as const
      const verifyCases = async (remaining: ReadonlyArray<(typeof cases)[number]>): Promise<void> => {
        if (remaining.length === 0) return
        const [policy, statuses, expected] = remaining[0]!
        const rest = remaining.slice(1)
        await host!.request("run", input(policy, policy, 3))
        await Promise.all(statuses.map((status, ordinal) => release(directory, policy, ordinal, status)))
        const completed = await waitFor(
          () => host!.request("inspect", `fan-out:rika:${policy}`),
          (inspection) => inspection?.state !== "joining",
        )
        expect(completed.state).toBe(expected)
        expect(completed.members.map((member: any) => member.ordinal)).toEqual([0, 1, 2])
        await verifyCases(rest)
      }
      await verifyCases(cases)

      const pending = input("cancel", "all", 3)
      void host.request("run", pending)
      await waitFor(
        () => host!.request("inspect", pending.fanOutId),
        (inspection) => inspection?.state === "joining",
      )
      const cancelled = await host.request("cancel", { id: pending.fanOutId, at: 300, reason: "parent cancelled" })
      expect(cancelled.state).toBe("cancelled")
      expect((await host.request("cancel", { id: pending.fanOutId, at: 301 })).state).toBe("cancelled")
      const effects = (await readFile(join(directory, "visible.ndjson"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((row) => row.type === "effect")
      expect(new Set(effects.map((row) => `${row.fanOutId}:${row.childId}`)).size).toBe(effects.length)
    } finally {
      if (host?.proc.exitCode === null && host.proc.signalCode === null) host.proc.kill("SIGKILL")
    }
  },
  120_000,
)
