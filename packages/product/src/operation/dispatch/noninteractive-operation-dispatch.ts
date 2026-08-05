import * as Thread from "../../thread/model/thread-record"
import * as ThreadRepository from "../../thread/repository/thread-repository"
import * as ThreadResult from "@rika/product/thread-result"
import * as TurnRepository from "../../thread/repository/turn-repository"
import { clampThreadTitle } from "../../thread/query/thread-title-policy"
import { agentResponseArrived } from "../interactive/interactive-session-interface-support"
import { isReviewRouteMode, reviewIntent, reviewRouteMode } from "../review/review-policy"
import { Cause, Clock, Console, Effect } from "effect"
import type {
  AgentExecutionTurn,
  Dependencies,
  NoninteractiveInput,
  PreparedExecutionTurn,
} from "./noninteractive-operation-contract"

export const run = Effect.fn("NoninteractiveOperation.run")(function* (
  input: NoninteractiveInput,
  dependencies: Dependencies,
) {
  const program = Effect.gen(function* () {
    const threads = yield* ThreadRepository.Service
    const turns = yield* TurnRepository.Service
    const now = yield* Clock.currentTimeMillis
    const thread =
      input.threadId === undefined
        ? yield* threads.create({
            id: yield* dependencies.makeThreadId,
            workspace: input.workspace ?? dependencies.defaultWorkspace,
            title: clampThreadTitle(input.prompt.join(" ")) || "New thread",
            now,
          })
        : yield* threads
            .get(Thread.ThreadId.make(input.threadId))
            .pipe(
              Effect.flatMap((existingThread) =>
                existingThread === undefined
                  ? dependencies.operationError(`Thread ${input.threadId} does not exist`)
                  : Effect.succeed(existingThread),
              ),
            )
    const runTurn = Effect.fn("ProductOperation.runTurn")(function* (
      turn: AgentExecutionTurn,
      preparedInput?: PreparedExecutionTurn,
    ) {
      const startedAt = yield* Clock.currentTimeMillis
      const deliveredCursors = new Set<string>()
      yield* Effect.logInfo("turn.started").pipe(
        Effect.annotateLogs({
          "rika.thread.id": String(thread.id),
          "rika.turn.id": String(turn.id),
        }),
      )
      const execution = yield* Effect.gen(function* () {
        const prepared = preparedInput ?? (yield* dependencies.prepareExecution(turn, thread.workspace))
        const runningTurn = yield* dependencies.setTurnStatus(turn.id, "running", startedAt)
        dependencies.publishInteractiveActivity(0, {
          _tag: "TurnStarted",
          selectionEpoch: 0,
          activitySequence: 0,
          threadId: thread.id,
          turn: runningTurn,
        })
        const titleIntent =
          (yield* turns.list(thread.id)).length === 1 &&
          thread.title === (clampThreadTitle(turn.prompt) || "New thread")
            ? ({ _tag: "GenerateThreadTitle", expectedTitle: thread.title } as const)
            : undefined
        yield* dependencies.rootTurnOwner.startTurn({
          threadId: turn.threadId,
          turnId: turn.id,
          workspace: thread.workspace,
          prompt: prepared.prompt,
          executionRoute: turn.executionRoute,
          ...(prepared.promptParts === undefined ? {} : { promptParts: prepared.promptParts }),
          ...(titleIntent === undefined ? {} : { titleIntent }),
          ...(isReviewRouteMode(turn.executionRoute.mode) ? { reviewIntent: reviewIntent(turn.prompt) } : {}),
        })
        yield* dependencies.ensureIngest(turn.threadId, turn.id)
        const result = yield* dependencies.rootTurnOwner.watchTurn(turn.id, (event) => {
          deliveredCursors.add(event.cursor)
          dependencies.executionIngest.deliver(turn.id, event)
        })
        return { result, followed: false }
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const failedAt = yield* Clock.currentTimeMillis
            yield* Effect.logError("turn.failed").pipe(
              Effect.annotateLogs({
                "rika.duration.ms": failedAt - startedAt,
                "rika.failure.kind": error instanceof Error ? error.name : typeof error,
                "rika.thread.id": String(thread.id),
                "rika.turn.id": String(turn.id),
              }),
            )
            yield* dependencies.setTurnStatus(turn.id, "failed", failedAt)
            return yield* Effect.failCause(Cause.fail(error))
          }),
        ),
      )
      const { result, followed } = execution
      const completedAt = yield* Clock.currentTimeMillis
      yield* Effect.logInfo("turn.finished").pipe(
        Effect.annotateLogs({
          "rika.duration.ms": completedAt - startedAt,
          "rika.thread.id": String(thread.id),
          "rika.turn.id": String(turn.id),
          "rika.turn.status": result.status,
        }),
      )
      if (!followed) {
        dependencies.deliverResultEvents(turn.id, result.events, deliveredCursors)
        const updated = yield* dependencies.setTurnStatus(
          turn.id,
          result.status,
          completedAt,
          result.status === "cancelled" ? agentResponseArrived(result.events) : undefined,
        )
        yield* dependencies.projectExecutionResult(thread.id, result)
        yield* dependencies.ensureIngest(updated.threadId, updated.id)
        yield* dependencies.awaitIngestSettled(updated.id)
      }
      return result
    })
    const drainRunQueue = Effect.fn("ProductOperation.drainRunQueue")(function* () {
      while (true) {
        const queue = yield* turns.readQueue(thread.id)
        if (queue.queuedCount === 0) return
        const staleError = dependencies.staleQueuedTurnsError(
          thread.id,
          queue.turns,
          yield* Clock.currentTimeMillis,
          dependencies.queuedTurnPromoteMaxAgeMs,
        )
        if (staleError !== undefined) return yield* staleError
        const promoted = yield* dependencies.claimQueuedTurn(thread.id, yield* Clock.currentTimeMillis)
        if (promoted === undefined) return
        const prepared = yield* dependencies.prepareExecution(promoted.turn, thread.workspace).pipe(
          Effect.map((value) => ({ _tag: "Success" as const, value })),
          Effect.catch((error) => Effect.succeed({ _tag: "Failure" as const, error })),
          Effect.onInterrupt(() =>
            turns.releaseQueuedClaim(promoted).pipe(Effect.andThen(dependencies.releaseTurnObserver(promoted.turn.id))),
          ),
        )
        if (prepared._tag === "Failure") {
          const transition = yield* turns.finishQueuedClaim(promoted, "failed", yield* Clock.currentTimeMillis)
          if (transition._tag === "Transitioned") {
            dependencies.publishInteractiveActivity(0, dependencies.queueMutationEvent(transition.queue))
          }
          yield* dependencies.releaseTurnObserver(promoted.turn.id)
          continue
        }
        const transition = yield* turns.finishQueuedClaim(promoted, "running", yield* Clock.currentTimeMillis)
        if (transition._tag === "Unavailable") {
          yield* dependencies.releaseTurnObserver(promoted.turn.id)
          continue
        }
        dependencies.publishInteractiveActivity(0, dependencies.queueMutationEvent(transition.queue))
        yield* runTurn(transition.turn, prepared.value).pipe(
          Effect.ensuring(dependencies.releaseTurnObserver(transition.turn.id)),
        )
      }
    })
    yield* drainRunQueue()
    const turnId = yield* dependencies.makeTurnId
    const prompt = input.prompt.join(" ")
    const resolvedExecutionRoute = yield* dependencies.resolveExecutionRoute(
      input.mode ?? "medium",
      undefined,
      thread.workspace,
    )
    const observed = yield* dependencies.createObservedSubmission(turns, {
      id: turnId,
      threadId: thread.id,
      prompt,
      executionRoute:
        input._tag === "Review"
          ? { ...resolvedExecutionRoute, mode: reviewRouteMode(resolvedExecutionRoute.mode) }
          : resolvedExecutionRoute,
      queueCapacity: dependencies.pendingTurnCapacity,
      now,
    })
    const submitted = observed.turn
    yield* dependencies.ensureTurnSummary(submitted)
    yield* Effect.logInfo("turn.accepted").pipe(
      Effect.annotateLogs({
        "rika.thread.id": String(thread.id),
        "rika.turn.id": String(submitted.id),
        "rika.turn.status": submitted.status,
      }),
    )
    if (submitted.status === "queued") return
    if (!observed.claimed)
      return yield* dependencies.operationError(`Turn ${submitted.id} already has an execution observer`)
    if (!ThreadResult.TurnResult.isAgentExecution(submitted))
      return yield* dependencies.operationError(`Turn ${submitted.id} is not an executable turn`)
    const result = yield* runTurn(submitted).pipe(Effect.ensuring(dependencies.releaseTurnObserver(submitted.id)))
    yield* drainRunQueue()
    if (input._tag === "Run" && input.streamJson) {
      yield* Effect.forEach(result.events, (event) => Console.log(JSON.stringify(event)), { discard: true })
      return
    }
    const text = result.events
      .filter((event) => event.type === "model.output.completed")
      .map((event) => event.text ?? "")
      .join("")
    if (text.length > 0) yield* Console.log(text)
    if (result.status === "cancelled")
      return yield* dependencies.operationError(`Turn ${submitted.id} was cancelled before it completed`)
    if (result.status === "failed") {
      const failure = result.events.findLast((event) => event.type === "execution.failed")?.text
      return yield* dependencies.operationError(
        failure === undefined ? `Turn ${submitted.id} failed` : `Turn ${submitted.id} failed: ${failure}`,
      )
    }
    if (result.status === "completed" && text.length === 0)
      return yield* dependencies.operationError(`Turn ${submitted.id} completed without output`)
  })
  yield* program.pipe(
    Effect.provide(dependencies.executionDependencies),
    Effect.scoped,
    Effect.mapError((error) => dependencies.unavailable(input, String(error))),
  )
})
