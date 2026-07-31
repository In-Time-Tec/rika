import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import * as ExecutionBackend from "@rika/product/execution-service"
import { Cause, Effect, Fiber, Scope, Semaphore } from "effect"

export interface Lifecycle {
  readonly run: (turnId: Turn.TurnId) => Effect.Effect<void, Error>
  readonly reconcile: Effect.Effect<void, Error>
}

export interface Interface {
  readonly claim: (
    turnId: Turn.TurnId,
    expectedStatus?: Turn.Status,
  ) => Effect.Effect<boolean, TurnRepository.RepositoryError>
  readonly release: (turnId: Turn.TurnId) => Effect.Effect<boolean>
  readonly claimQueued: (
    threadId: Thread.ThreadId,
    now: number,
  ) => Effect.Effect<TurnRepository.QueueClaim | undefined, TurnRepository.RepositoryError>
  readonly start: (
    input: ExecutionBackend.StartInput,
  ) => Effect.Effect<ExecutionBackend.Result, ExecutionBackend.BackendError>
  readonly follow: (
    turnId: Turn.TurnId,
    checkpoint: ExecutionBackend.ExecutionCheckpoint | string | undefined,
    onEvent?: (event: ExecutionBackend.Event) => void,
    reference?: ExecutionBackend.ExecutionReference,
    eventScope?: ExecutionBackend.EventScope,
  ) => Effect.Effect<ExecutionBackend.Result, ExecutionBackend.BackendError>
  readonly install: (lifecycle: Lifecycle) => Effect.Effect<void>
  readonly accepted: (turnId: Turn.TurnId) => Effect.Effect<void>
  readonly reconcile: Effect.Effect<void>
}

export const make = Effect.fn("RootTurnOwner.make")(function* (
  turns: TurnRepository.Interface,
  backend: ExecutionBackend.Interface,
  scope?: Scope.Scope,
) {
  const admission = yield* Semaphore.make(1)
  const ownerScope = scope ?? (yield* Scope.make())
  const claimed = new Set<string>()
  let lifecycle: Lifecycle | undefined
  const running = new Map<string, Fiber.Fiber<void, Error>>()
  const claim = (turnId: Turn.TurnId, expectedStatus?: Turn.Status) =>
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
    start: (input) => backend.start(input),
    follow: (turnId, checkpoint, onEvent, reference, eventScope) => {
      if (backend.follow === undefined)
        return Effect.fail(ExecutionBackend.BackendError.make({ message: "Execution follow is unavailable" }))
      return backend.follow(turnId, checkpoint, onEvent, reference, eventScope)
    },
    install: (installed) =>
      Effect.sync(() => {
        lifecycle = installed
      }),
    accepted: launch,
    reconcile: Effect.suspend(() => (lifecycle === undefined ? Effect.void : lifecycle.reconcile)).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("root-turn-owner.reconcile.failed").pipe(
          Effect.annotateLogs("rika.failure.message", String(cause)),
        ),
      ),
    ),
  } satisfies Interface
})
