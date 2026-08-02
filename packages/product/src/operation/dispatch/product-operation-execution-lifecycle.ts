import * as ThreadRepository from "@rika/product/thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as ThreadSummaryRepository from "@rika/product/thread-summary-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as ThreadActivity from "../../thread/query/thread-activity"
import { Clock, Context, Cause, Effect } from "effect"
import { failureKind, operationError } from "../operation-error"
import { titleInteractiveThread } from "../interactive/thread-title-composition"
import type { InteractiveEvent } from "../interactive/interactive-event"

export const makeExecutionLifecycle = (input: any): Effect.Effect<Readonly<Record<string, unknown>>, Error, never> =>
  Effect.gen(function* () {
    const {
      dependencyContext,
      executionDependencies,
      ensureIngest,
      flushIngest,
      awaitIngestSettled,
      deliverResultEvents,
      withExecutionAdmission,
      commitUsageSource,
      publishThreadUsage,
      usageRepository,
      titleExecutionId,
      publishInteractiveActivity,
    } = input
    const stopActiveExecutionWorkWithProjection = Effect.fn("ProductOperation.stopActiveExecutionWorkWithProjection")(
      function* () {
        const turns = yield* TurnRepository.Service
        const backend = yield* ExecutionBackend.Service
        const running = (yield* turns.listNonterminal).filter((turn) => turn.status !== "queued")
        for (const turn of running) {
          yield* ensureIngest(turn.threadId, turn.id)
          yield* flushIngest(turn.id)
        }
        const requestedAt = yield* Clock.currentTimeMillis
        for (const turn of running) yield* turns.requestStop(turn.id, requestedAt)
        if (running.length > 0)
          yield* Effect.logInfo("execution.stop.requested_for_all").pipe(
            Effect.annotateLogs({ "rika.turn.count": running.length }),
          )
        for (const turn of yield* turns.listStopRequested) {
          const outcome = yield* Effect.result(backend.cancel(turn.id))
          if (outcome._tag === "Failure") {
            yield* Effect.logWarning("execution.stop.settle_cancel_failed").pipe(
              Effect.annotateLogs({
                "rika.turn.id": String(turn.id),
                "rika.failure.kind": String(outcome.failure),
              }),
            )
            continue
          }
          const result = outcome.success
          deliverResultEvents(turn.id, result.events)
          yield* turns.setStatus(
            turn.id,
            result.status,
            result.checkpoint?.cursor ?? ThreadActivity.latestCursor(turn.id, result.events) ?? turn.lastCursor,
            yield* Clock.currentTimeMillis,
          )
          yield* Effect.logInfo("execution.stop.settled").pipe(Effect.annotateLogs({ "rika.turn.id": String(turn.id) }))
          yield* ensureIngest(turn.threadId, turn.id)
          yield* flushIngest(turn.id)
          yield* awaitIngestSettled(turn.id)
        }
      },
    )
    yield* Effect.provideService(
      Context.get(dependencyContext, TurnRepository.Service).resetQueueClaims,
      TurnRepository.Service,
      Context.get(dependencyContext, TurnRepository.Service),
    )
    const notifyThreadSummaries = Effect.gen(function* () {
      const summaries = yield* ThreadSummaryRepository.Service
      publishInteractiveActivity(0, { _tag: "ThreadsListed", threads: yield* summaries.list() })
    })
    const settledTitleExecutions = new Set<string>()
    const titleAttempts = new Map<string, number>()
    const maximumTitleAttempts = 3
    const titleThread = Effect.fn("ProductOperation.titleThread")(function* (
      thread: Thread.Thread,
      firstTurn: Turn.AgentExecutionTurn,
      announce: (event: InteractiveEvent) => void,
    ) {
      const executionId = titleExecutionId(firstTurn.id)
      yield* withExecutionAdmission(
        titleInteractiveThread({
          thread,
          turn: firstTurn,
          backend: yield* ExecutionBackend.Service,
          threads: yield* ThreadRepository.Service,
          usage: usageRepository,
          commitUsage: (id, threadId, turnId, events, terminal) =>
            commitUsageSource(id, threadId, turnId, events, terminal).pipe(Effect.provide(executionDependencies)),
          announce,
          notify: notifyThreadSummaries.pipe(
            Effect.provideService(
              ThreadSummaryRepository.Service,
              Context.get(dependencyContext, ThreadSummaryRepository.Service),
            ),
            Effect.mapError((error) => operationError(String(error), error)),
          ),
          publishUsage: (usage) => publishThreadUsage(usage),
          attempts: titleAttempts,
          settled: settledTitleExecutions,
        }),
      ).pipe(
        Effect.catchCause((cause) => {
          const attempts = (titleAttempts.get(executionId) ?? 0) + 1
          if (attempts >= maximumTitleAttempts) {
            settledTitleExecutions.add(executionId)
            titleAttempts.delete(executionId)
          } else titleAttempts.set(executionId, attempts)
          return Effect.logWarning("thread-title.failed").pipe(
            Effect.annotateLogs({
              "rika.failure.kind": failureKind(cause),
              "rika.failure.cause": Cause.pretty(cause),
              "rika.title.attempts": attempts,
            }),
          )
        }),
      )
    })
    return { stopActiveExecutionWorkWithProjection, notifyThreadSummaries, titleThread }
  }).pipe(Effect.mapError((error) => operationError(String(error), error)))
