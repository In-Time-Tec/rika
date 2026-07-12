import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"

const sqliteSurface = await import("@relayfx/sdk/sqlite").then(
  (module) => "ChildFanOutRuntime" in module && "WorkflowDefinitionRuntime" in module,
)
const script = new URL("./workflow-process.ts", import.meta.url).pathname
const startHost = (database: string, workspace: string) => {
  const proc = Bun.spawn([process.execPath, script], {
    cwd: process.cwd(),
    env: { ...process.env, RIKA_WORKFLOW_DATABASE: database, RIKA_WORKFLOW_WORKSPACE: workspace },
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
const rows = (directory: string) =>
  readFile(join(directory, "workflow-visible.ndjson"), "utf8").then(
    (text) =>
      text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    () => [],
  )
const waitFor = async <A>(read: () => Promise<A>, accept: (value: A) => boolean, remaining = 1_000): Promise<A> => {
  const value = await read()
  if (accept(value)) return value
  if (remaining === 0) throw new Error("timed out waiting for Rika workflow state")
  await Bun.sleep(20)
  return waitFor(read, accept, remaining - 1)
}
const release = (directory: string, childId: string) =>
  writeFile(join(directory, `${childId.replaceAll(":", "-")}.release`), "")

for (const scenario of [
  { name: "delivery", first: "child:workflow:delivery-run:delivery:investigate", count: 5 },
  {
    name: "research-synthesis",
    first: "workflow:workflow:research-synthesis-run:fan-out:research:member:research:oracle",
    count: 3,
  },
]) {
  test.skipIf(!sqliteSurface)(
    `${scenario.name} pins its definition and survives SIGKILL without duplicate effects`,
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "rika-workflow-"))
      const database = join(directory, "relay.sqlite")
      let host = startHost(database, directory)
      try {
        const firstPid = await host.ready
        const registrations = await host.request("register")
        const pin = registrations.find((item: any) => item.name === scenario.name)
        expect(pin.revision).toBe(1)
        expect(pin.digest).toMatch(/^sha256:[a-f0-9]{64}$/)
        void host.request("start", { name: scenario.name, runId: `${scenario.name}-run`, revision: pin.revision })
        await waitFor(
          () => rows(directory),
          (items) => items.some((item) => item.type === "dispatch"),
        )
        if (scenario.name === "research-synthesis") {
          const dispatches = (await rows(directory)).filter((row) => row.type === "dispatch")
          await Promise.all(dispatches.map((row) => release(directory, row.childId)))
          await waitFor(
            () => rows(directory),
            (items) => items.filter((item) => item.type === "effect").length >= 2,
          )
          await host.request("recover")
          await waitFor(
            () => rows(directory),
            (items) => items.filter((item) => item.type === "dispatch").length >= 3,
          )
        }
        host.proc.kill("SIGKILL")
        await host.proc.exited
        host = startHost(database, directory)
        expect(await host.ready).not.toBe(firstPid)
        const duplicatePin = (await host.request("register")).find((item: any) => item.name === scenario.name)
        expect(duplicatePin).toEqual(pin)
        const completed = await waitFor(
          async () => {
            const dispatched = (await rows(directory)).filter((item) => item.type === "dispatch")
            await Promise.all(dispatched.map((item) => release(directory, item.childId)))
            return host.request("inspect", `${scenario.name}-run`)
          },
          (state) => state?.status === "completed",
        )
        expect(completed.revision).toBe(pin.revision)
        expect(completed.digest).toBe(pin.digest)
        const visible = await rows(directory)
        const effects = visible.filter((item) => item.type === "effect")
        expect(effects).toHaveLength(scenario.count)
        expect(new Set(effects.map((item) => item.idempotencyKey)).size).toBe(scenario.count)
        expect(visible.some((item) => item.childId === scenario.first)).toBe(true)
      } finally {
        if (host.proc.exitCode === null && host.proc.signalCode === null) host.proc.kill("SIGKILL")
      }
    },
    120_000,
  )
}
