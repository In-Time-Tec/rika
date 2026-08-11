import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionStatus from "@rika/product/execution-status"
import * as TurnRepository from "@rika/product/turn-repository"
import * as TurnQueuePromotion from "../repository/turn-repository-queue"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as TranscriptRepository from "@rika/product/transcript-repository"
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
  readonly recoverExecutionAdmissions: Effect.Effect<
    void,
    ExecutionGateway.StartTurnFailure | TurnRepository.RepositoryError
  >
  readonly watchTurn: (
    turnId: Turn.TurnId,
    onChange?: (change: ExecutionProjection.Change) => void,
  ) => Effect.Effect<
    ExecutionProjection.Result,
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
  const admitPrepared = Effect.fn("RootTurnOwner.admitPrepared")(function* (input: ExecutionGateway.StartTurn) {
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
    watchTurn: (turnId, onChange) =>
      Effect.gen(function* () {
        const turn = yield* turns.get(turnId)
        if (turn === undefined || turn._tag !== "AgentExecution" || turn.executionLink === undefined)
          return yield* ExecutionGateway.WatchTurnFailure.make({
            message: `Turn ${turnId} has no persisted execution link`,
          })
        const executionLink = turn.executionLink
        const projection = yield* transcripts.get(turnId)
        let latestChange: ExecutionProjection.Change | undefined
        yield* backend
          .watchTurn(executionLink, {
            prompt: turn.prompt,
            ...(projection === undefined ? {} : { units: projection.units }),
            ...(projection?.projectorCheckpoint === undefined ? {} : { checkpoint: projection.projectorCheckpoint }),
          })
          .pipe(
            Stream.runForEach((change) =>
              Effect.gen(function* () {
                const committed = yield* transcripts.commitProjection(turn, change)
                if (committed === "stale")
                  return yield* TranscriptRepository.RepositoryError.make({
                    message: `Turn ${turnId} projection revision is stale`,
                  })
                latestChange = change
                onChange?.(change)
              }),
            ),
          )
        const stored = yield* transcripts.get(turnId)
        const checkpoint =
          latestChange?._tag === "ProjectionPatch"
            ? latestChange.checkpoint
            : (latestChange?.checkpoint ?? stored?.projectorCheckpoint)
        const fallbackStatus =
          turn.status === "completed" ||
          turn.status === "failed" ||
          turn.status === "cancelled" ||
          turn.status === "waiting" ||
          turn.status === "cancelling"
            ? turn.status
            : "running"
        const state = latestChange?.state ??
          stored?.state ??
          (yield* Effect.option(backend.inspectTurn(executionLink)).pipe(
            Effect.map((inspection) =>
              inspection._tag === "Some" &&
              inspection.value.status !== "unavailable" &&
              inspection.value.status !== "accepted" &&
              inspection.value.status !== "queued"
                ? {
                    status: inspection.value.status,
                    usage: ExecutionProjection.emptyUsageState(),
                    steering: { steeringMessages: 0, followUpMessages: 0 },
                  }
                : undefined,
            ),
            Effect.orElseSucceed(() => undefined),
          )) ?? {
            status: fallbackStatus,
            usage: ExecutionProjection.emptyUsageState(),
            steering: { steeringMessages: 0, followUpMessages: 0 },
          }
        return {
          turnId: String(turnId),
          status: state.status,
          state,
          units: stored?.units ?? [],
          ...(checkpoint === undefined ? {} : { checkpoint }),
        }
      }),
    install: (installed) =>
      Effect.sync(() => {
        lifecycle = installed
      }),
    accepted: launch,
  } satisfies Interface
})
