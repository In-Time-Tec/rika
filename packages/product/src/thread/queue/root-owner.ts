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
import { Cause, Clock, Effect, Fiber, RcMap, Schema, Scope, Semaphore } from "effect"

interface ThreadOwnerState {
  readonly admission: Semaphore.Semaphore
  readonly claimed: Set<string>
  readonly reobserve: Set<string>
  readonly running: Map<string, Fiber.Fiber<void, Error>>
  readonly relaunch: Set<string>
  quiesced: boolean
}

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
  readonly release: (threadId: Thread.ThreadId, turnId: Turn.TurnId) => Effect.Effect<boolean>
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
  readonly acknowledgeSteeringRejection: (
    threadId: Thread.ThreadId,
    requestId: string,
  ) => Effect.Effect<boolean, TurnRepository.RepositoryError>
  readonly watchTurn: (
    turnId: Turn.TurnId,
    onChange?: (change: ExecutionProjection.Change) => void,
    onPreview?: (preview: ExecutionGateway.ModelPreviewEvent) => void,
  ) => Effect.Effect<
    ExecutionProjection.Result,
    ExecutionGateway.WatchTurnFailure | TurnRepository.RepositoryError | TranscriptRepository.RepositoryError
  >
  readonly install: (lifecycle: Lifecycle) => Effect.Effect<void>
  readonly accepted: (threadId: Thread.ThreadId, turnId: Turn.TurnId) => Effect.Effect<void>
  readonly quiesceThread: (threadId: Thread.ThreadId) => Effect.Effect<void, TurnRepository.RepositoryError>
}

export const make = Effect.fn("RootTurnOwner.make")(function* (
  turns: TurnRepository.Interface,
  transcripts: TranscriptRepository.Interface,
  backend: ExecutionGateway.Interface,
  scope?: Scope.Scope,
) {
  const ownerScope = scope ?? (yield* Scope.make())
  const threadOwners = yield* RcMap.make({
    lookup: () =>
      Effect.gen(function* () {
        return {
          admission: yield* Semaphore.make(1),
          claimed: new Set<string>(),
          reobserve: new Set<string>(),
          running: new Map<string, Fiber.Fiber<void, Error>>(),
          relaunch: new Set<string>(),
          quiesced: false,
        } satisfies ThreadOwnerState
      }),
    idleTimeToLive: Infinity,
  }).pipe(Effect.provideService(Scope.Scope, ownerScope))
  const withThreadState = <A, E, R>(
    threadId: string,
    use: (state: ThreadOwnerState) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.scoped(
      RcMap.get(threadOwners, threadId).pipe(Effect.flatMap((state) => state.admission.withPermits(1)(use(state)))),
    )
  let lifecycle: Lifecycle | undefined
  const claim = (turnId: Turn.TurnId, expectedStatus?: ExecutionStatus.Status) =>
    Effect.gen(function* () {
      const current = yield* turns.get(turnId)
      if (current === undefined) return false
      return yield* withThreadState(String(current.threadId), (state) =>
        Effect.gen(function* () {
          const latest = yield* turns.get(turnId)
          if (latest === undefined || String(latest.threadId) !== String(current.threadId)) return false
          const key = String(turnId)
          if (state.claimed.has(key)) {
            state.reobserve.add(key)
            return false
          }
          if (
            state.quiesced ||
            latest.status === "queued" ||
            (ExecutionStatus.isTerminalStatus(latest.status) && expectedStatus === undefined) ||
            (expectedStatus !== undefined && latest.status !== expectedStatus)
          )
            return false
          state.claimed.add(key)
          return true
        }),
      )
    })
  const release = (threadId: Thread.ThreadId, turnId: Turn.TurnId) =>
    withThreadState(String(threadId), (state) =>
      Effect.sync(() => {
        const key = String(turnId)
        state.claimed.delete(key)
        return state.reobserve.delete(key)
      }),
    )
  const launch = (state: ThreadOwnerState, turnId: Turn.TurnId): Effect.Effect<void> =>
    state.admission.withPermits(1)(
      Effect.gen(function* () {
        const key = String(turnId)
        if (lifecycle === undefined) return
        if (state.running.has(key)) {
          state.relaunch.add(key)
          return
        }
        if (state.quiesced) return
        const program = lifecycle.run(turnId).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("root-turn-owner.run.failed").pipe(
                  Effect.annotateLogs({ "rika.turn.id": String(turnId), "rika.failure.message": String(cause) }),
                ),
          ),
          Effect.ensuring(
            state.admission
              .withPermits(1)(
                Effect.sync(() => {
                  state.running.delete(key)
                  return state.relaunch.delete(key)
                }),
              )
              .pipe(Effect.flatMap((requested) => (requested ? launch(state, turnId) : Effect.void))),
          ),
        )
        const fiber = yield* Effect.forkIn(program, ownerScope)
        state.running.set(key, fiber)
      }),
    )
  const claimQueued = (threadId: Thread.ThreadId, now: number) =>
    withThreadState(String(threadId), (state) =>
      Effect.gen(function* () {
        if (state.quiesced) return undefined
        const queueClaim = yield* turns.claimNextQueued(threadId, now)
        if (queueClaim === undefined) return undefined
        const key = String(queueClaim.turn.id)
        if (state.claimed.has(key)) {
          yield* turns.releaseQueuedClaim(queueClaim)
          return undefined
        }
        state.claimed.add(key)
        return queueClaim
      }),
    )
  const admitPrepared = Effect.fn("RootTurnOwner.admitPrepared")(function* (
    state: ThreadOwnerState,
    input: ExecutionGateway.StartTurn,
  ) {
    if (state.quiesced)
      return yield* ExecutionGateway.StartTurnFailure.make({ message: `Thread ${input.threadId} is being deleted` })
    const link = yield* backend.startTurn(input)
    const turn = yield* turns.attachExecutionLink(Turn.TurnId.make(input.turnId), link, yield* Clock.currentTimeMillis)
    if (turn.status === "cancelled")
      yield* backend
        .cancelTurn(link, "Cancelled before execution link attached")
        .pipe(Effect.mapError((failure) => ExecutionGateway.StartTurnFailure.make({ message: failure.message })))
    return link
  })
  const recoverPreparedWithState = (
    state: ThreadOwnerState,
    input: ExecutionGateway.StartTurn,
    attempts = 4,
    delay = 100,
  ): Effect.Effect<void, never> =>
    admitPrepared(state, input).pipe(
      Effect.asVoid,
      Effect.catch((error) =>
        attempts > 1
          ? Effect.sleep(delay).pipe(Effect.andThen(recoverPreparedWithState(state, input, attempts - 1, delay * 2)))
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
  const recoverPrepared = (input: ExecutionGateway.StartTurn) =>
    withThreadState(input.threadId, (state) => recoverPreparedWithState(state, input))
  const isSteeringFailure = Schema.is(ExecutionGateway.SteeringFailure)
  const rejection = (
    admission: TurnRepositorySteering.SteeringAdmission,
    notify: boolean,
  ): SteeringAdmissionOutcome => {
    if (admission.outcome._tag !== "Rejected") return { _tag: "Pending" }
    return admission.outcome.queue === undefined
      ? { _tag: "Rejected", admission, failure: admission.outcome.failure, notify }
      : { _tag: "Rejected", admission, queue: admission.outcome.queue, failure: admission.outcome.failure, notify }
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
      return queue === undefined
        ? { _tag: "Completed" as const, admission, receipt, notify }
        : { _tag: "Completed" as const, admission, receipt, notify, queue }
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
  const recoverSteeringAdmissions = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const admissions = yield* turns.listSteeringAdmissions
      const groups = new Map<string, Array<readonly [number, TurnRepositorySteering.SteeringAdmission]>>()
      for (const [index, admission] of admissions.entries()) {
        const threadId = admission.target.threadId
        const group = groups.get(threadId)
        if (group === undefined) groups.set(threadId, [[index, admission]])
        else group.push([index, admission])
      }
      const outcomes = new Array<SteeringAdmissionOutcome | undefined>(admissions.length)
      yield* Effect.forEach(
        groups,
        ([threadId, group]) =>
          withThreadState(threadId, () =>
            Effect.forEach(
              group,
              ([index, admission]) =>
                restore(recoverSteeringAdmission(admission)).pipe(
                  Effect.tap((outcome) => Effect.sync(() => (outcomes[index] = outcome))),
                ),
              { discard: true },
            ),
          ),
        { concurrency: "unbounded", discard: true },
      )
      const settled = outcomes.flatMap((outcome) => (outcome === undefined ? [] : [outcome]))
      return {
        rejected: settled.flatMap((outcome) => (outcome._tag === "Rejected" ? [outcome] : [])),
        completed: settled.flatMap((outcome) => (outcome._tag === "Completed" ? [outcome] : [])),
        pending: settled.some((outcome) => outcome._tag === "Pending" || outcome._tag === "Rejected"),
      } satisfies SteeringAdmissionRecovery
    }),
  )
  return {
    claim,
    release,
    claimQueued,
    startTurn: (input) =>
      withThreadState(input.threadId, (state) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const prepared = yield* turns.prepareExecutionAdmission(input, yield* Clock.currentTimeMillis)
            return yield* admitPrepared(state, prepared)
          }),
        ),
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
      withThreadState(target.threadId, () =>
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
      withThreadState(target.threadId, () =>
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
    recoverSteeringAdmissions,
    acknowledgeSteeringRejection: (threadId, requestId) =>
      withThreadState(String(threadId), () => turns.completeRejectedSteeringAdmission(requestId)),
    watchTurn: (turnId, onChange, onPreview) => {
      if (onChange === undefined) {
        if (onPreview === undefined) return ExecutionProjectionWatch.watch({ turnId, turns, transcripts, backend })
        return ExecutionProjectionWatch.watch({ turnId, turns, transcripts, backend, onPreview })
      }
      if (onPreview === undefined)
        return ExecutionProjectionWatch.watch({ turnId, turns, transcripts, backend, onChange })
      return ExecutionProjectionWatch.watch({ turnId, turns, transcripts, backend, onChange, onPreview })
    },
    install: (installed) =>
      Effect.sync(() => {
        lifecycle = installed
      }),
    accepted: (threadId, turnId) =>
      Effect.scoped(RcMap.get(threadOwners, String(threadId)).pipe(Effect.flatMap((state) => launch(state, turnId)))),
    quiesceThread: (threadId) =>
      withThreadState(String(threadId), (state) =>
        Effect.sync(() => {
          state.quiesced = true
          const fibers = [...state.running.values()]
          state.claimed.clear()
          state.reobserve.clear()
          state.relaunch.clear()
          state.running.clear()
          return fibers
        }),
      ).pipe(
        Effect.flatMap((fibers) =>
          Effect.forEach(fibers, Fiber.interrupt, { concurrency: "unbounded", discard: true }),
        ),
      ),
  } satisfies Interface
})
