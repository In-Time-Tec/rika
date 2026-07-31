import { Clock, Effect } from "effect"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import * as ThreadActivity from "../../thread/query/thread-activity"
import { queuedTurnPromoteMaxAgeMs, staleQueuedTurnsError } from "../../thread/queue/pending-turn-policy"
import type * as RootTurnOwner from "../../thread/queue/root-turn-owner"
import type { InteractiveEvent } from "./interactive-event"

export const promotePendingTurns = (input: {
  readonly thread: Thread.Thread
  readonly dispatch: (event: InteractiveEvent) => void
  readonly turns: TurnRepository.Interface
  readonly backend: ExecutionBackend.Interface
  readonly pendingCapacity: number
  readonly prepareExecution: (
    turn: Turn.AgentExecutionTurn,
    workspace: string,
    persist?: boolean,
  ) => Effect.Effect<any, any, any>
  readonly ensureIngest: (threadId: Thread.ThreadId, turnId: Turn.TurnId) => Effect.Effect<any, any, any>
  readonly owner: RootTurnOwner.Interface
  readonly notifyThreadSummaries: Effect.Effect<any, any, any>
  readonly notifyTurnChanged: (turn: Pick<Turn.Turn, "id" | "threadId">) => Effect.Effect<any, any, any>
  readonly setTurnStatus: (
    id: Turn.TurnId,
    status: Turn.Status,
    cursor: string | undefined,
    now: number,
  ) => Effect.Effect<any, any, any>
  readonly projectExecutionResult: (
    threadId: Thread.ThreadId,
    result: ExecutionBackend.Result,
  ) => Effect.Effect<any, any, any>
  readonly deliverResultEvents: (
    turnId: Turn.TurnId,
    events: ReadonlyArray<ExecutionBackend.Event>,
    delivered?: ReadonlySet<string>,
  ) => void
  readonly queueMutationEvent: (change: TurnRepository.QueueItemChange) => InteractiveEvent
  readonly claimQueuedTurn: (
    threadId: Thread.ThreadId,
    now: number,
  ) => Effect.Effect<TurnRepository.QueueClaim | undefined, any, any>
  readonly releaseTurnObserver: (turnId: Turn.TurnId) => Effect.Effect<any, any, any>
  readonly awaitSessionQuiescence: (
    backend: ExecutionBackend.Interface,
    threadId: Thread.ThreadId,
  ) => Effect.Effect<Turn.Turn | undefined, any, any>
  readonly emit: (dispatch: (event: InteractiveEvent) => void, event: InteractiveEvent) => void
  readonly failureMessage: string
}) =>
  Effect.gen(function* () {
    let staleRefused = false
    let claimed = 0
    const refuseStaleQueued = Effect.gen(function* () {
      const queue = yield* input.turns.readQueue(input.thread.id)
      const now = yield* Clock.currentTimeMillis
      const staleError = staleQueuedTurnsError(input.thread.id, queue.turns, now, queuedTurnPromoteMaxAgeMs)
      if (staleError === undefined) return false
      staleRefused = true
      input.emit(input.dispatch, {
        _tag: "ExecutionFailed",
        selectionEpoch: 0,
        threadId: input.thread.id,
        message: staleError.message,
      })
      return yield* Effect.fail(staleError)
    })
    const runPromoted = (claim: TurnRepository.QueueClaim) =>
      Effect.gen(function* () {
        const promoted = claim.turn
        const delivered = new Set<string>()
        const outcome = yield* Effect.gen(function* () {
          const prepared = yield* input.prepareExecution(promoted, input.thread.workspace, false)
          if (prepared.messages.length > 0)
            input.emit(input.dispatch, {
              _tag: "ContextDiagnostics",
              selectionEpoch: 0,
              threadId: input.thread.id,
              turnId: promoted.id,
              messages: prepared.messages,
            })
          const transition = yield* input.turns.finishQueuedClaim(
            claim,
            "running",
            promoted.lastCursor,
            prepared.extensionPin,
            yield* Clock.currentTimeMillis,
          )
          if (transition._tag === "Unavailable") return undefined
          yield* input.notifyThreadSummaries
          yield* input.notifyTurnChanged(transition.turn)
          input.emit(input.dispatch, input.queueMutationEvent(transition.queue))
          if (transition.turn.status !== "running") return undefined
          input.emit(input.dispatch, {
            _tag: "TurnStarted",
            selectionEpoch: 0,
            threadId: input.thread.id,
            turn: transition.turn,
          })
          yield* input.ensureIngest(input.thread.id, promoted.id)
          return yield* input.owner.start({
            threadId: input.thread.id,
            turnId: promoted.id,
            prompt: prepared.prompt,
            ...(prepared.promptParts === undefined ? {} : { promptParts: prepared.promptParts }),
            executionRoute: promoted.executionRoute,
            eventScope: "execution",
            onEvent: (event) => {
              delivered.add(event.cursor)
              input.deliverResultEvents(promoted.id, [event])
            },
            ...(prepared.extensionPin === undefined ? {} : { extensionPin: prepared.extensionPin }),
          })
        }).pipe(
          Effect.map((value) => ({ _tag: "Success" as const, value })),
          Effect.catch((error) => Effect.succeed({ _tag: "Failure" as const, error })),
          Effect.onInterrupt(() => input.turns.releaseQueuedClaim(claim)),
        )
        if (outcome._tag === "Failure") {
          const current = yield* input.turns.get(promoted.id)
          if (current?.status === "running")
            yield* input.setTurnStatus(promoted.id, "failed", promoted.lastCursor, yield* Clock.currentTimeMillis)
          else {
            const transition = yield* input.turns.finishQueuedClaim(
              claim,
              "failed",
              promoted.lastCursor,
              promoted.extensionPin,
              yield* Clock.currentTimeMillis,
            )
            if (transition._tag === "Unavailable") return true
            yield* input.notifyThreadSummaries
            yield* input.notifyTurnChanged(transition.turn)
            input.emit(input.dispatch, input.queueMutationEvent(transition.queue))
          }
          input.emit(input.dispatch, {
            _tag: "ExecutionFailed",
            selectionEpoch: 0,
            threadId: input.thread.id,
            turnId: promoted.id,
            message: input.failureMessage,
          })
          return true
        }
        const result = outcome.value
        if (result === undefined) return true
        input.deliverResultEvents(promoted.id, result.events, delivered)
        const updated = yield* input.setTurnStatus(
          promoted.id,
          result.status,
          result.checkpoint?.cursor ?? ThreadActivity.latestCursor(promoted.id, result.events) ?? promoted.lastCursor,
          yield* Clock.currentTimeMillis,
        )
        yield* input.projectExecutionResult(input.thread.id, result)
        yield* input.ensureIngest(updated.threadId, updated.id)
        return result.status !== "failed" && ["completed", "cancelled"].includes(result.status)
      })
    while (true) {
      if (staleRefused || (yield* input.turns.readQueue(input.thread.id)).queuedCount === 0) break
      if ((yield* refuseStaleQueued.pipe(Effect.catchTag("StaleQueuedTurns", () => Effect.succeed(true)))) === true)
        break
      if ((yield* input.awaitSessionQuiescence(input.backend, input.thread.id)) !== undefined) {
        const wake = yield* input.turns.requestQueueWake(input.thread.id)
        if (wake !== undefined && input.backend.wakeThreadHost !== undefined)
          yield* input.backend.wakeThreadHost({ ...wake, now: yield* Clock.currentTimeMillis })
        break
      }
      const claim = yield* input.claimQueuedTurn(input.thread.id, yield* Clock.currentTimeMillis)
      if (claim === undefined) break
      claimed += 1
      const keepDraining = yield* Effect.uninterruptible(runPromoted(claim)).pipe(
        Effect.ensuring(input.releaseTurnObserver(claim.turn.id) as Effect.Effect<void, never, any>),
      )
      if (!keepDraining) break
    }
    return claimed
  })
