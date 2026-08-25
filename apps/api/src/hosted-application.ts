import { BunCrypto } from "@effect/platform-bun"
import * as PgClient from "@effect/sql-pg/PgClient"
import { appJwtJoseLayer } from "@rika/github-app/app-jwt"
import { installationLayer } from "@rika/github-app/installation-service"
import { installationTokenLayer } from "@rika/github-app/installation-token"
import { Config, Context, Effect, Layer, Redacted } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Runtime as TenetRuntime } from "tenetkit/runtime"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionSessionLifecycle from "@rika/product/execution-session-lifecycle"
import { ProviderCredentialStore } from "@rika/product/provider-credential-store"
import * as OpenAiAuthHttp from "@rika/product/openai-auth-http"
import { AuthorizationPolicy } from "@rika/product/hosted-authorization"
import { layer as postgresLayer } from "@rika/product-store/postgres-layer"
import * as ProductRepositories from "@rika/product-store/postgres-product-repositories"
import * as HostedTurnWorkerStore from "@rika/product-store/postgres-turn-worker-store"
import * as HostedExecution from "@rika/execution"
import * as ExecutionPostgres from "@rika/execution/postgres"
import * as RemoteCells from "@rika/execution/remote-cells"
import {
  type ExecutorConfig,
  Executor,
  layer as executorLayer,
  runnerOnlyControllerLayer,
  service as executorService,
} from "./executor"
import { HostedEnvironment, layer as hostedEnvironmentLayer } from "./hosted-environment"
import { HostedThreadApplication, layer as hostedThreadApplicationLayer } from "./hosted-thread-application"
import { HostedThreadCommandWorker, layer as hostedThreadCommandWorkerLayer } from "./hosted-thread-command-worker"
import { HostedThreadProtocol, layerWithOptions as hostedThreadProtocolLayer } from "./hosted-thread-protocol"
import { HostedModelRegistry, layer as hostedModelRegistryLayer } from "./hosted-model-registry"
import { HostedProduct, layer as hostedProductLayer } from "./hosted-product"
import { HostedPublication, layer as hostedPublicationLayer } from "./hosted-publication"
import {
  HostedProviderCredentials,
  layer as hostedProviderCredentialsLayer,
  storeLayer as providerCredentialStoreLayer,
} from "./hosted-provider-credentials"
import { HostedExecutionReconciler, layer as hostedExecutionReconcilerLayer } from "./hosted-execution-reconciler"
import { HostedProjectionWorker, layer as hostedProjectionWorkerLayer } from "./hosted-projection-worker"
import { HostedRecovery, type HostedRecoveryService, layer as hostedRecoveryLayer } from "./hosted-recovery"
import {
  HostedRepositories,
  layer as hostedRepositoriesLayer,
  unavailableLayer as hostedRepositoriesUnavailableLayer,
} from "./hosted-repositories"
import { HostedTurnWorker, layer as hostedTurnWorkerLayer } from "./hosted-turn-worker"
import { layer as hostedWorkspaceLayer } from "./hosted-workspace"
import { workspacePlacement } from "./hosted-workspace-placement"
import { layer as runnerExecutorLayer } from "./runner-executor"
import { HostedToolPolicy, layer as hostedToolPolicyLayer } from "./hosted-tool-policy"

export interface HostedApplicationService {
  readonly product: HostedProduct["Service"]
  readonly threadApplication: HostedThreadApplication["Service"]
  readonly threadProtocol: HostedThreadProtocol["Service"]
  readonly toolPolicy: HostedToolPolicy["Service"]
  readonly credentials: HostedProviderCredentials["Service"]
  readonly environment: HostedEnvironment["Service"]
  readonly models: HostedModelRegistry["Service"]
  readonly executor: Executor["Service"]
  readonly recovery: HostedRecoveryService
  readonly repositories: HostedRepositories["Service"]
  readonly publication: HostedPublication["Service"]
  readonly executionReconciler: HostedExecutionReconciler["Service"]
  readonly projectionWorker: HostedProjectionWorker["Service"]
  readonly turnWorker: HostedTurnWorker["Service"]
  readonly threadCommandWorker: HostedThreadCommandWorker["Service"]
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
  readonly executor?: ExecutorConfig
  readonly github?: { readonly appId: number; readonly privateKey: Redacted.Redacted<string> }
  readonly developmentModel?: string
  readonly workerId: string
}) =>
  Layer.effect(
    HostedApplication,
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient
      const temporaryDirectory = yield* Config.string("TMPDIR").pipe(Config.withDefault("/tmp"))
      const httpLayer = Layer.succeed(HttpClient.HttpClient, httpClient)
      const data = yield* Layer.build(
        Layer.mergeAll(postgresLayer(options.database), AuthorizationPolicy.layer, BunCrypto.layer),
      )
      const retainedData = Layer.succeedContext(data)
      const openAiHttpContext = yield* Layer.build(OpenAiAuthHttp.layer.pipe(Layer.provide(httpLayer)))
      const credentialContext = yield* Layer.build(
        Layer.merge(
          hostedProviderCredentialsLayer({ encryptionKey: options.providerCredentialKey }),
          providerCredentialStoreLayer({ encryptionKey: options.providerCredentialKey }),
        ).pipe(Layer.provide(Layer.succeedContext(Context.merge(data, openAiHttpContext)))),
      )
      const environmentContext = yield* Layer.build(
        hostedEnvironmentLayer({
          encryptionKey: options.providerCredentialKey,
          protectedEgressHosts: new Set([new URL(Redacted.value(options.databaseUrl)).hostname]),
        }).pipe(Layer.provide(retainedData)),
      )
      const modelContext = yield* Layer.build(
        hostedModelRegistryLayer(
          options.developmentModel === undefined ? {} : { developmentModel: options.developmentModel },
        ).pipe(Layer.provide(Layer.succeedContext(Context.merge(data, credentialContext)))),
      )
      const repositoryContext = yield* Layer.build(
        options.github === undefined
          ? hostedRepositoriesUnavailableLayer
          : hostedRepositoriesLayer().pipe(
              Layer.provide(
                Layer.merge(installationLayer({ appId: options.github.appId }), installationTokenLayer()).pipe(
                  Layer.provide(
                    appJwtJoseLayer({ issuer: String(options.github.appId), privateKey: options.github.privateKey }),
                  ),
                  Layer.provide(httpLayer),
                ),
              ),
              Layer.provide(httpLayer),
              Layer.provide(retainedData),
            ),
      )
      const toolPolicyContext = yield* Layer.build(hostedToolPolicyLayer.pipe(Layer.provide(retainedData)))
      const executorContext = yield* Layer.build(
        executorService.pipe(
          Layer.provide(
            Layer.merge(
              options.executor === undefined ? runnerOnlyControllerLayer : executorLayer(options.executor),
              runnerExecutorLayer,
            ),
          ),
          Layer.provide(
            Layer.succeedContext(
              Context.merge(
                Context.merge(Context.merge(data, environmentContext), repositoryContext),
                toolPolicyContext,
              ),
            ),
          ),
        ),
      )
      const executor = Context.get(executorContext, Executor)
      const workspaceContext = yield* Layer.build(
        hostedWorkspaceLayer.pipe(
          Layer.provide(Layer.succeedContext(Context.merge(Context.merge(data, executorContext), environmentContext))),
        ),
      )
      const executionContext = yield* Layer.build(
        HostedExecution.layerHosted({
          kernel: { runtimeVersion: Bun.version, dataRoot: `${temporaryDirectory}/rika-hosted` },
          openAiAccountAccess: Context.get(credentialContext, HostedProviderCredentials).openAiAccountAccess,
          credentialStore: Layer.succeed(
            ProviderCredentialStore,
            Context.get(credentialContext, ProviderCredentialStore),
          ),
          cells: HostedExecution.remoteCells({
            cells: RemoteCells.layer({
              execute: (request, authority) =>
                executor.run({ ...request, authority }).pipe(
                  Effect.mapError((error) => RemoteCells.Unavailable.make({ message: error.message })),
                  Effect.flatMap((result) =>
                    result.outcome === "unknown"
                      ? RemoteCells.UnknownOutcome.make({ message: "Remote operation outcome is unknown" })
                      : Effect.succeed(result.response),
                  ),
                ),
            }),
            admit: (input) =>
              executor
                .admitRun(input)
                .pipe(Effect.mapError((error) => RemoteCells.AdmissionFailure.make({ message: error.message }))),
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
        Context.merge(Context.merge(Context.merge(data, executionContext), environmentContext), toolPolicyContext),
        Context.merge(Context.merge(credentialContext, modelContext), repositoryContext),
      )
      const recoveryContext = yield* Layer.build(
        hostedRecoveryLayer.pipe(
          Layer.provide(Layer.succeed(TenetRuntime.Runtime, Context.get(executionContext, TenetRuntime.Runtime))),
          Layer.provide(retainedData),
        ),
      )
      const executionReconcilerContext = yield* Layer.build(
        hostedExecutionReconcilerLayer({
          pollIntervalMillis: 250,
        }).pipe(Layer.provide(ProductRepositories.projectionLayer), Layer.provide(Layer.succeedContext(hostedContext))),
      )
      const executionReconciler = Context.get(executionReconcilerContext, HostedExecutionReconciler)
      const projectionWorkerContext = yield* Layer.build(
        hostedProjectionWorkerLayer({
          concurrency: 32,
          pollIntervalMillis: 250,
        }).pipe(Layer.provide(ProductRepositories.projectionLayer), Layer.provide(Layer.succeedContext(hostedContext))),
      )
      const projectionWorker = Context.get(projectionWorkerContext, HostedProjectionWorker)
      const turnWorkerContext = yield* Layer.build(
        hostedTurnWorkerLayer({
          workerId: options.workerId,
          leaseMillis: 120_000,
          pollIntervalMillis: 250,
          concurrency: 32,
        }).pipe(Layer.provide(HostedTurnWorkerStore.layer), Layer.provide(Layer.succeedContext(hostedContext))),
      )
      const turnWorker = Context.get(turnWorkerContext, HostedTurnWorker)
      const executionReadiness = Context.get(executionContext, ExecutionPostgres.Readiness)
      const readiness = ExecutionPostgres.Readiness.of({
        check: Effect.all([
          executionReadiness.check,
          executionReconciler.ready.pipe(
            Effect.mapError((error) => ExecutionPostgres.WorkerUnavailable.make({ message: error.message })),
          ),
          projectionWorker.ready.pipe(
            Effect.mapError((error) => ExecutionPostgres.WorkerUnavailable.make({ message: error.message })),
          ),
          turnWorker.ready.pipe(
            Effect.mapError((error) => ExecutionPostgres.WorkerUnavailable.make({ message: error.message })),
          ),
        ]).pipe(Effect.map(([proof]) => proof)),
        status: Effect.all({
          execution: executionReadiness.status,
          reconciliation: executionReconciler.status,
          turn: turnWorker.status,
          projection: projectionWorker.status,
        }).pipe(Effect.map((status) => ({ ...status.execution, ...status }))),
      })
      const productContext = yield* Layer.build(
        hostedProductLayer({
          ...(options.executor === undefined
            ? {}
            : {
                orb: {
                  templateBuildId: options.executor.templateBuildId,
                  providerScope: options.executor.deploymentId,
                },
              }),
          promptAdmissionReadiness: readiness.check.pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ),
        }).pipe(Layer.provide(Layer.succeedContext(hostedContext))),
      )
      const publicationContext = yield* Layer.build(
        hostedPublicationLayer({ product: Context.get(productContext, HostedProduct), executor }).pipe(
          Layer.provide(Layer.succeedContext(repositoryContext)),
        ),
      )
      const threadApplicationContext = yield* Layer.build(
        hostedThreadApplicationLayer.pipe(Layer.provide(Layer.succeedContext(hostedContext))),
      )
      const threadCommandWorkerContext = yield* Layer.build(
        hostedThreadCommandWorkerLayer({
          claimMillis: 10_000,
          pollIntervalMillis: 250,
          concurrency: 32,
        }).pipe(
          Layer.provide(
            Layer.succeedContext(
              Context.merge(
                Context.merge(hostedContext, Context.merge(productContext, threadApplicationContext)),
                workspaceContext,
              ),
            ),
          ),
        ),
      )
      const threadCommandWorker = Context.get(threadCommandWorkerContext, HostedThreadCommandWorker)
      const placementSql = Context.get(data, PgClient.PgClient)
      const threadProtocolContext = yield* Layer.build(
        hostedThreadProtocolLayer({
          databaseUrl: options.databaseUrl,
          workspacePlacement: workspacePlacement(placementSql),
        }).pipe(
          Layer.provide(
            Layer.succeedContext(
              Context.merge(
                Context.merge(hostedContext, Context.merge(productContext, threadApplicationContext)),
                workspaceContext,
              ),
            ),
          ),
        ),
      )
      return HostedApplication.of({
        product: Context.get(productContext, HostedProduct),
        threadApplication: Context.get(threadApplicationContext, HostedThreadApplication),
        threadProtocol: Context.get(threadProtocolContext, HostedThreadProtocol),
        toolPolicy: Context.get(toolPolicyContext, HostedToolPolicy),
        credentials: Context.get(credentialContext, HostedProviderCredentials),
        environment: Context.get(environmentContext, HostedEnvironment),
        models: Context.get(modelContext, HostedModelRegistry),
        executor,
        recovery: Context.get(recoveryContext, HostedRecovery),
        repositories: Context.get(repositoryContext, HostedRepositories),
        publication: Context.get(publicationContext, HostedPublication),
        executionReconciler,
        projectionWorker,
        turnWorker,
        threadCommandWorker,
        execution: {
          gateway: Context.get(executionContext, ExecutionGateway.Service),
          lifecycle: Context.get(executionContext, ExecutionSessionLifecycle.Service),
          readiness: {
            check: readiness.check.pipe(
              Effect.tap(() =>
                threadCommandWorker.ready.pipe(
                  Effect.mapError((error) => ExecutionPostgres.WorkerUnavailable.make({ message: error.message })),
                ),
              ),
            ),
            status: readiness.status,
          },
        },
      })
    }),
  )
