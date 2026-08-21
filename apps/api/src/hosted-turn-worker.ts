import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as HostedObservability from "@rika/product/hosted-observability"
import { HostedTurnWorkerStore, type TurnClaim } from "@rika/product-store/postgres-turn-worker-store"
import { Cause, Clock, Context, Crypto, Effect, Layer, Ref, Schema } from "effect"

export class HostedTurnWorkerError extends Schema.TaggedError<HostedTurnWorkerError>()("HostedTurnWorkerError", {
  message: Schema.String,
}) {}

export interface HostedTurnWorkerService {
  readonly ready: Effect.Effect<void, HostedTurnWorkerError>
}

export class HostedTurnWorker extends Context.Service<HostedTurnWorker, HostedTurnWorkerService>()(
  "@rika/api/hosted-turn-worker/HostedTurnWorker",
) {}

type Health =
  | { readonly _tag: "starting" }
  | { readonly _tag: "healthy" }
  | { readonly _tag: "failed"; readonly message: string }

export const layer = (options: {
  readonly workerId: string
  readonly leaseMillis: number
  readonly pollIntervalMillis: number
  readonly stuckClaimMillis?: number
}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const store = yield* HostedTurnWorkerStore
      const gateway = yield* ExecutionGateway.Service
      const crypto = yield* Crypto.Crypto
      const health = yield* Ref.make<Health>({ _tag: "starting" })
      const heartbeatInterval = Math.max(1, Math.floor(options.leaseMillis / 3))
      const stuckClaimMillis = options.stuckClaimMillis ?? options.leaseMillis * 4
      const correlation = (claim: TurnClaim): HostedObservability.Correlation => ({
        ownerId: claim.ownerId,
        threadId: claim.input.threadId,
        turnId: claim.input.turnId,
      })
      const heartbeat = (claim: TurnClaim) => {
        let stuckReported = false
        return Effect.forever(
          Effect.sleep(heartbeatInterval).pipe(
            Effect.andThen(Clock.currentTimeMillis),
            Effect.tap((now) => {
              const age = now - claim.claimedAt
              if (stuckReported || age < stuckClaimMillis) return Effect.void
              stuckReported = true
              return HostedObservability.health("stuck_queue_claim", correlation(claim), {
                value: age,
                threshold: stuckClaimMillis,
              }).pipe(
                Effect.andThen(
                  Ref.set(health, { _tag: "failed", message: "Hosted Turn worker has a stuck queue claim" }),
                ),
              )
            }),
            Effect.flatMap((now) => store.renew(claim, now, options.leaseMillis)),
            Effect.tap((renewed) =>
              renewed ? Effect.void : HostedObservability.health("stale_lease", correlation(claim)),
            ),
            Effect.filterOrFail(
              (renewed) => renewed,
              () => HostedTurnWorkerError.make({ message: `Lost claim for Turn ${claim.input.turnId}` }),
            ),
            Effect.asVoid,
          ),
        )
      }
      const execute = Effect.fn("HostedTurnWorker.execute")(function* (claim: TurnClaim) {
        if (!claim.prepared) {
          const prepared = yield* store.prepare(claim, yield* Clock.currentTimeMillis)
          if (!prepared) {
            yield* store.release(claim)
            return
          }
        }
        yield* HostedObservability.observe(
          "run_start",
          correlation(claim),
          Effect.raceFirst(
            Effect.gen(function* () {
              const link = yield* gateway.startTurn(claim.input)
              yield* store.complete(claim, link, yield* Clock.currentTimeMillis)
            }),
            heartbeat(claim),
          ),
        )
      })
      const next = Effect.fn("HostedTurnWorker.next")(function* () {
        const request = {
          workerId: options.workerId,
          claimToken: yield* crypto.randomUUIDv4,
          now: yield* Clock.currentTimeMillis,
          leaseMillis: options.leaseMillis,
        }
        return (yield* store.claimRecovery(request)) ?? (yield* store.claimNext(request))
      })
      const poll = Effect.gen(function* () {
        const claim = yield* next()
        if (claim === undefined) {
          yield* Ref.set(health, { _tag: "healthy" })
          yield* Effect.sleep(options.pollIntervalMillis)
          return
        }
        yield* execute(claim)
        yield* Ref.set(health, { _tag: "healthy" })
      }).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
          const message = "Hosted Turn worker failed"
          return Ref.set(health, { _tag: "failed", message }).pipe(
            Effect.andThen(Effect.logError("hosted-turn-worker.failed")),
            Effect.andThen(Effect.sleep(options.pollIntervalMillis)),
          )
        }),
      )
      const service = HostedTurnWorker.of({
        ready: Ref.get(health).pipe(
          Effect.flatMap((state) =>
            state._tag === "healthy"
              ? Effect.void
              : Effect.fail(
                  HostedTurnWorkerError.make({
                    message:
                      state._tag === "starting" ? "Hosted Turn worker has not completed its first poll" : state.message,
                  }),
                ),
          ),
        ),
      })
      return Layer.merge(
        Layer.succeed(HostedTurnWorker, service),
        Layer.effectDiscard(Effect.forkScoped(Effect.forever(poll))),
      )
    }),
  )
