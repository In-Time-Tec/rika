import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as HostedObservability from "@rika/product/hosted-observability"
import { HostedTurnWorkerStore, type TurnClaim } from "@rika/product-store/turn-worker-store"
import { Cause, Clock, Context, Crypto, Effect, FiberMap, Layer, Ref, Schedule, Schema, SubscriptionRef } from "effect"

export class HostedTurnWorkerError extends Schema.TaggedError<HostedTurnWorkerError>()("HostedTurnWorkerError", {
  message: Schema.String,
}) {}

export interface HostedTurnWorkerService {
  readonly ready: Effect.Effect<void, HostedTurnWorkerError>
  readonly status: Effect.Effect<HostedTurnWorkerStatus>
}

export class HostedTurnWorker extends Context.Service<HostedTurnWorker, HostedTurnWorkerService>()(
  "@rika/api/hosted/thread/turn-worker/HostedTurnWorker",
) {}

type PollStatus =
  | { readonly _tag: "Starting" }
  | { readonly _tag: "Succeeded"; readonly at: number }
  | { readonly _tag: "Failed"; readonly at: number; readonly message: string }

interface WorkerState {
  readonly poll: PollStatus
  readonly lastSuccessfulPollAt: number | undefined
  readonly lastFailure: { readonly at: number; readonly message: string } | undefined
}

export interface HostedTurnWorkerStatus extends WorkerState {
  readonly active: number
  readonly capacity: number
  readonly availableCapacity: number
  readonly oldestClaimAt: number | undefined
  readonly pollAgeMillis: number | undefined
  readonly lastSuccessfulPollAgeMillis: number | undefined
  readonly oldestClaimAgeMillis: number | undefined
  readonly lastFailureAgeMillis: number | undefined
}

const age = (now: number, at: number | undefined) => (at === undefined ? undefined : now - at)

const isTransientPrepareFailure = (error: ExecutionGateway.PrepareTurnFailure) =>
  error.kind === "unavailable" ||
  error.message.includes("unavailable workspace capabilities") ||
  error.message.includes("workspace root is unavailable") ||
  error.message.includes("workspace lifecycle is not ready")

export const layer = (options: {
  readonly workerId: string
  readonly leaseMillis: number
  readonly pollIntervalMillis: number
  readonly concurrency?: number
}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const store = yield* HostedTurnWorkerStore
      const gateway = yield* ExecutionGateway.Service
      const crypto = yield* Crypto.Crypto
      const health = yield* SubscriptionRef.make<WorkerState>({
        poll: { _tag: "Starting" },
        lastSuccessfulPollAt: undefined,
        lastFailure: undefined,
      })
      const active = yield* FiberMap.make<string>()
      const activeClaims = yield* Ref.make<
        ReadonlyMap<string, { readonly claimToken: string; readonly claimedAt: number }>
      >(new Map())
      const concurrency = options.concurrency ?? 1
      const executeClaim = Effect.fn("HostedTurnWorker.execute")(function* (claim: TurnClaim) {
        let prepared = claim.preparedExecution
        if (prepared === undefined) {
          prepared = yield* gateway.prepareTurn(claim.input).pipe(
            Effect.retry({
              times: 80,
              schedule: Schedule.spaced("100 millis"),
              while: isTransientPrepareFailure,
            }),
          )
          const persisted = yield* store.prepare(claim, prepared, yield* Clock.currentTimeMillis)
          if (!persisted) {
            yield* store.release(claim)
            return
          }
        }
        let link = claim.admissionLink
        if (link === undefined) {
          link = yield* gateway.admitTurn(prepared)
          yield* store.completeAdmission(claim, link, yield* Clock.currentTimeMillis)
          yield* HostedObservability.event("run_created", "success", {
            threadId: claim.input.threadId,
            turnId: claim.input.turnId,
            runId: link.runId,
          })
        }
        const activationRequested =
          claim.activationRequested || (yield* store.requestActivation(claim, yield* Clock.currentTimeMillis))
        const status = activationRequested
          ? yield* gateway.activateTurn(prepared, link)
          : yield* gateway
              .cancelTurn(link, "Cancelled before execution activation")
              .pipe(Effect.as("cancelled" as const))
        yield* store.completeActivation(claim, status, yield* Clock.currentTimeMillis)
      })
      const execute = (claim: TurnClaim) =>
        executeClaim(claim).pipe(
          Effect.raceFirst(
            Effect.sleep(Math.max(1, Math.floor(options.leaseMillis / 3))).pipe(
              Effect.andThen(store.renew(claim, options.leaseMillis)),
              Effect.flatMap((renewed) =>
                renewed ? Effect.void : Effect.fail(HostedTurnWorkerError.make({ message: "Turn claim was lost" })),
              ),
              Effect.forever,
            ),
          ),
          Effect.onError(() => store.release(claim).pipe(Effect.ignore)),
          Effect.ensuring(
            Ref.update(activeClaims, (claims) => {
              const current = claims.get(claim.input.turnId)
              if (current?.claimToken !== claim.claimToken) return claims
              const updated = new Map(claims)
              updated.delete(claim.input.turnId)
              return updated
            }),
          ),
        )
      const next = Effect.fn("HostedTurnWorker.next")(function* () {
        const request = {
          workerId: options.workerId,
          claimToken: yield* crypto.randomUUIDv4,
          leaseMillis: options.leaseMillis,
        }
        return (yield* store.claimRecovery(request)) ?? (yield* store.claimNext(request))
      })
      const poll = Effect.gen(function* () {
        if ((yield* FiberMap.size(active)) >= concurrency) {
          const now = yield* Clock.currentTimeMillis
          yield* SubscriptionRef.update(health, (state) => ({
            ...state,
            poll: { _tag: "Succeeded", at: now } as const,
            lastSuccessfulPollAt: now,
          }))
          yield* Effect.sleep(options.pollIntervalMillis)
          return
        }
        const claim = yield* next()
        if (claim === undefined) {
          const now = yield* Clock.currentTimeMillis
          yield* SubscriptionRef.update(health, (state) => ({
            ...state,
            poll: { _tag: "Succeeded", at: now } as const,
            lastSuccessfulPollAt: now,
          }))
          yield* Effect.sleep(options.pollIntervalMillis)
          return
        }
        yield* Ref.update(activeClaims, (claims) =>
          new Map(claims).set(claim.input.turnId, {
            claimToken: claim.claimToken,
            claimedAt: claim.claimedAt,
          }),
        )
        yield* FiberMap.run(
          active,
          claim.input.turnId,
          execute(claim).pipe(
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
              const message = "Turn worker failed"
              return Clock.currentTimeMillis.pipe(
                Effect.flatMap((at) =>
                  SubscriptionRef.update(health, (state) => ({ ...state, lastFailure: { at, message } })),
                ),
                Effect.andThen(
                  Effect.logError("hosted-turn-worker.failed").pipe(
                    Effect.annotateLogs("rika.failure.message", Cause.pretty(cause)),
                  ),
                ),
              )
            }),
          ),
        )
        const now = yield* Clock.currentTimeMillis
        yield* SubscriptionRef.update(health, (state) => ({
          ...state,
          poll: { _tag: "Succeeded", at: now } as const,
          lastSuccessfulPollAt: now,
        }))
      }).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
          const message = "Turn worker poll failed"
          return Clock.currentTimeMillis.pipe(
            Effect.flatMap((at) =>
              SubscriptionRef.update(health, (state) => ({
                ...state,
                poll: { _tag: "Failed", at, message } as const,
                lastFailure: { at, message },
              })),
            ),
            Effect.andThen(
              Effect.logError("hosted-turn-worker.poll-failed").pipe(
                Effect.annotateLogs("rika.failure.message", Cause.pretty(cause)),
              ),
            ),
            Effect.andThen(Effect.sleep(options.pollIntervalMillis)),
          )
        }),
      )
      const status: Effect.Effect<HostedTurnWorkerStatus> = Effect.gen(function* () {
        const state = yield* SubscriptionRef.get(health)
        const now = yield* Clock.currentTimeMillis
        const claims = yield* Ref.get(activeClaims)
        const activeCount = yield* FiberMap.size(active)
        const oldestClaimAt =
          claims.size === 0 ? undefined : Math.min(...Array.from(claims.values(), (claim) => claim.claimedAt))
        const pollAt = state.poll._tag === "Starting" ? undefined : state.poll.at
        return {
          ...state,
          active: activeCount,
          capacity: concurrency,
          availableCapacity: Math.max(0, concurrency - activeCount),
          oldestClaimAt,
          pollAgeMillis: age(now, pollAt),
          lastSuccessfulPollAgeMillis: age(now, state.lastSuccessfulPollAt),
          oldestClaimAgeMillis: age(now, oldestClaimAt),
          lastFailureAgeMillis: age(now, state.lastFailure?.at),
        }
      })
      const service = HostedTurnWorker.of({
        status,
        ready: status.pipe(
          Effect.flatMap((state) => {
            if (state.poll._tag === "Starting")
              return Effect.fail(
                HostedTurnWorkerError.make({ message: "Turn worker has not completed its first poll" }),
              )
            if (state.poll._tag === "Failed")
              return Effect.fail(HostedTurnWorkerError.make({ message: state.poll.message }))
            if (state.pollAgeMillis !== undefined && state.pollAgeMillis > options.pollIntervalMillis * 4)
              return Effect.fail(HostedTurnWorkerError.make({ message: "Turn worker poll is stale" }))
            return Effect.void
          }),
        ),
      })
      return Layer.merge(
        Layer.succeed(HostedTurnWorker, service),
        Layer.effectDiscard(Effect.forkScoped(Effect.forever(poll))),
      )
    }),
  )
