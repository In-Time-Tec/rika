import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionStatus from "@rika/product/execution-status"
import * as TurnRepository from "@rika/product/turn-repository"
import type * as TurnRepositorySteering from "@rika/product/turn-repository-steering"
import * as TurnQueuePromotion from "../repository/turn-queue"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as ExecutionProjectionWatch from "../../execution/projection/watch"
import { Cause, Clock, Effect, Fiber, Schema, Scope, Semaphore } from "effect"

export interface Lifecycle {
  readonly run: (turnId: Turn.TurnId) => Effect.Effect<void, Error>
}

export interface SteeringAdmissionRejection {
  readonly admission: TurnRepositorySteering.SteeringAdmission
  readonly queue?: TurnQueuePromotion.QueueItemChange
  readonly failure: ExecutionGateway.SteeringFailure
  readonly notify: boolean
}

export interface SteeringAdmissionCompletion {
  readonly admission: TurnRepositorySteering.SteeringAdmission
  readonly receipt: ExecutionGateway.SteeringReceipt
  readonly notify: boolean
  readonly queue?: TurnQueuePromotion.QueueItemChange
}

export interface SteeringAdmissionRecovery {
  readonly rejected: ReadonlyArray<SteeringAdmissionRejection>
  readonly completed: ReadonlyArray<SteeringAdmissionCompletion>
  readonly pending: boolean
}

type SteeringAdmissionOutcome =
  | {
      readonly _tag: "Rejected"
      readonly admission: TurnRepositorySteering.SteeringAdmission
      readonly queue?: TurnQueuePromotion.QueueItemChange
      readonly failure: ExecutionGateway.SteeringFailure
      readonly notify: boolean
    }
  | { readonly _tag: "Pending" }
  | {
      readonly _tag: "Completed"
      readonly admission: TurnRepositorySteering.SteeringAdmission
      readonly receipt: ExecutionGateway.SteeringReceipt
      readonly queue?: TurnQueuePromotion.QueueItemChange
      readonly notify: boolean
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
  readonly recoverExecutionAdmissions: Effect.Effect<void, TurnRepository.RepositoryError>
  readonly prepareSteering: (
    target: ExecutionGateway.ExecutionLink,
    input: ExecutionGateway.SteeringInput,
  ) => Effect.Effect<
    TurnRepositorySteering.SteeringAdmission,
    TurnRepository.RepositoryError | TranscriptRepository.RepositoryError
  >
  readonly prepareQueuedSteering: (
    source: Turn.TurnId,
    target: ExecutionGateway.ExecutionLink,
    input: ExecutionGateway.SteeringInput,
  ) => Effect.Effect<
    TurnRepositorySteering.QueuedSteeringAdmissionPreparation,
    TurnRepository.RepositoryError | TurnRepository.QueuedTurnUnavailable | TranscriptRepository.RepositoryError
  >
  readonly recoverSteeringAdmissions: Effect.Effect<
    SteeringAdmissionRecovery,
    TurnRepository.RepositoryError | TranscriptRepository.RepositoryError
  >
  readonly acknowledgeSteeringRejection: (requestId: string) => Effect.Effect<boolean, TurnRepository.RepositoryError>
  readonly watchTurn: (
    turnId: Turn.TurnId,
    onChange?: (change: ExecutionProjection.Change) => void,
    onPreview?: (preview: ExecutionGateway.ModelPreviewEvent) => void,
  ) => Effect.Effect<
    ExecutionProjection.Result,
    ExecutionGateway.WatchTurnFailure | TurnRepository.RepositoryError | TranscriptRepository.RepositoryError
  >
  readonly install: (lifecycle: Lifecycle) => Effect.Effect<void>
  readonly accepted: (turnId: Turn.TurnId) => Effect.Effect<void>
  readonly quiesceThread: (threadId: Thread.ThreadId) => Effect.Effect<void, TurnRepository.RepositoryError>
}

export const make = Effect.fn("RootTurnOwner.make")(function* (
  turns: TurnRepository.Interface,
  transcripts: TranscriptRepository.Interface,
  backend: ExecutionGateway.Interface,
  scope?: Scope.Scope,
) {
  const ownerAdmission = yield* Semaphore.make(1)
  const ownerScope = scope ?? (yield* Scope.make())
  const claimed = new Set<string>()
  const reobserve = new Set<string>()
  const claimedThreads = new Map<string, string>()
  const quiesced = new Set<string>()
  const quiescedTurns = new Set<string>()
  let lifecycle: Lifecycle | undefined
  const running = new Map<string, Fiber.Fiber<void, Error>>()
  const relaunch = new Set<string>()
  const claim = (turnId: Turn.TurnId, expectedStatus?: ExecutionStatus.Status) =>
    ownerAdmission.withPermits(1)(
      Effect.gen(function* () {
        const key = String(turnId)
        if (claimed.has(key)) {
          reobserve.add(key)
          return false
        }
        const current = yield* turns.get(turnId)
        if (
          current === undefined ||
          quiesced.has(String(current.threadId)) ||
          current.status === "queued" ||
          (ExecutionStatus.isTerminalStatus(current.status) && expectedStatus === undefined) ||
          (expectedStatus !== undefined && current.status !== expectedStatus)
        )
          return false
        claimed.add(key)
        claimedThreads.set(key, String(current.threadId))
        return true
      }),
    )
  const release = (turnId: Turn.TurnId) =>
    ownerAdmission.withPermits(1)(
      Effect.sync(() => {
        const key = String(turnId)
        claimedThreads.delete(key)
        claimed.delete(key)
        return reobserve.delete(key)
      }),
    )
  const launch = (turnId: Turn.TurnId): Effect.Effect<void> =>
    ownerAdmission.withPermits(1)(
      Effect.gen(function* () {
        const key = String(turnId)
        if (lifecycle === undefined) return
        if (running.has(key)) {
          relaunch.add(key)
          return
        }
        if (quiescedTurns.has(String(turnId)) || quiesced.has(claimedThreads.get(String(turnId)) ?? "")) return
        const program = lifecycle.run(turnId).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("root-turn-owner.run.failed").pipe(
                  Effect.annotateLogs({ "rika.turn.id": String(turnId), "rika.failure.message": String(cause) }),
                ),
          ),
          Effect.ensuring(
            ownerAdmission
              .withPermits(1)(
                Effect.sync(() => {
                  running.delete(key)
                  return relaunch.delete(key)
                }),
              )
              .pipe(Effect.flatMap((requested) => (requested ? launch(turnId) : Effect.void))),
          ),
        )
        const fiber = yield* Effect.forkIn(program, ownerScope)
        running.set(key, fiber)
      }),
    )
  const claimQueued = (threadId: Thread.ThreadId, now: number) =>
    ownerAdmission.withPermits(1)(
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
    const turn = yield* turns.attachExecutionLink(Turn.TurnId.make(input.turnId), link, yield* Clock.currentTimeMillis)
    if (turn.status === "cancelled")
      yield* backend
        .cancelTurn(link, "Cancelled before execution link attached")
        .pipe(Effect.mapError((failure) => ExecutionGateway.StartTurnFailure.make({ message: failure.message })))
    return link
  })
  const recoverPrepared = (input: ExecutionGateway.StartTurn, attempts = 4, delay = 100): Effect.Effect<void, never> =>
    admitPrepared(input).pipe(
      Effect.asVoid,
      Effect.catch((error) =>
        attempts > 1
          ? Effect.sleep(delay).pipe(Effect.andThen(recoverPrepared(input, attempts - 1, delay * 2)))
          : Effect.logWarning("turn.execution-admission.recovery.failed").pipe(
              Effect.annotateLogs({
                "rika.thread.id": input.threadId,
                "rika.turn.id": input.turnId,
                "rika.failure.kind": error.name,
                "rika.failure.message": error.message,
                "rika.recovery.attempts": 4,
              }),
            ),
      ),
    )
  const isSteeringFailure = Schema.is(ExecutionGateway.SteeringFailure)
  const rejection = (
    admission: TurnRepositorySteering.SteeringAdmission,
    notify: boolean,
  ): SteeringAdmissionOutcome => {
    if (admission.outcome._tag !== "Rejected") return { _tag: "Pending" }
    return {
      _tag: "Rejected",
      admission,
      ...(admission.outcome.queue === undefined ? {} : { queue: admission.outcome.queue }),
      failure: admission.outcome.failure,
      notify,
    }
  }
  const rejectSteering = (
    admission: TurnRepositorySteering.SteeringAdmission,
    failure: ExecutionGateway.SteeringFailure,
  ) =>
    turns
      .rejectSteeringAdmission(admission.input.idempotencyKey, failure)
      .pipe(Effect.map((rejected) => rejection(rejected, true)))
  const completeAcceptedSteering = (
    admission: TurnRepositorySteering.SteeringAdmission,
    notify: boolean,
  ): Effect.Effect<SteeringAdmissionOutcome, TurnRepository.RepositoryError> =>
    Effect.gen(function* () {
      if (admission.outcome._tag !== "Accepted") return { _tag: "Pending" as const }
      const receipt = admission.outcome.receipt
      const queue = yield* turns.completeSteeringAdmission(admission.input.idempotencyKey, admission.target, receipt)
      return {
        _tag: "Completed" as const,
        admission,
        receipt,
        notify,
        ...(queue === undefined ? {} : { queue }),
      }
    })
  const recoverSteeringAdmission = (
    admission: TurnRepositorySteering.SteeringAdmission,
  ): Effect.Effect<SteeringAdmissionOutcome, TurnRepository.RepositoryError | TranscriptRepository.RepositoryError> =>
    Effect.uninterruptibleMask((restore) => {
      if (admission.outcome._tag === "Rejected") return Effect.succeed(rejection(admission, false))
      if (admission.outcome._tag === "Accepted") return completeAcceptedSteering(admission, true)
      return Effect.exit(restore(backend.steerTurn(admission.target, admission.input))).pipe(
        Effect.flatMap((outcome): Effect.Effect<SteeringAdmissionOutcome, TurnRepository.RepositoryError> => {
          if (outcome._tag === "Success")
            return turns
              .acceptSteeringAdmission(admission.input.idempotencyKey, outcome.value)
              .pipe(Effect.flatMap((accepted) => completeAcceptedSteering(accepted, true)))
          const error = Cause.findErrorOption(outcome.cause)
          const failure = error._tag === "Some" && isSteeringFailure(error.value) ? error.value : undefined
          if (failure === undefined || failure.kind === "unknown")
            return Effect.succeed<SteeringAdmissionOutcome>({ _tag: "Pending" })
          return rejectSteering(admission, failure)
        }),
      )
    })
  const pendingRequestIds = (target: ExecutionGateway.ExecutionLink) =>
    transcripts
      .get(Turn.TurnId.make(target.turnId))
      .pipe(
        Effect.map(
          (projection) =>
            projection?.state.steering.pending
              ?.filter((entry) => entry.runId === target.runId)
              .map((entry) => entry.requestId) ?? [],
        ),
      )
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
          Effect.flatMap((admissions) =>
            Effect.forEach(admissions, (admission) => recoverPrepared(admission), { concurrency: 8, discard: true }),
          ),
        ),
      ),
    ),
    prepareSteering: (target, input) =>
      ownerAdmission.withPermits(1)(
        Effect.gen(function* () {
          return yield* turns.prepareSteeringAdmission(
            target,
            input,
            yield* pendingRequestIds(target),
            yield* Clock.currentTimeMillis,
          )
        }),
      ),
    prepareQueuedSteering: (source, target, input) =>
      ownerAdmission.withPermits(1)(
        Effect.gen(function* () {
          return yield* turns.prepareQueuedSteeringAdmission(
            source,
            target,
            input,
            yield* pendingRequestIds(target),
            yield* Clock.currentTimeMillis,
          )
        }),
      ),
    recoverSteeringAdmissions: ownerAdmission.withPermits(1)(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const admissions = yield* turns.listSteeringAdmissions
          const outcomes = yield* Effect.forEach(admissions, (steeringAdmission) =>
            restore(recoverSteeringAdmission(steeringAdmission)),
          )
          return {
            rejected: outcomes.flatMap((outcome) =>
              outcome._tag === "Rejected"
                ? [
                    {
                      admission: outcome.admission,
                      ...(outcome.queue === undefined ? {} : { queue: outcome.queue }),
                      failure: outcome.failure,
                      notify: outcome.notify,
                    },
                  ]
                : [],
            ),
            completed: outcomes.flatMap((outcome) =>
              outcome._tag === "Completed"
                ? [
                    {
                      admission: outcome.admission,
                      receipt: outcome.receipt,
                      notify: outcome.notify,
                      ...(outcome.queue === undefined ? {} : { queue: outcome.queue }),
                    },
                  ]
                : [],
            ),
            pending: outcomes.some((outcome) => outcome._tag === "Pending" || outcome._tag === "Rejected"),
          } satisfies SteeringAdmissionRecovery
        }),
      ),
    ),
    acknowledgeSteeringRejection: (requestId) =>
      ownerAdmission.withPermits(1)(turns.completeRejectedSteeringAdmission(requestId)),
    watchTurn: (turnId, onChange, onPreview) =>
      ExecutionProjectionWatch.watch({
        turnId,
        turns,
        transcripts,
        backend,
        ...(onChange === undefined ? {} : { onChange }),
        ...(onPreview === undefined ? {} : { onPreview }),
      }),
    install: (installed) =>
      Effect.sync(() => {
        lifecycle = installed
      }),
    accepted: launch,
    quiesceThread: (threadId) =>
      Effect.gen(function* () {
        const threadTurns = yield* turns.list(threadId)
        const keys = new Set(threadTurns.map((turn) => String(turn.id)))
        const fibers = yield* ownerAdmission.withPermits(1)(
          Effect.sync(() => {
            quiesced.add(String(threadId))
            const owned = [...running].flatMap(([key, fiber]) => (keys.has(key) ? [fiber] : []))
            for (const key of keys) {
              quiescedTurns.add(key)
              claimed.delete(key)
              claimedThreads.delete(key)
              reobserve.delete(key)
              relaunch.delete(key)
              running.delete(key)
            }
            return owned
          }),
        )
        yield* Effect.forEach(fibers, Fiber.interrupt, { concurrency: "unbounded", discard: true })
      }),
  } satisfies Interface
})
