import * as ThreadSummaryRepository from "@rika/product/thread-summary-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { Clock, Context, Effect } from "effect"
import { operationError } from "../operation-error"
import type { InteractiveEvent } from "../interactive/interactive-runtime-event"
import type { InteractiveDependencyContext } from "../interactive/interactive-session-runtime"

export const makeExecutionLifecycle = (input: {
  readonly dependencyContext: InteractiveDependencyContext
  readonly publishInteractiveActivity: (origin: number, event: InteractiveEvent) => InteractiveEvent
}): Effect.Effect<
  {
    readonly stopActiveExecutionWorkWithProjection: Effect.Effect<
      void,
      TurnRepository.RepositoryError,
      TurnRepository.Service | ExecutionGateway.Service
    >
    readonly notifyThreadSummaries: Effect.Effect<
      void,
      ThreadSummaryRepository.RepositoryError,
      ThreadSummaryRepository.Service
    >
  },
  Error,
  never
> =>
  Effect.gen(function* () {
    const { dependencyContext, publishInteractiveActivity } = input
    const stopActiveExecutionWorkWithProjection = Effect.gen(function* () {
      const turns = yield* TurnRepository.Service
      const backend = yield* ExecutionGateway.Service
      const running = (yield* turns.listNonterminal).filter(
        (turn) => turn.status !== "queued" && turn.executionLink !== undefined,
      )
      for (const turn of running) {
        const outcome = yield* Effect.result(backend.cancelTurn(turn.executionLink!, "Cancelled: server shutdown"))
        if (outcome._tag === "Failure") {
          yield* Effect.logWarning("execution.cancel.failed").pipe(
            Effect.annotateLogs({
              "rika.turn.id": String(turn.id),
              "rika.failure.kind": String(outcome.failure),
            }),
          )
          continue
        }
        yield* turns.setStatus(turn.id, "cancelled", yield* Clock.currentTimeMillis).pipe(
          Effect.catch((error) =>
            Effect.logWarning("execution.cancel.settle.failed").pipe(
              Effect.annotateLogs({
                "rika.turn.id": String(turn.id),
                "rika.failure.kind": String(error),
              }),
            ),
          ),
        )
      }
    }).pipe(Effect.withSpan("ProductOperation.stopActiveExecutionWorkWithProjection"))
    yield* Effect.provideService(
      Context.get(dependencyContext, TurnRepository.Service).resetQueueClaims,
      TurnRepository.Service,
      Context.get(dependencyContext, TurnRepository.Service),
    )
    const notifyThreadSummaries = Effect.gen(function* () {
      const summaries = yield* ThreadSummaryRepository.Service
      publishInteractiveActivity(0, { _tag: "ThreadsListed", threads: yield* summaries.list() })
    })
    return { stopActiveExecutionWorkWithProjection, notifyThreadSummaries }
  }).pipe(Effect.mapError((error) => operationError(String(error), error)))
