import * as Thread from "../../thread/model/record"
import * as ThreadRepository from "../../thread/repository/record"
import * as ThreadResult from "@rika/product/thread-result"
import * as TurnRepository from "../../thread/repository/turn"
import { clampThreadTitle } from "../../thread/query/title-policy"
import { isReviewRouteMode, reviewIntent, reviewRouteMode } from "../review/policy"
import { Cause, Clock, Console, Duration, Effect, Schema } from "effect"
import type * as ExecutionProjection from "../../execution/projection/contract"
import { compareUnitOrder } from "@rika/transcript/transcript-unit-order"
import { turnFailure } from "../failure-message"
import { shouldRetryTurn, turnRetryBudget, turnRetryDelay } from "../retry-policy"
import type {
  AgentExecutionTurn,
  Dependencies,
  NoninteractiveInput,
  PreparedExecutionTurn,
} from "./noninteractive-contract"

// turnFailure lives in failure-policy.ts; see imports above.

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
      const clock = yield* Clock.Clock
      const startedAt = clock.currentTimeMillisUnsafe()
      const streamChanges =
        input._tag === "Run" && input.streamJson ? new Array<ExecutionProjection.Change>() : undefined
      const applyChange = (change: ExecutionProjection.Change) => {
        streamChanges?.push(change)
        dependencies.publishInteractiveActivity(0, {
          _tag: "ExecutionProjectionChanged",
          threadId: turn.threadId,
          turn: { ...turn, status: change.state.status, updatedAt: clock.currentTimeMillisUnsafe() },
          change,
        })
      }
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
        const startBase = {
          threadId: turn.threadId,
          turnId: turn.id,
          workspaceId: thread.workspace,
          prompt: prepared.prompt,
          executionRoute: turn.executionRoute,
        }
        const startWithParts =
          prepared.promptParts === undefined ? startBase : { ...startBase, promptParts: prepared.promptParts }
        const startWithTitle = titleIntent === undefined ? startWithParts : { ...startWithParts, titleIntent }
        const startInput = isReviewRouteMode(turn.executionRoute.mode)
          ? { ...startWithTitle, reviewIntent: reviewIntent(turn.prompt) }
          : startWithTitle
        yield* dependencies.rootTurnOwner.startTurn(startInput)
        return yield* dependencies.rootTurnOwner.watchTurn(turn.id, applyChange)
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const current = yield* turns.get(turn.id)
            if (current?._tag === "AgentExecution" && current.executionLink !== undefined)
              return yield* Effect.failCause(Cause.fail(error))
            const failedAt = yield* Clock.currentTimeMillis
            let failureKind = "object"
            if (error instanceof Error) failureKind = error.name
            else if (Schema.is(Schema.String)(error)) failureKind = "string"
            yield* Effect.logError("turn.failed").pipe(
              Effect.annotateLogs({
                "rika.duration.ms": failedAt - startedAt,
                "rika.failure.kind": failureKind,
                "rika.thread.id": String(thread.id),
                "rika.turn.id": String(turn.id),
              }),
            )
            yield* dependencies.setTurnStatus(turn.id, "failed", failedAt)
            return yield* Effect.failCause(Cause.fail(error))
          }),
        ),
      )
      const result = execution
      const completedAt = yield* Clock.currentTimeMillis
      const settledFailure = turnFailure(result.units)
      const failureLog =
        settledFailure === undefined
          ? Effect.logError("turn.failed").pipe(
              Effect.annotateLogs({
                "rika.duration.ms": completedAt - startedAt,
                "rika.failure.kind": "OperationError",
                "rika.thread.id": String(thread.id),
                "rika.turn.id": String(turn.id),
                "rika.turn.status": result.status,
              }),
            )
          : Effect.logError("turn.failed").pipe(
              Effect.annotateLogs({
                "rika.duration.ms": completedAt - startedAt,
                "rika.failure.kind": "OperationError",
                "rika.failure.message": settledFailure,
                "rika.thread.id": String(thread.id),
                "rika.turn.id": String(turn.id),
                "rika.turn.status": result.status,
              }),
            )
      yield* result.status === "failed"
        ? failureLog
        : Effect.logInfo("turn.finished").pipe(
            Effect.annotateLogs({
              "rika.duration.ms": completedAt - startedAt,
              "rika.thread.id": String(thread.id),
              "rika.turn.id": String(turn.id),
              "rika.turn.status": result.status,
            }),
          )
      yield* dependencies.setTurnStatus(turn.id, result.status, completedAt)
      return { result, streamChanges, units: result.units }
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
    const resolvedExecutionRoute = yield* dependencies.resolveExecutionRoute(input.mode, undefined, thread.workspace)
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
    const runTurnWithRetry = Effect.fn("ProductOperation.runTurnWithRetry")(function* () {
      let attempt = 0
      let current = submitted
      let last = yield* runTurn(current).pipe(Effect.ensuring(dependencies.releaseTurnObserver(current.id)))
      while (true) {
        attempt += 1
        if (last.result.status !== "failed") return last
        const failure = turnFailure(last.units)
        const retryable = failure?.retryable ?? false
        if (!shouldRetryTurn({ retryable, retry: retryable ? "automatic" : "none", attempt })) return last
        const delay = turnRetryDelay({ attempt })
        const retryTurnId = yield* dependencies.makeTurnId
        dependencies.publishInteractiveActivity(0, {
          _tag: "TurnRetryScheduled",
          selectionEpoch: 0,
          threadId: thread.id,
          turnId: current.id,
          retryTurnId,
          attempt,
          budget: turnRetryBudget,
          message: failure?.message ?? "Execution failed",
          nextAt: (yield* Clock.currentTimeMillis) + Duration.toMillis(delay),
        })
        yield* Effect.sleep(delay)
        const retryBase = {
          id: retryTurnId,
          threadId: thread.id,
          prompt: current.prompt,
          executionRoute: current.executionRoute,
          queueCapacity: dependencies.pendingTurnCapacity,
          now: yield* Clock.currentTimeMillis,
        }
        const retrySubmission =
          current.promptParts === undefined ? retryBase : { ...retryBase, promptParts: current.promptParts }
        const retried = yield* dependencies.createObservedSubmission(turns, retrySubmission)
        const retryTurn = retried.turn
        if (retryTurn.status === "queued") return last
        if (!retried.claimed) return last
        if (!ThreadResult.TurnResult.isAgentExecution(retryTurn)) return last
        yield* dependencies.ensureTurnSummary(retryTurn)
        current = retryTurn
        last = yield* runTurn(current).pipe(Effect.ensuring(dependencies.releaseTurnObserver(current.id)))
      }
    })
    const completed = yield* runTurnWithRetry()
    yield* drainRunQueue()
    if (input._tag === "Run" && input.streamJson) {
      yield* Effect.forEach(completed.streamChanges ?? [], (change) => Console.log(JSON.stringify(change)), {
        discard: true,
      })
      return
    }
    const ordered = completed.units.toSorted((left, right) => compareUnitOrder(left.order, right.order))
    const text = ordered
      .filter((unit) => unit.content._tag === "Entry" && unit.content.role === "assistant")
      .map((unit) => (unit.content._tag === "Entry" ? unit.content.text : ""))
      .join("")
    if (text.length > 0) yield* Console.log(text)
    if (completed.result.status === "cancelled")
      return yield* dependencies.operationError(`Turn ${submitted.id} was cancelled before it completed`)
    if (completed.result.status === "failed") {
      const failure = turnFailure(ordered)
      return yield* dependencies.operationError(
        failure === undefined ? `Turn ${submitted.id} failed` : `Turn ${submitted.id} failed: ${failure.message}`,
      )
    }
    if (completed.result.status === "completed" && text.length === 0)
      return yield* dependencies.operationError(`Turn ${submitted.id} completed without output`)
  })
  yield* program.pipe(
    Effect.provide(dependencies.executionDependencies),
    Effect.scoped,
    Effect.mapError((error) => dependencies.unavailable(input, String(error))),
  )
})
