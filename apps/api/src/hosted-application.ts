import { BunCrypto } from "@effect/platform-bun"
import type * as PgClient from "@effect/sql-pg/PgClient"
import { Context, Effect, Layer, Redacted } from "effect"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionSessionLifecycle from "@rika/product/execution-session-lifecycle"
import { AuthorizationPolicy } from "@rika/product/hosted-authorization"
import { layer as postgresLayer } from "@rika/product-store/postgres-layer"
import * as HostedExecution from "@rika/execution"
import * as ExecutionPostgres from "@rika/execution/postgres"
import * as RemoteCells from "@rika/execution/remote-cells"
import { type ExecutorConfig, Executor, layer as executorLayer, service as executorService } from "./executor"
import { HostedOperations, layer as hostedOperationsLayer } from "./hosted-operations"
import { HostedProduct, layer as hostedProductLayer } from "./hosted-product"
import { layer as localExecutorLayer } from "./local-executor"

export interface HostedApplicationService {
  readonly product: HostedProduct["Service"]
  readonly operations: HostedOperations["Service"]
  readonly executor: Executor["Service"]
  readonly execution: {
    readonly gateway: ExecutionGateway.Interface
    readonly lifecycle: ExecutionSessionLifecycle.Interface
    readonly readiness: ExecutionPostgres.ReadinessInterface
  }
}

export class HostedApplication extends Context.Service<HostedApplication, HostedApplicationService>()(
  "@rika/api/hosted-application/HostedApplication",
) {}

export const layer = (options: {
  readonly database: PgClient.PgPoolConfig
  readonly databaseUrl: Redacted.Redacted<string>
  readonly executor: ExecutorConfig
  readonly workerId: string
}) =>
  Layer.effect(
    HostedApplication,
    Effect.gen(function* () {
      const data = yield* Layer.build(
        Layer.mergeAll(postgresLayer(options.database), AuthorizationPolicy.layer, BunCrypto.layer),
      )
      const retainedData = Layer.succeedContext(data)
      const executorContext = yield* Layer.build(
        executorService.pipe(
          Layer.provide(Layer.merge(executorLayer(options.executor), localExecutorLayer)),
          Layer.provide(retainedData),
        ),
      )
      const executor = Context.get(executorContext, Executor)
      const executionContext = yield* Layer.build(
        HostedExecution.layerHosted({
          kernel: { runtimeVersion: Bun.version, dataRoot: "/workspace" },
          cells: HostedExecution.remoteCells({
            cells: RemoteCells.layer({
              execute: (request) =>
                executor
                  .run({ threadId: request.sessionId, operationKey: request.operationKey, code: request.code })
                  .pipe(
                    Effect.map((result) => result.response),
                    Effect.mapError((error) => RemoteCells.Unavailable.make({ message: error.message })),
                  ),
            }),
            maxRetries: 3,
            retryDelayMillis: 250,
          }),
          postgres: {
            url: Redacted.value(options.databaseUrl),
            source: "rika-api",
            maxConnections: options.database.maxConnections ?? 10,
            worker: {
              workerId: options.workerId,
              concurrency: 8,
              leaseMillis: 30_000,
              pollIntervalMillis: 250,
              cancellationIntervalMillis: 1_000,
            },
          },
        }),
      )
      const hostedContext = Context.merge(data, executionContext)
      const productContext = yield* Layer.build(
        hostedProductLayer({
          templateBuildId: options.executor.templateBuildId,
          providerScope: options.executor.deploymentId,
        }).pipe(Layer.provide(Layer.succeedContext(hostedContext))),
      )
      const operationsContext = yield* Layer.build(
        hostedOperationsLayer.pipe(Layer.provide(Layer.succeedContext(hostedContext))),
      )
      return HostedApplication.of({
        product: Context.get(productContext, HostedProduct),
        operations: Context.get(operationsContext, HostedOperations),
        executor,
        execution: {
          gateway: Context.get(executionContext, ExecutionGateway.Service),
          lifecycle: Context.get(executionContext, ExecutionSessionLifecycle.Service),
          readiness: Context.get(executionContext, ExecutionPostgres.Readiness),
        },
      })
    }),
  )
