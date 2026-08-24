import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Inspectable, Stream } from "effect"
import { TestClock } from "effect/testing"
import { watch } from "../../../src/execution/projection/watch"

const turn: Turn.AgentExecutionTurn = {
  _tag: "AgentExecution",
  id: Turn.TurnId.make("stalled"),
  threadId: Thread.ThreadId.make("thread"),
  prompt: "work",
  executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
  executionLink: { runId: "run", threadId: "thread", turnId: "stalled" },
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  status: "running",
  createdAt: 1,
  updatedAt: 2,
}

it.effect("uses terminal execution authority after the progress watchdog expires", () =>
  Effect.gen(function* () {
    let units: ReadonlyArray<import("@rika/transcript/transcript-unit").Unit> = []
    let cancelled = false
    const transcripts = {
      get: () => Effect.as(Effect.void, undefined),
      replaceUnits: (_candidate: Turn.Turn, replacement: typeof units) =>
        Effect.sync(() => {
          units = replacement
          return undefined as never
        }),
    } as unknown as TranscriptRepository.Interface
    const backend = {
      watchTurn: () => Stream.never,
      cancelTurn: () =>
        Effect.sync(() => {
          cancelled = true
        }),
      inspectTurn: () =>
        Effect.sync(() =>
          cancelled
            ? ({ status: "completed" as const, cursor: "completed" })
            : ({ status: "running" as const, cursor: "running" }),
        ),
    } as unknown as ExecutionGateway.Interface
    const fiber = yield* Effect.forkChild(
      watch({
        turnId: turn.id,
        turns: { get: () => Effect.succeed(turn) } as unknown as TurnRepository.Interface,
        transcripts,
        backend,
        stallSilenceMs: 1_000,
      }),
    )
    yield* TestClock.adjust("2 seconds")
    const result = yield* Fiber.join(fiber)

    expect(result.status).toBe("completed")
    expect(result.state.status).toBe("completed")
    expect(cancelled).toBe(true)
    expect(units).toHaveLength(1)
    expect(units[0]?.executionOutcome).toMatchObject({
      status: "complete",
      reason: "The durable Execution stopped reporting progress.",
    })
    expect(units[0]?.content).toMatchObject({
      _tag: "Block",
      block: { _tag: "Error", category: "execution-stalled" },
    })
    expect(Inspectable.toStringUnknown(units[0]?.content)).not.toContain("settled this Turn as failed")
    expect(result.state.usage).toEqual(ExecutionProjection.emptyUsageState())
  }),
)

it.effect("does not settle a stalled turn when terminal inspection is unavailable after cancellation", () =>
  Effect.gen(function* () {
    let replacements = 0
    let cancellations = 0
    const started = yield* Deferred.make<void>()
    const fiber = yield* Effect.forkChild(
      watch({
        turnId: turn.id,
        turns: { get: () => Effect.succeed(turn) } as unknown as TurnRepository.Interface,
        transcripts: {
          get: () => Effect.void,
          replaceUnits: () =>
            Effect.sync(() => {
              replacements += 1
              return undefined as never
            }),
        } as unknown as TranscriptRepository.Interface,
        backend: {
          watchTurn: () => Stream.fromEffect(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))),
          cancelTurn: () =>
            Effect.sync(() => {
              cancellations += 1
            }),
          inspectTurn: () =>
            Effect.sync(() =>
              cancellations === 0
                ? ({ status: "running" as const, cursor: "running" })
                : ({ status: "unavailable" as const }),
            ),
        } as unknown as ExecutionGateway.Interface,
        stallSilenceMs: 1_000,
      }),
    )
    yield* Deferred.await(started)
    yield* TestClock.adjust("2 seconds")
    const failure = yield* Effect.flip(Fiber.join(fiber))

    expect(cancellations).toBe(1)
    expect(replacements).toBe(0)
    expect(failure._tag).toBe("WatchTurnFailure")
  }),
)
