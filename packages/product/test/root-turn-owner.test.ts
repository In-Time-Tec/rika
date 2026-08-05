import { expect, it } from "@effect/vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import type * as ExecutionEvent from "@rika/product/execution-event"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { make } from "../src/thread/queue/root-turn-owner"

const link = { runId: "root-run", threadId: "thread", turnId: "turn" }

const turn: Turn.AgentExecutionTurn = {
  _tag: "AgentExecution",
  id: Turn.TurnId.make("turn"),
  threadId: Thread.ThreadId.make("thread"),
  prompt: "work",
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
  executionLink: link,
  status: "running",
  createdAt: 0,
  updatedAt: 0,
}

const event = (executionId: string, type: string, sequence: number): ExecutionEvent.Event => ({
  executionId,
  ...(executionId === link.runId ? {} : { childExecutionId: executionId }),
  cursor: `cursor-${sequence}`,
  sequence,
  type,
  createdAt: sequence,
})

const watch = (events: ReadonlyArray<ExecutionEvent.Event>) =>
  Effect.gen(function* () {
    const owner = yield* make(
      { get: () => Effect.succeed(turn) } as TurnRepository.Interface,
      { get: () => Effect.void } as TranscriptRepository.Interface,
      {
        watchTurn: () => Stream.fromIterable(events),
      } as ExecutionGateway.Interface,
    )
    return yield* owner.watchTurn(turn.id)
  })

it.effect("keeps root completion when a descendant waits later", () =>
  watch([event(link.runId, "execution.completed", 1), event("child-run", "wait.created", 2)]).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result.status).toBe("completed")
      }),
    ),
  ),
)

it.effect("uses the root cancellation after child cancellation", () =>
  watch([event("child-run", "execution.cancelled", 1), event(link.runId, "execution.cancelled", 2)]).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result.status).toBe("cancelled")
      }),
    ),
  ),
)

it.effect("returns waiting when the root requires operation resolution", () =>
  watch([event(link.runId, "execution.resolution.required", 1)]).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result.status).toBe("waiting")
      }),
    ),
  ),
)

it.effect("persists the execution link before accepting interruption", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const releaseStart = yield* Deferred.make<void>()
    const attached = yield* Deferred.make<void>()
    const owner = yield* make(
      {
        attachExecutionLink: () => Deferred.succeed(attached, undefined),
      } as TurnRepository.Interface,
      {} as TranscriptRepository.Interface,
      {
        startTurn: () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(releaseStart)), Effect.as(link)),
      } as ExecutionGateway.Interface,
    )
    const fiber = yield* Effect.forkChild(
      owner.startTurn({
        threadId: "thread",
        turnId: "turn",
        workspace: "/workspace",
        prompt: "work",
        executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
      }),
    )
    yield* Deferred.await(started)
    const interruption = yield* Effect.forkChild(Fiber.interrupt(fiber))
    yield* Deferred.succeed(releaseStart, undefined)
    yield* Fiber.join(interruption)
    expect(yield* Deferred.isDone(attached)).toBe(true)
  }),
)
