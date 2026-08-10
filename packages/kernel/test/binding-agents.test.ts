import { describe, expect, it } from "@effect/vitest"
import { Context, Effect } from "effect"
import * as AgentsBinding from "@rika/kernel/agents-binding"
import { AgentDirectoryUnavailable, AgentPort, type Interface } from "@rika/kernel/agent-port"
import { journal, mountModules } from "./binding-support"

const port = (overrides: Partial<Interface> = {}): Interface => {
  const inspect =
    overrides.inspect ?? ((childRunId: string) => Effect.succeed({ childRunId, status: "running" as const }))
  return {
    spawn: (input) => Effect.succeed({ childRunId: `child-${input.key}`, key: input.key, duplicate: false }),
    list: Effect.succeed([]),
    inspect,
    inspectAll: overrides.inspectAll ?? ((childRunIds) => Effect.forEach(childRunIds, inspect)),
    cancel: () => Effect.void,
    send: () => Effect.succeed({ messageId: "message", duplicate: false }),
    inbox: () => Effect.succeed([]),
    directory: Effect.succeed([]),
    ...overrides,
  }
}

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
      expect(keys).toEqual(["Review#0"])
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
      expect(keys).toEqual(["Review#0"])
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
        output: { childRunId: "child-Task#0", key: "Task#0", duplicate: false },
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

  it.effect("returns a typed bounded child settlement from the durable inbox", () =>
    Effect.gen(function* () {
      const mounted = yield* registry(
        port({
          inbox: () =>
            Effect.succeed([
              {
                _tag: "ChildSettlement",
                notificationId: "child-settled:child-a",
                parentRunId: "parent-a",
                childRunId: "child-a",
                terminalEventId: "event-a",
                status: "succeeded",
                resultText: "bounded result",
                resultBytes: 14,
                resultTruncated: false,
                sequence: 4,
                admittedAtMillis: 12,
              },
            ]),
        }),
      )
      const response = yield* mounted.invoke({
        module: "agents",
        operation: "inbox",
        input: { afterSequence: 3, limit: 10 },
      })
      expect(response).toEqual({
        _tag: "Success",
        output: [
          {
            _tag: "ChildSettlement",
            notificationId: "child-settled:child-a",
            parentRunId: "parent-a",
            childRunId: "child-a",
            terminalEventId: "event-a",
            status: "succeeded",
            resultText: "bounded result",
            resultBytes: 14,
            resultTruncated: false,
            sequence: 4,
            admittedAtMillis: 12,
          },
        ],
      })
    }),
  )

  it.effect("inspectAll accepts more than one fan-out page without an arbitrary child-count cap", () =>
    Effect.gen(function* () {
      const childRunIds = Array.from({ length: 96 }, (_, index) => `child-${index}`)
      const mounted = yield* registry()
      const response = yield* mounted.invoke({
        module: "agents",
        operation: "inspectAll",
        input: { childRunIds },
      })
      expect(response).toEqual({
        _tag: "Success",
        output: childRunIds.map((childRunId) => ({ childRunId, status: "running" })),
      })
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

  it.effect("gives each send from one cell its own identity", () =>
    Effect.gen(function* () {
      // A message is deduplicated by sender, recipient, and key together, so a key that does not
      // move between two sends makes the second a repeat and the recipient never sees it.
      const keys: Array<string> = []
      const mounted = yield* registry(
        port({
          send: (input) => {
            keys.push(input.idempotencyKey)
            return Effect.succeed({ messageId: "m", entryId: "e", duplicate: false })
          },
        }),
      )
      for (const prompt of ["first", "second"])
        yield* mounted.invoke({ module: "agents", operation: "send", input: { to: "run:child", prompt } })
      expect(keys[0]).not.toBe(keys[1])
      expect(keys.every((key) => key.length > 0)).toBe(true)
    }),
  )
})
