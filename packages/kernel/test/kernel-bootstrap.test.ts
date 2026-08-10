import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { moduleNames } from "@rika/kernel/binding-modules"
import { globals, source } from "@rika/kernel/kernel-bootstrap"

type Call = (input: unknown) => Promise<unknown>

interface Sandbox {
  readonly rika: Record<string, Record<string, Call>> & { readonly mcp: Record<string, Record<string, Call>> }
  readonly context: unknown
}

const server = (sandbox: Sandbox, name: string): Record<string, Call> => sandbox.rika.mcp[name]!
const flat = (sandbox: Sandbox, name: string): Call => (sandbox.rika.mcp as unknown as Record<string, Call>)[name]!

const discovered = [
  { name: "read", rawName: "raw_read" },
  { name: "write", rawName: "raw_write" },
]

interface Recorder {
  readonly calls: Array<unknown>
  readonly toolCalls: Array<unknown>
}

/**
 * Evaluate the bootstrap the way the worker does: the mounted modules are already flat globals and
 * this source assembles `rika` from them. The host stubs answer with Promises because that is what a
 * mounted binding looks like inside the kernel, which is ordinary TypeScript rather than Effect.
 */
const evaluate = (
  recorder: Recorder,
  stale = false,
  availableTools: Array<(typeof discovered)[number]> = discovered,
): Effect.Effect<Sandbox> =>
  Effect.promise(() => {
    const scope: Record<string, unknown> = {}
    for (const name of moduleNames) scope[name] = {}
    scope.mcp = {
      servers: () => Promise.resolve([{ name: "files", kind: "local", enabled: true }]),
      tools: (input: unknown) => {
        recorder.toolCalls.push(input)
        return Promise.resolve(availableTools)
      },
      call: (input: unknown) => {
        recorder.calls.push(input)
        return Promise.resolve({ content: { ok: true }, isError: false })
      },
    }
    scope.context = {
      current: () => Promise.resolve({ threadId: "thread", workspace: "/repo", trustMode: "trusted-local" }),
    }
    scope.kernel = { ...scope }
    if (stale) {
      scope.rika = "/stale/path"
      scope.workspace = { stale: true }
    }
    const body = `return (async () => { ${source().replaceAll("globalThis", "host")} ; return { rika: host.rika, context: host.context } })()`
    const run = new Function("host", body) as (host: Record<string, unknown>) => Promise<Sandbox>
    return run({ ...scope })
  })

const recorder = (): Recorder => ({ calls: [], toolCalls: [] })

describe("kernel bootstrap", () => {
  it.effect("assembles rika from exactly the mounted modules and nothing else", () =>
    Effect.gen(function* () {
      const sandbox = yield* evaluate(recorder())
      expect(Object.keys(sandbox.rika).toSorted()).toEqual([...moduleNames].toSorted())
    }),
  )

  it("defines only rika and context, so nothing else leaks into the namespace", () => {
    expect(globals).toEqual(["rika", "context"])
  })

  it.effect("binds context from the live host rather than a snapshot", () =>
    Effect.gen(function* () {
      const sandbox = yield* evaluate(recorder())
      expect(sandbox.context).toEqual({ threadId: "thread", workspace: "/repo", trustMode: "trusted-local" })
    }),
  )

  it.effect("re-mounts live globals after a snapshot restores stale user values", () =>
    Effect.gen(function* () {
      const sandbox = yield* evaluate(recorder(), true)
      expect(typeof sandbox.rika).toBe("object")
      expect(sandbox.rika.workspace).toEqual({})
      expect(sandbox.context).toEqual({ threadId: "thread", workspace: "/repo", trustMode: "trusted-local" })
    }),
  )

  it.effect("keeps the flat mcp contract reachable beside the proxy", () =>
    Effect.gen(function* () {
      const sandbox = yield* evaluate(recorder())
      const servers = yield* Effect.promise(() => flat(sandbox, "servers")({}))
      expect(servers).toEqual([{ name: "files", kind: "local", enabled: true }])
    }),
  )

  it.effect("materialises rika.mcp.<server>.<tool> and forwards it to the flat call", () =>
    Effect.gen(function* () {
      const recording = recorder()
      const sandbox = yield* evaluate(recording)
      const response = yield* Effect.promise(() => server(sandbox, "files").read!({ path: "a" }))
      expect(recording.calls).toEqual([{ server: "files", tool: "read", input: { path: "a" } }])
      expect(response).toEqual({ content: { ok: true }, isError: false })
    }),
  )

  it.effect("discovers a server's tools once and reuses them for later calls", () =>
    Effect.gen(function* () {
      const recording = recorder()
      const sandbox = yield* evaluate(recording)
      yield* Effect.promise(() => server(sandbox, "files").read!({}))
      yield* Effect.promise(() => server(sandbox, "files").write!({}))
      expect(recording.toolCalls).toEqual([{ server: "files" }])
    }),
  )

  it.effect("returns typed data for an unknown tool rather than throwing undefined is not a function", () =>
    Effect.gen(function* () {
      const sandbox = yield* evaluate(recorder())
      const response = yield* Effect.promise(() => server(sandbox, "files").ghost!({}))
      expect(response).toMatchObject({ _tag: "McpBindingNotFound", module: "files", operation: "ghost" })
    }),
  )

  it.effect("explains that a tool added after discovery becomes visible in the next cell", () =>
    Effect.gen(function* () {
      const recording = recorder()
      const availableTools = [discovered[0]!]
      const sandbox = yield* evaluate(recording, false, availableTools)
      yield* Effect.promise(() => server(sandbox, "files").read!({}))
      availableTools.push(discovered[1]!)

      const response = yield* Effect.promise(() => server(sandbox, "files").write!({}))

      expect(recording.toolCalls).toEqual([{ server: "files" }])
      expect(recording.calls).toEqual([{ server: "files", tool: "read", input: {} }])
      expect(response).toMatchObject({
        _tag: "McpBindingNotFound",
        module: "files",
        operation: "write",
        message:
          "Server files exposes no tool named write. If write was newly added during this cell, it will be visible in the next cell.",
      })
    }),
  )

  it.effect("accepts a tool addressed by its raw name", () =>
    Effect.gen(function* () {
      const recording = recorder()
      const sandbox = yield* evaluate(recording)
      yield* Effect.promise(() => server(sandbox, "files").raw_write!({ x: 1 }))
      expect(recording.calls).toEqual([{ server: "files", tool: "raw_write", input: { x: 1 } }])
    }),
  )

  it("changes with the mounted surface, so the bindings digest starts a new epoch", () => {
    expect(source(["workspace"])).not.toBe(source(["workspace", "goal"]))
  })
})
