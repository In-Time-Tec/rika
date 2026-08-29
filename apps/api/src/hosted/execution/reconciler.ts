import * as ExecutionAuthorityReconciliation from "@rika/product/execution-authority-reconciliation"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as TurnRepository from "@rika/product/turn-repository"
import { Context, Effect, Layer, Schema } from "effect"
import { HostedWorkerRuntime, type HostedWorkerStatus } from "../worker-runtime"

export class HostedExecutionReconcilerError extends Schema.TaggedError<HostedExecutionReconcilerError>()(
  "HostedExecutionReconcilerError",
  { message: Schema.String },
) {}

export type HostedExecutionReconcilerStatus = HostedWorkerStatus

export interface HostedExecutionReconcilerService {
  readonly ready: Effect.Effect<void, HostedExecutionReconcilerError>
  readonly status: Effect.Effect<HostedExecutionReconcilerStatus>
}

export class HostedExecutionReconciler extends Context.Service<
  HostedExecutionReconciler,
  HostedExecutionReconcilerService
>()("@rika/api/hosted/execution/reconciler/HostedExecutionReconciler") {}

export const layer = (options: { readonly fallbackIntervalMillis: number }) =>
  Layer.effect(
    HostedExecutionReconciler,
    Effect.gen(function* () {
      const turns = yield* TurnRepository.Service
      const backend = yield* ExecutionGateway.Service
      const runtime = yield* HostedWorkerRuntime
      const worker = yield* runtime.register({
        domain: "reconciliation",
        concurrency: 1,
        fallbackIntervalMillis: options.fallbackIntervalMillis,
        scanFailureMessage: "Execution reconciliation failed",
        executionFailureMessage: "Execution reconciliation failed",
        scan: () =>
          ExecutionAuthorityReconciliation.make({
            turns,
            backend,
            setTurnStatus: (id, status, now) => turns.setStatus(id, status, now),
          }).pipe(
            Effect.map((result) => ({
              oldestRunnableAt:
                result.active.length === 0 ? undefined : Math.min(...result.active.map((turn) => turn.createdAt)),
            })),
          ),
      })
      return HostedExecutionReconciler.of({
        status: worker.status,
        ready: worker.ready.pipe(
          Effect.mapError((error) => HostedExecutionReconcilerError.make({ message: error.message })),
        ),
      })
    }),
  )
