import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { moduleNames } from "@rika/kernel/binding-modules"
import { globals, source } from "@rika/kernel/kernel-bootstrap"

type HostResult<A> = ReturnType<typeof Effect.runPromise<A, never>>
type Call = (input: Schema.Json) => HostResult<Schema.Json>

interface McpSandbox {
  readonly servers: Call
  readonly tools: Call
  readonly call: Call
  readonly files: Record<string, Call>
}

interface Sandbox {
  readonly rika: { readonly mcp: McpSandbox; readonly workspace: object }
  readonly context: Schema.Json
}

const server = (sandbox: Sandbox): Record<string, Call> => sandbox.rika.mcp.files
const flat = (sandbox: Sandbox): Call => sandbox.rika.mcp.servers
const invoke = (call: Call, input: Schema.Json): Effect.Effect<Schema.Json> => Effect.tryPromise(() => call(input))

const discovered = [
  { name: "read", rawName: "raw_read" },
  { name: "write", rawName: "raw_write" },
]

interface Recorder {
  readonly calls: Array<Schema.Json>
  readonly toolCalls: Array<Schema.Json>
}

const evaluate = (
  recorder: Recorder,
  stale = false,
  availableTools: Array<(typeof discovered)[number]> = discovered,
): Effect.Effect<Sandbox> =>
  Effect.tryPromise(() => {
    const scope = Object.fromEntries(moduleNames.map((name) => [name, {}]))
    scope.mcp = {
      servers: () => Effect.runPromise(Effect.succeed([{ name: "files", kind: "local", enabled: true }])),
      tools: (input: Schema.Json) => {
        recorder.toolCalls.push(input)
        return Effect.runPromise(Effect.succeed(availableTools))
      },
      call: (input: Schema.Json) => {
        recorder.calls.push(input)
        return Effect.runPromise(Effect.succeed({ content: { ok: true }, isError: false }))
      },
    }
    scope.context = {
      current: () =>
        Effect.runPromise(Effect.succeed({ threadId: "thread", workspace: "/repo", trustMode: "trusted-local" })),
    }
    scope.kernel = { ...scope }
    if (stale) {
      scope.rika = "/stale/path"
      scope.workspace = { stale: true }
    }
    const body = `return (async () => { ${source().replaceAll("globalThis", "host")} ; return { rika: host.rika, context: host.context } })()`
    const run = new Function("host", body)
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
      expect(sandbox.rika).toBeInstanceOf(Object)
      expect(sandbox.rika.workspace).toEqual({})
      expect(sandbox.context).toEqual({ threadId: "thread", workspace: "/repo", trustMode: "trusted-local" })
    }),
  )

  it.effect("keeps the flat mcp contract reachable beside the proxy", () =>
    Effect.gen(function* () {
      const sandbox = yield* evaluate(recorder())
      const servers = yield* invoke(flat(sandbox), {})
      expect(servers).toEqual([{ name: "files", kind: "local", enabled: true }])
    }),
  )

  it.effect("materialises rika.mcp.<server>.<tool> and forwards it to the flat call", () =>
    Effect.gen(function* () {
      const recording = recorder()
      const sandbox = yield* evaluate(recording)
      const response = yield* invoke(server(sandbox).read!, { path: "a" })
      expect(recording.calls).toEqual([{ server: "files", tool: "read", input: { path: "a" } }])
      expect(response).toEqual({ content: { ok: true }, isError: false })
    }),
  )

  it.effect("discovers a server's tools once and reuses them for later calls", () =>
    Effect.gen(function* () {
      const recording = recorder()
      const sandbox = yield* evaluate(recording)
      yield* invoke(server(sandbox).read!, {})
      yield* invoke(server(sandbox).write!, {})
      expect(recording.toolCalls).toEqual([{ server: "files" }])
    }),
  )

  it.effect("returns typed data for an unknown tool rather than throwing undefined is not a function", () =>
    Effect.gen(function* () {
      const sandbox = yield* evaluate(recorder())
      const response = yield* invoke(server(sandbox).ghost!, {})
      expect(response).toMatchObject({ _tag: "McpBindingNotFound", module: "files", operation: "ghost" })
    }),
  )

  it.effect("explains that a tool added after discovery becomes visible in the next cell", () =>
    Effect.gen(function* () {
      const recording = recorder()
      const availableTools = [discovered[0]!]
      const sandbox = yield* evaluate(recording, false, availableTools)
      yield* invoke(server(sandbox).read!, {})
      availableTools.push(discovered[1]!)

      const response = yield* invoke(server(sandbox).write!, {})

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
      yield* invoke(server(sandbox).raw_write!, { x: 1 })
      expect(recording.calls).toEqual([{ server: "files", tool: "raw_write", input: { x: 1 } }])
    }),
  )

  it("changes with the mounted surface, so the bindings digest starts a new epoch", () => {
    expect(source(["workspace"])).not.toBe(source(["workspace", "goal"]))
  })
})
