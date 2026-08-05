import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionStatus from "@rika/product/execution-status"
import * as TurnRepository from "@rika/product/turn-repository"
import * as TurnQueuePromotion from "../repository/turn-repository-queue"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionEvent from "@rika/product/execution-event"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as TranscriptCorrelation from "@rika/transcript/child-parent-correlation"
import { Cause, Clock, Effect, Fiber, Scope, Semaphore, Stream } from "effect"

export interface Lifecycle {
  readonly run: (turnId: Turn.TurnId) => Effect.Effect<void, Error>
}

export interface Interface {
  readonly claim: (
    turnId: Turn.TurnId,
    expectedStatus?: ExecutionStatus.Status,
  ) => Effect.Effect<boolean, TurnRepository.RepositoryError>
  readonly release: (turnId: Turn.TurnId) => Effect.Effect<boolean>
  readonly claimQueued: (
    threadId: Thread.ThreadId,
    now: number,
  ) => Effect.Effect<TurnQueuePromotion.QueueClaim | undefined, TurnRepository.RepositoryError>
  readonly startTurn: (
    input: ExecutionGateway.StartTurn,
  ) => Effect.Effect<ExecutionGateway.ExecutionLink, ExecutionGateway.StartTurnFailure | TurnRepository.RepositoryError>
  readonly watchTurn: (
    turnId: Turn.TurnId,
    onEvent?: (event: ExecutionEvent.Event) => void,
  ) => Effect.Effect<
    ExecutionEvent.Result,
    ExecutionGateway.WatchTurnFailure | TurnRepository.RepositoryError | TranscriptRepository.RepositoryError
  >
  readonly install: (lifecycle: Lifecycle) => Effect.Effect<void>
  readonly accepted: (turnId: Turn.TurnId) => Effect.Effect<void>
}

export const make = Effect.fn("RootTurnOwner.make")(function* (
  turns: TurnRepository.Interface,
  transcripts: TranscriptRepository.Interface,
  backend: ExecutionGateway.Interface,
  scope?: Scope.Scope,
) {
  const admission = yield* Semaphore.make(1)
  const ownerScope = scope ?? (yield* Scope.make())
  const claimed = new Set<string>()
  let lifecycle: Lifecycle | undefined
  const running = new Map<string, Fiber.Fiber<void, Error>>()
  const claim = (turnId: Turn.TurnId, expectedStatus?: ExecutionStatus.Status) =>
    admission.withPermits(1)(
      Effect.gen(function* () {
        const key = String(turnId)
        if (claimed.has(key)) return false
        const current = yield* turns.get(turnId)
        if (
          current === undefined ||
          current.status === "queued" ||
          current.status === "completed" ||
          current.status === "failed" ||
          current.status === "cancelled" ||
          (expectedStatus !== undefined && current.status !== expectedStatus)
        )
          return false
        claimed.add(key)
        return true
      }),
    )
  const release = (turnId: Turn.TurnId) => admission.withPermits(1)(Effect.sync(() => claimed.delete(String(turnId))))
  const launch = (turnId: Turn.TurnId) =>
    admission.withPermits(1)(
      Effect.gen(function* () {
        if (lifecycle === undefined || running.has(String(turnId))) return
        const program = lifecycle.run(turnId).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("root-turn-owner.run.failed").pipe(
                  Effect.annotateLogs({ "rika.turn.id": String(turnId), "rika.failure.message": String(cause) }),
                ),
          ),
          Effect.ensuring(admission.withPermits(1)(Effect.sync(() => running.delete(String(turnId))))),
        )
        const fiber = yield* Effect.forkIn(program, ownerScope)
        running.set(String(turnId), fiber)
      }),
    )
  const claimQueued = (threadId: Thread.ThreadId, now: number) =>
    admission.withPermits(1)(
      Effect.gen(function* () {
        const queueClaim = yield* turns.claimNextQueued(threadId, now)
        if (queueClaim === undefined) return undefined
        const key = String(queueClaim.turn.id)
        if (claimed.has(key)) {
          yield* turns.releaseQueuedClaim(queueClaim)
          return undefined
        }
        claimed.add(key)
        return queueClaim
      }),
    )
  return {
    claim,
    release,
    claimQueued,
    startTurn: (input) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const link = yield* backend.startTurn(input)
          yield* turns.attachExecutionLink(Turn.TurnId.make(input.turnId), link, yield* Clock.currentTimeMillis)
          return link
        }),
      ),
    watchTurn: (turnId, onEvent) =>
      Effect.gen(function* () {
        const turn = yield* turns.get(turnId)
        if (turn === undefined || turn._tag !== "AgentExecution" || turn.executionLink === undefined)
          return yield* ExecutionGateway.WatchTurnFailure.make({
            message: `Turn ${turnId} has no persisted execution link`,
          })
        const executionLink = turn.executionLink
        const projection = yield* transcripts.get(turnId)
        const rootKey = TranscriptCorrelation.executionKey(executionLink.runId)
        const rootCheckpoint = projection?.executionCheckpoints.find(
          (checkpoint) => checkpoint.executionKey === rootKey,
        )
        const cursor =
          rootCheckpoint === undefined || rootCheckpoint.cursor.length === 0 ? undefined : rootCheckpoint.cursor
        const events: Array<ExecutionEvent.Event> = []
        yield* backend.watchTurn(executionLink, cursor).pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              events.push(event)
              onEvent?.(event)
            }),
          ),
        )
        const last = events.at(-1)
        const terminal = events.findLast(
          (event) =>
            event.executionId === executionLink.runId &&
            (event.type === "execution.completed" ||
              event.type === "execution.failed" ||
              event.type === "execution.cancelled" ||
              event.type === "wait.created" ||
              event.type === "execution.resolution.required"),
        )
        let status: ExecutionStatus.Status = "running"
        if (terminal?.type === "execution.completed") status = "completed"
        else if (terminal?.type === "execution.failed") status = "failed"
        else if (terminal?.type === "execution.cancelled") status = "cancelled"
        else if (terminal?.type === "wait.created" || terminal?.type === "execution.resolution.required")
          status = "waiting"
        return {
          turnId: String(turnId),
          status,
          events,
          ...(last === undefined ? {} : { checkpoint: { cursor: last.cursor, sequence: last.sequence } }),
        }
      }),
    install: (installed) =>
      Effect.sync(() => {
        lifecycle = installed
      }),
    accepted: launch,
  } satisfies Interface
})
