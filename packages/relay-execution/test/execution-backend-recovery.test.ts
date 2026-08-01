import { expect, it } from "@effect/vitest"

import { Client, Content, Ids } from "@relayfx/sdk"
import { Effect, Fiber, Ref } from "effect"
import { TestClock } from "effect/testing"

import * as ExecutionBackend from "@rika/product/execution-service"

import { start } from "./current-execution-route"

import { fixture as testSupport } from "./execution-backend-fixture"
const { clientFailure, relayEvent, makeClient, provideBackend } = testSupport
it.effect("uses the last Relay terminal event as authority despite stale late events", () =>
  Effect.gen(function* () {
    const fixture = yield* makeClient({
      replayEvents: [
        relayEvent("execution.cancelled", 1),
        relayEvent("model.output.completed", 2),
        relayEvent("execution.failed", 3),
      ],
    })
    const result = yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      return yield* backend.replay("turn-a")
    }).pipe(provideBackend(fixture.implementation))
    expect(result.status).toBe("failed")
  }),
)
it.effect("pages execution events backward without using unbounded replay", () =>
  Effect.gen(function* () {
    const fixture = yield* makeClient({ pageEvents: [relayEvent("model.output.completed", 4)] })
    const result = yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      if (backend.pageEvents === undefined) return yield* Effect.die("Missing event paging")
      return yield* backend.pageEvents("turn-a", "backward", "cursor-5", 200)
    }).pipe(provideBackend(fixture.implementation))
    expect(result).toMatchObject({
      events: [{ sequence: 4, type: "model.output.completed" }],
      hasMore: true,
      oldestCursor: "oldest",
      newestCursor: "newest",
    })
    expect(yield* Ref.get(fixture.pages)).toEqual([
      {
        execution_id: "execution:turn-a",
        direction: "backward",
        before_cursor: "cursor-5",
        limit: 200,
      },
    ])
    expect(yield* Ref.get(fixture.replays)).toEqual([])
  }),
)
it.effect("owns the cancellation payload timestamp and returns the accepted status and replayed events", () =>
  Effect.gen(function* () {
    const fixture = yield* makeClient({
      existingStatus: "running",
      cancelStatus: "queued",
      replayEvents: [relayEvent("execution.cancelled", 1)],
    })
    const result = yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      return yield* backend.cancel("turn-a")
    }).pipe(provideBackend(fixture.implementation))
    expect(yield* Ref.get(fixture.cancellations)).toEqual([{ execution_id: "execution:turn-a", cancelled_at: 0 }])
    expect(result.status).toBe("queued")
    expect(result.events.map((value) => value.type)).toEqual(["execution.cancelled"])
  }),
)
it.effect("cancels nested descendants by their durable execution identifiers", () =>
  Effect.gen(function* () {
    const fixture = yield* makeClient({ existingStatus: "running", cancelStatus: "cancelled" })
    const root = Ids.ExecutionId.make("execution:turn-a")
    const child = Ids.ChildExecutionId.make("execution:turn-a:child:Task:call-child")
    const grandchild = Ids.ChildExecutionId.make("execution:turn-a:child:Task:call-child:child:Task:call-grandchild")
    Object.assign(fixture.implementation.executions, {
      inspect: (id: Ids.ExecutionId) => {
        let childRuns: ReadonlyArray<{ readonly child_execution_id: Ids.ChildExecutionId; readonly status: string }> =
          []
        if (String(id) === String(root)) childRuns = [{ child_execution_id: child, status: "running" }]
        else if (String(id) === String(child)) childRuns = [{ child_execution_id: grandchild, status: "running" }]
        return Effect.succeed({
          execution_id: id,
          status: "running",
          waiting_on: [],
          pending_tool_calls: [],
          child_runs: childRuns,
        })
      },
    })
    yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      yield* backend.cancel("turn-a")
    }).pipe(provideBackend(fixture.implementation))
    expect((yield* Ref.get(fixture.cancellations)).map((input) => input.execution_id)).toEqual([
      root,
      grandchild,
      child,
    ])
  }),
)
it.effect("waits for a concurrently starting execution before cancelling", () =>
  Effect.gen(function* () {
    const fixture = yield* makeClient({
      existingStatus: "running",
      unavailableLookups: 2,
      cancelStatus: "cancelled",
      replayEvents: [relayEvent("execution.cancelled", 1)],
    })
    const cancellation = yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      return yield* backend.cancel("turn-a")
    }).pipe(provideBackend(fixture.implementation), Effect.forkChild)
    yield* TestClock.adjust("50 millis")
    const result = yield* Fiber.join(cancellation)
    expect(yield* Ref.get(fixture.lookups)).toEqual(["execution:turn-a", "execution:turn-a", "execution:turn-a"])
    expect(yield* Ref.get(fixture.cancellations)).toEqual([{ execution_id: "execution:turn-a", cancelled_at: 50 }])
    expect(result.status).toBe("cancelled")
  }),
)
it.effect.each(["replay", "cancel"] as const)("maps %s client failures to BackendError", (operation) =>
  Effect.gen(function* () {
    const fixture = yield* makeClient({
      fail: operation,
      ...(operation === "cancel" ? { existingStatus: "running" as const } : {}),
    })
    const failure = yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      if (operation === "replay") return yield* Effect.flip(backend.replay("turn-a"))
      return yield* Effect.flip(backend.cancel("turn-a"))
    }).pipe(provideBackend(fixture.implementation))
    expect(failure._tag).toBe("ExecutionBackendError")
    expect(failure.message).toContain(`${operation} failed`)
  }),
)
it.effect("fails an unknown start outcome loudly without retrying", () =>
  Effect.gen(function* () {
    const fixture = yield* makeClient({ streamEvents: [relayEvent("execution.completed", 1)] })
    const implementation: Client.Interface = {
      ...fixture.implementation,
      executions: {
        ...fixture.implementation.executions,
        startByAgentDefinition: (input) =>
          Ref.update(fixture.starts, (values) => [...values, input]).pipe(
            Effect.andThen(Effect.fail(clientFailure("start outcome unknown"))),
          ),
        get: () => Effect.sync(() => undefined),
      },
    }
    const outcome = yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      return yield* start(backend, {
        threadId: "thread-a",
        turnId: "turn-a",
        prompt: "prompt",
      })
    }).pipe(provideBackend(implementation), Effect.flip)
    const starts = yield* Ref.get(fixture.starts)
    expect(String(outcome)).toContain("start outcome unknown")
    expect(starts).toHaveLength(1)
    expect(starts[0]).toMatchObject({
      execution_id: "execution:turn-a",
      idempotency_key: "turn-a",
    })
  }),
)
it.effect("keeps waiting when durable acceptance is not visible after fifteen seconds", () =>
  Effect.gen(function* () {
    const fixture = yield* makeClient({ streamEvents: [relayEvent("execution.completed", 1)] })
    const visible = yield* Ref.make(false)
    const implementation: Client.Interface = {
      ...fixture.implementation,
      executions: {
        ...fixture.implementation.executions,
        startByAgentDefinition: () => Effect.never,
        get: () =>
          Ref.get(visible).pipe(
            Effect.map((accepted) =>
              accepted
                ? {
                    id: Ids.ExecutionId.make("execution:turn-a"),
                    root_address_id: Ids.AddressId.make("address:rika"),
                    status: "running" as const,
                    created_at: 1,
                    updated_at: 1,
                  }
                : undefined,
            ),
          ),
      },
    }
    const resultFiber = yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      return yield* start(backend, {
        threadId: "thread-a",
        turnId: "turn-a",
        prompt: "prompt",
      })
    }).pipe(provideBackend(implementation), Effect.forkChild)

    yield* TestClock.adjust("16 seconds")
    expect(resultFiber.pollUnsafe()).toBeUndefined()
    yield* Ref.set(visible, true)
    yield* TestClock.adjust("25 millis")
    expect((yield* Fiber.join(resultFiber)).status).toBe("completed")
  }),
)
it.effect("recovers a canonical terminal execution when start fails after persistence", () =>
  Effect.gen(function* () {
    const fixture = yield* makeClient({
      fail: "start",
      existingStatus: "failed",
      streamEvents: [
        relayEvent("model.output.completed", 1, [Content.text("partial")]),
        relayEvent("execution.failed", 2, [], { message: "canonical failure" }),
        relayEvent("model.output.delta", 3, [Content.text("ignored")]),
      ],
      openWaitIds: ["wait:unrelated"],
    })
    const seen: Array<string> = []
    const result = yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      return yield* start(backend, {
        threadId: "thread-a",
        turnId: "turn-a",
        prompt: "prompt",
        onEvent: (item) => seen.push(item.type),
      })
    }).pipe(provideBackend(fixture.implementation))

    expect(yield* Ref.get(fixture.starts)).toHaveLength(1)
    expect(yield* Ref.get(fixture.lookups)).toEqual(["execution:turn-a"])
    expect(yield* Ref.get(fixture.replays)).toEqual([])
    expect(result.status).toBe("failed")
    expect(result.events.map((item) => item.type)).toEqual(["model.output.completed", "execution.failed"])
    expect(result.events[1]).toMatchObject({ text: "canonical failure", data: { message: "canonical failure" } })
    expect(seen).toEqual(["model.output.completed", "execution.failed"])
  }),
)
it.effect("recovers a canonical terminal execution when streaming fails after completion", () =>
  Effect.gen(function* () {
    const output = relayEvent("model.output.completed", 1, [Content.text("answer")])
    const completed = relayEvent("execution.completed", 2, [], { model_output: "answer" })
    const fixture = yield* makeClient({
      existingStatus: "completed",
      streamEvents: [output],
      streamFailure: "effect/sql/SqlError: Failed to execute statement",
      replayEvents: [output, completed],
    })
    const seen: Array<string> = []
    const result = yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      return yield* start(backend, {
        threadId: "thread-a",
        turnId: "turn-a",
        prompt: "prompt",
        onEvent: (item) => seen.push(item.type),
      })
    }).pipe(provideBackend(fixture.implementation))

    expect(result.status).toBe("completed")
    expect(result.events.map((item) => item.type)).toEqual(["model.output.completed", "execution.completed"])
    expect(seen).toEqual(["model.output.completed", "execution.completed"])
    expect(yield* Ref.get(fixture.lookups)).toEqual([])
    expect(yield* Ref.get(fixture.replays)).toEqual([])
  }),
)
it.effect("preserves the start failure when reconciliation lookup fails", () =>
  Effect.gen(function* () {
    const fixture = yield* makeClient({ fail: "lookup" })
    const implementation: Client.Interface = {
      ...fixture.implementation,
      executions: {
        ...fixture.implementation.executions,
        startByAgentDefinition: () => Effect.fail(clientFailure("start failed")),
      },
    }
    const failure = yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      return yield* Effect.flip(start(backend, { threadId: "thread-a", turnId: "turn-a", prompt: "prompt" }))
    }).pipe(provideBackend(implementation))

    expect(failure.message).toContain("start failed")
    expect(failure.message).not.toContain("lookup failed")
    expect(yield* Ref.get(fixture.lookups)).toEqual(["execution:turn-a"])
  }),
)
it.effect("does not reconcile registration failures", () =>
  Effect.gen(function* () {
    const fixture = yield* makeClient({ fail: "register" })
    const failure = yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      return yield* Effect.flip(start(backend, { threadId: "thread-a", turnId: "turn-a", prompt: "prompt" }))
    }).pipe(provideBackend(fixture.implementation))

    expect(failure.message).toContain("register failed")
    expect(yield* Ref.get(fixture.starts)).toEqual([])
    expect(yield* Ref.get(fixture.lookups)).toEqual([])
  }),
)
