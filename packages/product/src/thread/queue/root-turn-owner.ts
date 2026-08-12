import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionStatus from "@rika/product/execution-status"
import * as TurnRepository from "@rika/product/turn-repository"
import * as TurnQueuePromotion from "../repository/turn-repository-queue"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { Clock, Effect, Semaphore } from "effect"

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
  readonly recoverExecutionAdmissions: Effect.Effect<
    void,
    ExecutionGateway.StartTurnFailure | TurnRepository.RepositoryError
  >
  readonly quiesceThread: (threadId: Thread.ThreadId) => Effect.Effect<void, TurnRepository.RepositoryError>
}

export const make = Effect.fn("RootTurnOwner.make")(function* (
  turns: TurnRepository.Interface,
  _transcripts: import("@rika/product/transcript-repository").Interface,
  backend: ExecutionGateway.Interface,
) {
  const admission = yield* Semaphore.make(1)
  const claimed = new Set<string>()
  const claimedThreads = new Map<string, string>()
  const quiesced = new Set<string>()
  const claim = (turnId: Turn.TurnId, expectedStatus?: ExecutionStatus.Status) =>
    admission.withPermits(1)(
      Effect.gen(function* () {
        const key = String(turnId)
        if (claimed.has(key)) return false
        const current = yield* turns.get(turnId)
        if (
          current === undefined ||
          quiesced.has(String(current.threadId)) ||
          current.status === "queued" ||
          current.status === "completed" ||
          current.status === "failed" ||
          current.status === "cancelled" ||
          (expectedStatus !== undefined && current.status !== expectedStatus)
        )
          return false
        claimed.add(key)
        claimedThreads.set(key, String(current.threadId))
        return true
      }),
    )
  const release = (turnId: Turn.TurnId) =>
    admission.withPermits(1)(
      Effect.sync(() => {
        claimedThreads.delete(String(turnId))
        return claimed.delete(String(turnId))
      }),
    )
  const claimQueued = (threadId: Thread.ThreadId, now: number) =>
    admission.withPermits(1)(
      Effect.gen(function* () {
        if (quiesced.has(String(threadId))) return undefined
        const queueClaim = yield* turns.claimNextQueued(threadId, now)
        if (queueClaim === undefined) return undefined
        const key = String(queueClaim.turn.id)
        if (claimed.has(key)) {
          yield* turns.releaseQueuedClaim(queueClaim)
          return undefined
        }
        claimed.add(key)
        claimedThreads.set(key, String(queueClaim.turn.threadId))
        return queueClaim
      }),
    )
  const admitPrepared = Effect.fn("RootTurnOwner.admitPrepared")(function* (input: ExecutionGateway.StartTurn) {
    if (quiesced.has(input.threadId))
      return yield* ExecutionGateway.StartTurnFailure.make({ message: `Thread ${input.threadId} is being deleted` })
    const link = yield* backend.startTurn(input)
    yield* turns.attachExecutionLink(Turn.TurnId.make(input.turnId), link, yield* Clock.currentTimeMillis)
    return link
  })
  return {
    claim,
    release,
    claimQueued,
    startTurn: (input) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const prepared = yield* turns.prepareExecutionAdmission(input, yield* Clock.currentTimeMillis)
          return yield* admitPrepared(prepared)
        }),
      ),
    recoverExecutionAdmissions: Effect.uninterruptible(
      Effect.suspend(() =>
        turns.listUnlinkedExecutionAdmissions.pipe(
          Effect.flatMap((admissions) => Effect.forEach(admissions, admitPrepared, { discard: true })),
        ),
      ),
    ),
    quiesceThread: (threadId) =>
      Effect.gen(function* () {
        const threadTurns = yield* turns.list(threadId)
        yield* admission.withPermits(1)(
          Effect.sync(() => {
            quiesced.add(String(threadId))
            for (const turn of threadTurns) {
              const key = String(turn.id)
              claimed.delete(key)
              claimedThreads.delete(key)
            }
          }),
        )
      }),
  } satisfies Interface
})
