import { expect, it } from "@effect/vitest"

import { Execution, Ids } from "@relayfx/sdk"
import { Effect, Ref } from "effect"

import * as ExecutionBackend from "@rika/product/execution-service"
import { modelRegistrationIdentity } from "@rika/product/execution-route-snapshot"
import { currentExecutionRoute, start } from "./current-execution-route"

import { fixture as testSupport } from "./execution-backend-fixture"
const { selection, relayEvent, makeClient, provideConfiguredBackend, provideBackend, RelayExecutionBackend } =
  testSupport
it.effect.each([
  ["reply", {}],
  ["until", {}],
  ["child", { kind: "child_join" }],
  ["event", { kind: "external" }],
] as const)("does not classify a legal %s wait as approval", ([mode, metadata]) =>
  Effect.gen(function* () {
    const fixture = yield* makeClient({ streamEvents: [relayEvent("execution.completed", 1)] })
    Object.assign(fixture.implementation.executions, {
      inspect: () =>
        Effect.succeed({
          status: "waiting",
          waiting_on: [
            {
              wait_id: Ids.WaitId.make("wait:legal"),
              execution_id: Ids.ExecutionId.make("execution:turn-a"),
              mode,
              state: "open",
              metadata,
              created_at: 1,
            },
          ],
          pending_tool_calls: [],
          child_runs: [],
        }),
    })
    const result = yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      return yield* start(backend, { threadId: "thread-a", turnId: "turn-a", prompt: "prompt" })
    }).pipe(provideBackend(fixture.implementation))

    expect(result.status).toBe("completed")
    expect(yield* Ref.get(fixture.cancellations)).toEqual([])
  }),
)
it.effect.each(["queued", "running"] as const)(
  "waits without cancelling when a %s execution reaches a permission request",
  (startStatus) =>
    Effect.forEach(["permission.ask.requested", "tool.approval.requested"] as const, (actionableType) =>
      Effect.gen(function* () {
        const fixture = yield* makeClient({
          startStatus,
          streamEvents: [
            relayEvent("model.output.delta", 1),
            relayEvent(actionableType, 2, undefined, { wait_id: "wait:actionable" }),
          ],
          openWaitIds: ["wait:actionable"],
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
        expect(result.status).toBe("waiting")
        expect(result.events.map((item) => item.type)).toEqual(["model.output.delta", actionableType])
        expect(seen).toEqual(["model.output.delta", actionableType])
        expect(yield* Ref.get(fixture.cancellations)).toEqual([])
      }),
    ),
)
it.effect.each(["completed", "failed", "cancelled"] as const)(
  "streams terminal executions started with status %s so events arrive incrementally",
  (status) =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({
        startStatus: status,
        streamEvents: [
          relayEvent("model.output.delta", 1),
          relayEvent(`execution.${status}` as Execution.ExecutionEvent["type"], 2),
        ],
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
      expect(result.status).toBe(status)
      expect(result.events.map((value) => value.type)).toEqual(["model.output.delta", `execution.${status}`])
      expect(seen).toEqual(["model.output.delta", `execution.${status}`])
    }),
)
it.effect("uses the pinned current route instead of reselecting at start", () =>
  Effect.gen(function* () {
    const fixture = yield* makeClient({ streamEvents: [relayEvent("execution.completed", 1)] })
    yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      yield* start(backend, {
        threadId: "thread-variant",
        turnId: "turn-variant",
        prompt: "prompt",
        executionRoute: {
          ...currentExecutionRoute(),
          main: {
            ...currentExecutionRoute().main,
            effort: "xhigh",
            fast: true,
            registrationIdentity: modelRegistrationIdentity("effort:xhigh:fast"),
          },
        },
        reasoningEffort: "xhigh",
        fastMode: true,
      })
    }).pipe(provideBackend(fixture.implementation))
    const registered = (yield* Ref.get(fixture.registrations)).at(-1) as
      | { model?: { registration_key?: string } }
      | undefined
    expect(registered?.model?.registration_key).toBe("effort:xhigh:fast")
    expect(RelayExecutionBackend.modelVariantKey("high", false)).toBe("effort:high")
  }),
)
it.effect("retains a fixed model selection when variants are unsupported", () =>
  Effect.gen(function* () {
    const fixture = yield* makeClient({ streamEvents: [relayEvent("execution.completed", 1)] })
    yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      yield* start(backend, {
        threadId: "thread-fixed",
        turnId: "turn-fixed",
        prompt: "prompt",
        reasoningEffort: "xhigh",
        fastMode: true,
      })
    }).pipe(
      provideConfiguredBackend(fixture.implementation, {
        selection,
        modelVariantPolicy: "fixed-selection",
      }),
    )
    const registered = (yield* Ref.get(fixture.registrations)).at(-1) as
      | { model?: { registration_key?: string } }
      | undefined
    expect(registered?.model).toEqual(selection)
    expect(registered?.model?.registration_key).toBeUndefined()
  }),
)
it.effect("registers compaction and unconditional permission rules", () =>
  Effect.gen(function* () {
    const fixture = yield* makeClient({ streamEvents: [relayEvent("execution.completed", 1)] })
    yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      const route = currentExecutionRoute()
      yield* start(backend, {
        threadId: "thread-a",
        turnId: "turn-a",
        prompt: "prompt",
        executionRoute: {
          ...route,
          main: {
            ...route.main,
            compaction: { contextWindow: 10_000, reserveTokens: 500, keepRecentTokens: 2_000 },
          },
        },
      })
    }).pipe(
      provideConfiguredBackend(fixture.implementation, {
        selection,
        compaction: { contextWindow: 10_000, reserveTokens: 500, keepRecentTokens: 2_000 },
      }),
    )
    expect((yield* Ref.get(fixture.registrations))[0]).toMatchObject({
      permission_rules: { rules: [], fallback: "allow" },
      metadata: { steering_enabled: true },
      compaction_policy: {
        context_window: 10_000,
        reserve_tokens: 500,
        keep_recent_tokens: 2_000,
      },
    })
  }),
)
it.effect.each([
  ["execution.completed", "completed"],
  ["execution.failed", "failed"],
  ["execution.cancelled", "cancelled"],
  ["wait.created", "waiting"],
  ["model.output.delta", "running"],
] as const)("derives replay status %s as %s", ([type, status]) =>
  Effect.gen(function* () {
    const fixture = yield* makeClient({ replayEvents: [relayEvent(type, 1)] })
    const results = yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      return [yield* backend.replay("turn-a"), yield* backend.replay("turn-a", "cursor-0")]
    }).pipe(provideBackend(fixture.implementation))
    const replays = yield* Ref.get(fixture.replays)
    expect(results.map((result) => result.status)).toEqual([status, status])
    expect(replays).toEqual([
      { execution_id: "execution:turn-a" },
      { execution_id: "execution:turn-a", after_cursor: "cursor-0" },
    ])
  }),
)
