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

  it.live("charges a wait's budget for the time its inspections take, not only for its sleeps", () =>
    Effect.gen(function* () {
      // Each pass reads durable state before it sleeps. Charging the budget only for the sleep lets
      // the wait outlast its ceiling by however long those reads took, which grows with the budget.
      const inspectCostMillis = 30
      const pollIntervalMillis = 50
      const waitMillis = 1_000
      let reads = 0
      const mounted = yield* registry(
        port({
          inspect: (childRunId) =>
            Effect.sleep(`${inspectCostMillis} millis`).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  reads = reads + 1
                  return { childRunId, status: "running" as const }
                }),
              ),
            ),
        }),
      )
      yield* mounted.invoke({
        module: "agents",
        operation: "inspectAll",
        input: { childRunIds: ["a"], waitMillis },
      })
      // Counting inspections is the reading the fix changes: an elapsed-time budget admits about
      // waitMillis / (inspect + interval) of them, where a sleep-only budget admits one per interval
      // regardless of what each read cost.
      const sleepOnlyBudget = Math.ceil(waitMillis / pollIntervalMillis)
      const elapsedBudget = Math.ceil(waitMillis / (inspectCostMillis + pollIntervalMillis))
      expect(reads).toBeLessThan(sleepOnlyBudget)
      expect(reads).toBeLessThanOrEqual(elapsedBudget + 1)
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

  it.effect("clamps a wait longer than the host ceiling rather than refusing the call", () =>
    Effect.gen(function* () {
      // A parent waiting on work that runs for minutes asks for minutes. Refusing taught a model
      // only that its call was malformed, so it fell back to polling; the ceiling still applies.
      const mounted = yield* registry(
        port({ inspect: (childRunId) => Effect.succeed({ childRunId, status: "succeeded" as const }) }),
      )
      const response = yield* mounted.invoke({
        module: "agents",
        operation: "inspectAll",
        input: { childRunIds: ["a"], waitMillis: AgentsBinding.maxWaitMillis * 4 },
      })
      expect(response._tag).toBe("Success")
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
