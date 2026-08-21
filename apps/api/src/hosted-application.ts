import { BunCrypto } from "@effect/platform-bun"
import type * as PgClient from "@effect/sql-pg/PgClient"
import { Context, Effect, Layer, Redacted } from "effect"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionSessionLifecycle from "@rika/product/execution-session-lifecycle"
import { ProviderCredentialStore } from "@rika/product/provider-credential-store"
import { AuthorizationPolicy } from "@rika/product/hosted-authorization"
import { layer as postgresLayer } from "@rika/product-store/postgres-layer"
import * as ProductRepositories from "@rika/product-store/postgres-product-repositories"
import * as HostedTurnWorkerStore from "@rika/product-store/postgres-turn-worker-store"
import * as HostedExecution from "@rika/execution"
import * as ExecutionPostgres from "@rika/execution/postgres"
import * as RemoteCells from "@rika/execution/remote-cells"
import { type ExecutorConfig, Executor, layer as executorLayer, service as executorService } from "./executor"
import { HostedOperations, layer as hostedOperationsLayer } from "./hosted-operations"
import { HostedThreadProtocol, layer as hostedThreadProtocolLayer } from "./hosted-thread-protocol"
import { HostedModelRegistry, layer as hostedModelRegistryLayer } from "./hosted-model-registry"
import { HostedProduct, layer as hostedProductLayer } from "./hosted-product"
import {
  HostedProviderCredentials,
  layer as hostedProviderCredentialsLayer,
  storeLayer as providerCredentialStoreLayer,
} from "./hosted-provider-credentials"
import { HostedProjectionWorker, layer as hostedProjectionWorkerLayer } from "./hosted-projection-worker"
import { HostedTurnWorker, layer as hostedTurnWorkerLayer } from "./hosted-turn-worker"
import { layer as localExecutorLayer } from "./local-executor"

export interface HostedApplicationService {
  readonly product: HostedProduct["Service"]
  readonly operations: HostedOperations["Service"]
  readonly threads: HostedThreadProtocol["Service"]
  readonly credentials: HostedProviderCredentials["Service"]
  readonly models: HostedModelRegistry["Service"]
  readonly executor: Executor["Service"]
  readonly projectionWorker: HostedProjectionWorker["Service"]
  readonly turnWorker: HostedTurnWorker["Service"]
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
  readonly providerCredentialKey: Redacted.Redacted<string>
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
      const credentialContext = yield* Layer.build(
        Layer.merge(
          hostedProviderCredentialsLayer({ encryptionKey: options.providerCredentialKey }),
          providerCredentialStoreLayer({ encryptionKey: options.providerCredentialKey }),
        ).pipe(Layer.provide(retainedData)),
      )
      const modelContext = yield* Layer.build(
        hostedModelRegistryLayer.pipe(Layer.provide(Layer.succeedContext(Context.merge(data, credentialContext)))),
      )
      const executorContext = yield* Layer.build(
        executorService.pipe(
          Layer.provide(Layer.merge(executorLayer(options.executor), localExecutorLayer)),
          Layer.provide(retainedData),
        ),
      )
      const executor = Context.get(executorContext, Executor)
      const executionContext = yield* Layer.build(
        HostedExecution.layerHosted({
          kernel: { runtimeVersion: Bun.version, dataRoot: `${Bun.env.TMPDIR ?? "/tmp"}/rika-hosted` },
          credentialStore: Layer.succeed(
            ProviderCredentialStore,
            Context.get(credentialContext, ProviderCredentialStore),
          ),
          cells: HostedExecution.remoteCells({
            cells: RemoteCells.layer({
              execute: (request, authority) =>
                executor.run({ ...request, authority }).pipe(
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
      const hostedContext = Context.merge(
        Context.merge(data, executionContext),
        Context.merge(credentialContext, modelContext),
      )
      const projectionWorkerContext = yield* Layer.build(
        hostedProjectionWorkerLayer({ concurrency: 32, pollIntervalMillis: 250 }).pipe(
          Layer.provide(ProductRepositories.projectionLayer),
          Layer.provide(Layer.succeedContext(hostedContext)),
        ),
      )
      const projectionWorker = Context.get(projectionWorkerContext, HostedProjectionWorker)
      const turnWorkerContext = yield* Layer.build(
        hostedTurnWorkerLayer({
          workerId: options.workerId,
          leaseMillis: 30_000,
          pollIntervalMillis: 250,
        }).pipe(Layer.provide(HostedTurnWorkerStore.layer), Layer.provide(Layer.succeedContext(hostedContext))),
      )
      const turnWorker = Context.get(turnWorkerContext, HostedTurnWorker)
      const productContext = yield* Layer.build(
        hostedProductLayer({
          templateBuildId: options.executor.templateBuildId,
          providerScope: options.executor.deploymentId,
        }).pipe(Layer.provide(Layer.succeedContext(hostedContext))),
      )
      const operationsContext = yield* Layer.build(
        hostedOperationsLayer.pipe(Layer.provide(Layer.succeedContext(hostedContext))),
      )
      const threadProtocolContext = yield* Layer.build(
        hostedThreadProtocolLayer.pipe(
          Layer.provide(
            Layer.succeedContext(Context.merge(hostedContext, Context.merge(productContext, operationsContext))),
          ),
        ),
      )
      return HostedApplication.of({
        product: Context.get(productContext, HostedProduct),
        operations: Context.get(operationsContext, HostedOperations),
        threads: Context.get(threadProtocolContext, HostedThreadProtocol),
        credentials: Context.get(credentialContext, HostedProviderCredentials),
        models: Context.get(modelContext, HostedModelRegistry),
        executor,
        projectionWorker,
        turnWorker,
        execution: {
          gateway: Context.get(executionContext, ExecutionGateway.Service),
          lifecycle: Context.get(executionContext, ExecutionSessionLifecycle.Service),
          readiness: ExecutionPostgres.Readiness.of({
            check: Effect.all([
              Context.get(executionContext, ExecutionPostgres.Readiness).check,
              projectionWorker.ready.pipe(
                Effect.mapError((error) => ExecutionPostgres.WorkerUnavailable.make({ message: error.message })),
              ),
              turnWorker.ready.pipe(
                Effect.mapError((error) => ExecutionPostgres.WorkerUnavailable.make({ message: error.message })),
              ),
            ]).pipe(Effect.map(([readiness]) => readiness)),
          }),
        },
      })
    }),
  )
