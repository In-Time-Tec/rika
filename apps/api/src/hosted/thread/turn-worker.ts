import * as ExecutionGateway from "@rika/product/execution-gateway"
import { HostedTurnWorkerStore, type TurnClaim } from "@rika/product-store/turn-worker-store"
import { Clock, Context, Crypto, Effect, Layer, Schema } from "effect"
import { HostedWorkerRuntime, type HostedWorkerStatus } from "../worker-runtime"

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

export type HostedTurnWorkerStatus = HostedWorkerStatus

export const layer = (options: {
  readonly workerId: string
  readonly leaseMillis: number
  readonly fallbackIntervalMillis: number
  readonly concurrency?: number
}) =>
  Layer.effect(
    HostedTurnWorker,
    Effect.gen(function* () {
      const store = yield* HostedTurnWorkerStore
      const gateway = yield* ExecutionGateway.Service
      const crypto = yield* Crypto.Crypto
      const runtime = yield* HostedWorkerRuntime
      const concurrency = options.concurrency ?? 1
      const executeClaim = Effect.fn("HostedTurnWorker.execute")(function* (claim: TurnClaim) {
        const activationRequested =
          claim.activationRequested || (yield* store.requestActivation(claim, yield* Clock.currentTimeMillis))
        const status = activationRequested
          ? yield* gateway.activateTurn(claim.preparedExecution, claim.admissionLink)
          : yield* gateway
              .cancelTurn(claim.admissionLink, "Cancelled before execution activation")
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
        )
      const next = Effect.fn("HostedTurnWorker.next")(function* () {
        const request = {
          workerId: options.workerId,
          claimToken: yield* crypto.randomUUIDv4,
          leaseMillis: options.leaseMillis,
        }
        return yield* store.claimNext(request)
      })
      const worker = yield* runtime.register({
        domain: "turn",
        concurrency,
        fallbackIntervalMillis: options.fallbackIntervalMillis,
        scanFailureMessage: "Turn worker scan failed",
        executionFailureMessage: "Turn worker failed",
        scan: (control) =>
          Effect.gen(function* () {
            for (let attempt = 0; attempt < control.availableCapacity; attempt += 1) {
              const claim = yield* next()
              if (claim === undefined) break
              const started = yield* control.start({
                key: claim.input.turnId,
                runnableAt: claim.queuedAt,
                effect: execute(claim),
              })
              if (!started) yield* store.release(claim)
            }
            return { oldestRunnableAt: yield* store.oldestRunnableAt }
          }),
      })
      return HostedTurnWorker.of({
        status: worker.status,
        ready: worker.ready.pipe(Effect.mapError((error) => HostedTurnWorkerError.make({ message: error.message }))),
      })
    }),
  )
