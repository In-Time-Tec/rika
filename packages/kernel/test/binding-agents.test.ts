import { describe, expect, it } from "@effect/vitest"
import { Context, Effect } from "effect"
import * as AgentsBinding from "@rika/kernel/agents-binding"
import { AgentDirectoryUnavailable, AgentPort, type Interface } from "@rika/kernel/agent-port"
import { journal, mountModules } from "./binding-support"

const port = (overrides: Partial<Interface> = {}): Interface => ({
  spawn: (input) => Effect.succeed({ childRunId: `child-${input.key}`, key: input.key, duplicate: false }),
  list: Effect.succeed([]),
  inspect: (childRunId) => Effect.succeed({ childRunId, status: "running" as const }),
  cancel: () => Effect.void,
  send: () => Effect.succeed({ messageId: "message", duplicate: false }),
  inbox: () => Effect.succeed([]),
  directory: Effect.succeed([]),
  ...overrides,
})

const registry = (implementation: Interface = port(), nested = { run: (_r: never, e: never) => e } as never) =>
  mountModules({
    modules: [AgentsBinding.module],
    services: Context.make(AgentPort, AgentPort.of(implementation)),
    nested,
  })

describe("agents binding", () => {
  it.effect("mounts the whole child and messaging surface", () =>
    Effect.gen(function* () {
      const mounted = yield* registry()
      expect(mounted.descriptors).toEqual([
        {
          module: "agents",
          operations: ["spawn", "list", "inspect", "inspectAll", "cancel", "send", "inbox", "directory"],
        },
      ])
    }),
  )

  it.effect("derives the admission key from the host operation, never from cell input", () =>
    Effect.gen(function* () {
      const keys: Array<string> = []
      const mounted = yield* registry(
        port({
          spawn: (input) => {
            keys.push(input.key)
            return Effect.succeed({ childRunId: "child", key: input.key, duplicate: false })
          },
        }),
      )
      yield* mounted.invoke({
        module: "agents",
        operation: "spawn",
        input: { profile: "Review", prompt: "review the boundary" },
      })
      expect(keys).toEqual(["operation#0:Review"])
    }),
  )

  it.effect("ignores a forged key or parent in cell input and still derives the host key", () =>
    Effect.gen(function* () {
      const keys: Array<string> = []
      const mounted = yield* registry(
        port({
          spawn: (input) => {
            keys.push(input.key)
            return Effect.succeed({ childRunId: "child", key: input.key, duplicate: false })
          },
        }),
      )
      yield* mounted.invoke({
        module: "agents",
        operation: "spawn",
        input: { profile: "Review", prompt: "p", key: "forged", parentRunId: "victim" },
      })
      expect(keys).toEqual(["operation#0:Review"])
    }),
  )

  it.effect("rejects a profile that is not a spawnable agent", () =>
    Effect.gen(function* () {
      const mounted = yield* registry()
      const response = yield* Effect.flip(
        mounted.invoke({ module: "agents", operation: "spawn", input: { profile: "Title", prompt: "p" } }),
      )
      expect(response._tag).toBe("@batonfx/repl/HostBindingSchemaFailure")
    }),
  )

  it.effect("returns admission receipts, never outcomes", () =>
    Effect.gen(function* () {
      const mounted = yield* registry()
      const response = yield* mounted.invoke({
        module: "agents",
        operation: "spawn",
        input: { profile: "Task", prompt: "do the thing" },
      })
      expect(response).toEqual({
        _tag: "Success",
        output: { childRunId: "child-operation#0:Task", key: "operation#0:Task", duplicate: false },
      })
    }),
  )

  it.effect("inspectAll reads current child state without blocking or polling", () =>
    Effect.gen(function* () {
      let reads = 0
      const mounted = yield* registry(
        port({
          inspect: (childRunId) => {
            reads = reads + 1
            return Effect.succeed({ childRunId, status: "running" as const })
          },
        }),
      )
      const response = yield* mounted.invoke({
        module: "agents",
        operation: "inspectAll",
        input: { childRunIds: ["a", "b"] },
      })
      expect(reads).toBe(2)
      expect(response).toEqual({
        _tag: "Success",
        output: [
          { childRunId: "a", status: "running" },
          { childRunId: "b", status: "running" },
        ],
      })
    }),
  )

  it.live("inspectAll waits until every child is terminal, then reports them", () =>
    Effect.gen(function* () {
      let reads = 0
      const mounted = yield* registry(
        port({
          inspect: (childRunId) => {
            reads = reads + 1
            // The child settles only after the first poll, so a returned "succeeded" proves waiting.
            return Effect.succeed({ childRunId, status: reads > 2 ? ("succeeded" as const) : ("running" as const) })
          },
        }),
      )
      const response = yield* mounted.invoke({
        module: "agents",
        operation: "inspectAll",
        input: { childRunIds: ["a"], waitMillis: 5_000 },
      })
      expect(response).toEqual({ _tag: "Success", output: [{ childRunId: "a", status: "succeeded" }] })
    }),
  )

  it.effect("inspectAll reports a still-running child when the wait elapses rather than failing", () =>
    Effect.gen(function* () {
      const mounted = yield* registry()
      const response = yield* mounted.invoke({
        module: "agents",
        operation: "inspectAll",
        input: { childRunIds: ["a"], waitMillis: 0 },
      })
      // A child that is still working is an ordinary outcome, so the cell reads status rather than
      // handling an error.
      expect(response).toEqual({ _tag: "Success", output: [{ childRunId: "a", status: "running" }] })
    }),
  )

  it.effect("refuses a wait longer than the host ceiling instead of silently clamping it", () =>
    Effect.gen(function* () {
      const mounted = yield* registry()
      // A bound the schema rejects never reaches the handler, so it fails the call rather than
      // returning an outcome: a cell that asks for more than the host allows is told so.
      const refused = yield* Effect.flip(
        mounted.invoke({
          module: "agents",
          operation: "inspectAll",
          input: { childRunIds: ["a"], waitMillis: AgentsBinding.maxWaitMillis + 1 },
        }),
      )
      expect(refused._tag).toBe("@batonfx/repl/HostBindingSchemaFailure")
      if (refused._tag === "@batonfx/repl/HostBindingSchemaFailure") {
        expect(refused.stage).toBe("decode-input")
        expect(refused.message).toContain(String(AgentsBinding.maxWaitMillis))
      }
    }),
  )

  it.effect("journals spawn and cancel across the durable seam and leaves reads alone", () =>
    Effect.gen(function* () {
      const recorder = journal()
      const mounted = yield* mountModules({
        modules: [AgentsBinding.module],
        services: Context.make(AgentPort, AgentPort.of(port())),
        nested: recorder.nested,
      })
      yield* mounted.invoke({ module: "agents", operation: "spawn", input: { profile: "Task", prompt: "p" } })
      yield* mounted.invoke({ module: "agents", operation: "list", input: {} })
      yield* mounted.invoke({ module: "agents", operation: "inspect", input: { childRunId: "a" } })
      yield* mounted.invoke({ module: "agents", operation: "inspectAll", input: { childRunIds: ["a"] } })
      yield* mounted.invoke({ module: "agents", operation: "cancel", input: { childRunId: "a" } })
      yield* mounted.invoke({ module: "agents", operation: "inbox", input: { limit: 10 } })
      yield* mounted.invoke({ module: "agents", operation: "directory", input: {} })
      expect(recorder.kinds).toEqual(["agents.spawn", "agents.cancel"])
      expect(recorder.policies).toEqual(["never", "provider-idempotent"])
    }),
  )

  it.effect("does not double-wrap send, which Baton already journals as a durable operation", () =>
    Effect.gen(function* () {
      const recorder = journal()
      const mounted = yield* mountModules({
        modules: [AgentsBinding.module],
        services: Context.make(AgentPort, AgentPort.of(port())),
        nested: recorder.nested,
      })
      yield* mounted.invoke({ module: "agents", operation: "send", input: { to: "run:a", prompt: "hello" } })
      expect(recorder.kinds).toEqual([])
    }),
  )

  it.effect("returns a directory failure as tagged data the cell can branch on", () =>
    Effect.gen(function* () {
      const mounted = yield* registry(
        port({
          inspect: () =>
            AgentDirectoryUnavailable.make({ reason: "parentage", message: "run does not own this child" }),
        }),
      )
      const response = yield* mounted.invoke({ module: "agents", operation: "inspect", input: { childRunId: "x" } })
      expect(response._tag).toBe("Failure")
      if (response._tag === "Failure")
        expect(response.failure).toMatchObject({ _tag: "AgentDirectoryUnavailable", reason: "parentage" })
    }),
  )
})
