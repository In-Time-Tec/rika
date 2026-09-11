import {
  closePostgresPool,
  identityRuntimeLayer,
  IdentityRuntimeService,
  makePostgresCliDeviceDirectory,
  makePostgresIdentityDirectory,
  makePostgresPool,
  makeResendMailSender,
  noOpMailSender,
  type CliDeviceDirectory,
  type IdentityDirectory,
  type IdentityRuntime,
} from "@rika/identity"
import { AuthorizationPolicy } from "@rika/product/hosted-authorization"
import { HostedClientAuthority, type HostedClientAuthorityService } from "@rika/product/hosted-client-authority"
import type { ExecutorPolicy } from "@rika/product/executor-policy"
import { ExecutorTransportError, type WorkspaceExecutorService } from "@rika/execution"
import { makeBoxAssignmentRepository, type BoxAssignmentRepository } from "@rika/product-store/box-assignments"
import { layer as clientAuthorityLayer } from "@rika/product-store/client-authority"
import { clientLayer } from "@rika/product-store/postgres"
import {
  layer as repositoryStoreLayer,
  RepositoryStore,
  type RepositoryStoreService,
} from "@rika/product-store/repositories"
import {
  make as makeProviderCredentialOperations,
  type ProviderCredentialOperations,
} from "@rika/product-store/provider-credentials"
import {
  layer as productRepositoryLayer,
  ProductRepository,
  type ProductRepositoryService,
} from "@rika/product-store/product-repository"
import {
  layer as runnerRegistrationsLayer,
  RunnerRegistrations,
  type RunnerRegistrationsService,
} from "@rika/product-store/runner-registrations"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Context, Crypto, Effect, Function, Layer, Redacted, Schema, type Scope } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import type { ApiV2LocalServerOptions } from "../transport/local-host"
import { serveApiV2LocalHost, type ApiV2LocalServer } from "../transport/local-host"
import * as RunnerGatewayModule from "../executor/runner-gateway"
import type { RunnerGateway } from "../executor/runner-gateway"
import * as ExecutorBinding from "../executor/binding"
import * as ProductAuthority from "../product/authority"
import type { ProductAuthorizationError, RepositoryProductAuthorityService } from "../product/authority"
import * as ProductControl from "../product/control"
import type { ProductControlOptions } from "../product/control"
import type { WorkspaceSeedService } from "../product/workspace-seeds"
import type { RuntimeActorOptions } from "../runtime/rivet-actor"
import type { ApiV2ContextComposition } from "../runtime/host"
import type { ThreadExecutionBinding, ThreadPartition } from "../runtime/partition"
import {
  runtimeStorageFromContext,
  runtimeStorageLayer,
  type RuntimeStorage,
  type RuntimeStorageOptions,
} from "../runtime/storage"
import type { ApiV2ProductionConfig } from "./config"

export class ApiV2ProductionStartupError extends Schema.TaggedError<ApiV2ProductionStartupError>()(
  "RikaApiV2ProductionStartupError",
  {
    dependency: Schema.Literals(["database", "identity", "runtime-storage", "composition", "rivet", "server"]),
    message: Schema.String,
  },
) {}

export interface ApiV2ProductionDependencies {
  readonly context: ApiV2ProductionContextFactory
  readonly orbWorkspace: RuntimeActorOptions["workspace"]
  readonly boxGateway: RunnerGateway
  readonly executorPolicy: ExecutorPolicy
  readonly repositories: ProductControlOptions["repositories"]
  readonly productPlacement: NonNullable<ProductControlOptions["orb"]>
  readonly workspaceSeeds: WorkspaceSeedService
}

export interface ApiV2ProductionContextInput {
  readonly partition: ThreadPartition
  readonly binding: ThreadExecutionBinding
  readonly workspace: WorkspaceExecutorService
  readonly rebindWorkspace: Parameters<RuntimeActorOptions["context"]>[0]["rebindWorkspace"]
}

export type ApiV2ProductionContextFactory = (
  input: ApiV2ProductionContextInput,
) => Effect.Effect<ApiV2ContextComposition, ProductAuthorizationError, Scope.Scope>

export interface ApiV2ProductionPersistence {
  readonly identity: IdentityRuntime
  readonly directory: IdentityDirectory
  readonly devices: CliDeviceDirectory
  readonly product: ProductRepositoryService
  readonly clientAuthority: HostedClientAuthorityService
  readonly runners: RunnerRegistrationsService
  readonly boxAssignments: BoxAssignmentRepository
  readonly providerCredentials: ProviderCredentialOperations
  readonly repositoryBindings: Pick<RepositoryStoreService, "loadBinding">
}

export interface ApiV2ProductionServices extends ApiV2ProductionPersistence {
  readonly crypto: Crypto.Crypto
}

export interface ApiV2ProductionComposition {
  readonly authority: RepositoryProductAuthorityService
  readonly runnerGateway: RunnerGateway
  readonly options: ApiV2LocalServerOptions
}

export interface ApiV2ProductionApi extends ApiV2ProductionComposition {
  readonly server: ApiV2LocalServer
}

export type ApiV2ProductionDependenciesFactory = (
  services: ApiV2ProductionServices,
) => Effect.Effect<ApiV2ProductionDependencies, ApiV2ProductionStartupError, Scope.Scope>

type AcquireProductionServices = (
  config: ApiV2ProductionConfig,
) => Effect.Effect<ApiV2ProductionPersistence, ApiV2ProductionStartupError, Scope.Scope>

type StartupDependency = ApiV2ProductionStartupError["dependency"]

const startupError = (dependency: StartupDependency) =>
  ApiV2ProductionStartupError.make({ dependency, message: `${dependency} initialization failed` })

const sanitize = <A, E, R>(
  dependency: StartupDependency,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, ApiV2ProductionStartupError, R> =>
  effect.pipe(Effect.catchCause(() => Effect.fail(startupError(dependency))))

const postgresConfig = (config: ApiV2ProductionConfig) => ({
  url: config.identity.databaseUrl,
  ssl:
    config.identity.databaseSsl === "disable"
      ? false
      : { rejectUnauthorized: config.identity.databaseSsl === "verify-full" },
  maxConnections: 10,
  applicationName: "rika-api-v2",
})

const storageOptions = (config: ApiV2ProductionConfig): RuntimeStorageOptions => {
  const options: RuntimeStorageOptions = {
    bucket: config.runtimeStorage.bucket,
    region: config.runtimeStorage.region,
  }
  if (config.runtimeStorage.endpoint !== undefined) {
    Object.assign(options, {
      endpoint: config.runtimeStorage.endpoint,
      // A configured endpoint attests the deployment's chosen object store. The Railway/Tigris
      // bucket guarantees conditional create, strong reads, and consistent listing.
      capabilities: { conditionalCreate: true, strongReadAfterWrite: true, consistentListing: true },
    })
  }
  if (config.runtimeStorage.forcePathStyle !== undefined)
    Object.assign(options, { forcePathStyle: config.runtimeStorage.forcePathStyle })
  if (config.runtimeStorage.credentials !== undefined) {
    const credentials = {
      accessKeyId: Redacted.value(config.runtimeStorage.credentials.accessKeyId),
      secretAccessKey: Redacted.value(config.runtimeStorage.credentials.secretAccessKey),
    }
    if (config.runtimeStorage.credentials.sessionToken !== undefined)
      Object.assign(credentials, { sessionToken: Redacted.value(config.runtimeStorage.credentials.sessionToken) })
    Object.assign(options, { credentials })
  }
  return options
}

export const acquireApiV2ProductionServices: AcquireProductionServices = Effect.fn(
  "Rika.ApiV2Production.acquireServices",
)(function* (config: ApiV2ProductionConfig) {
  const stores = yield* sanitize(
    "database",
    Layer.build(
      Layer.mergeAll(productRepositoryLayer, clientAuthorityLayer, runnerRegistrationsLayer, repositoryStoreLayer).pipe(
        Layer.provideMerge(clientLayer(postgresConfig(config))),
      ),
    ),
  )
  const identityDatabase = yield* PgDrizzle.makeWithDefaults().pipe(Effect.provide(stores))
  const boxAssignments = yield* makeBoxAssignmentRepository.pipe(Effect.provide(stores))
  const providerCredentials = yield* makeProviderCredentialOperations.pipe(Effect.provide(stores))
  const identityPool = yield* sanitize(
    "database",
    Effect.sync(() => makePostgresPool(config.identity)),
  )
  yield* Effect.addFinalizer(() => closePostgresPool(identityPool).pipe(Effect.ignore))
  const http = Context.get(yield* Layer.build(FetchHttpClient.layer), HttpClient.HttpClient)
  const mail =
    config.identity.mail === undefined
      ? noOpMailSender
      : makeResendMailSender({ config: config.identity.mail, client: http })
  const identity = Context.get(
    yield* sanitize(
      "identity",
      Effect.suspend(() => Layer.build(identityRuntimeLayer({ config: config.identity, pool: identityPool, mail }))),
    ),
    IdentityRuntimeService,
  )
  const directory = makePostgresIdentityDirectory(identityDatabase)
  const product = Context.get(stores, ProductRepository)
  yield* sanitize("database", Effect.all([directory.ready, product.ready], { concurrency: 2, discard: true }))
  return {
    identity,
    directory,
    devices: makePostgresCliDeviceDirectory(identityDatabase),
    product,
    clientAuthority: Context.get(stores, HostedClientAuthority),
    runners: Context.get(stores, RunnerRegistrations),
    boxAssignments,
    providerCredentials,
    repositoryBindings: Context.get(stores, RepositoryStore),
  }
})

const makeApiV2ProductionCompositionImpl = Effect.fn("Rika.ApiV2Production.compose")(function* (
  config: ApiV2ProductionConfig,
  dependencies: ApiV2ProductionDependencies,
  services: ApiV2ProductionServices,
  storage: RuntimeStorage,
) {
  const binding = ExecutorBinding.makeThreadBindingReader({
    product: services.product,
    environment: config.environment,
  })
  const authority = ProductAuthority.makeRepositoryProductAuthority({
    identity: services.identity,
    devices: services.devices,
    product: services.product,
    clientAuthority: services.clientAuthority,
    crypto: services.crypto,
    environment: config.environment,
    binding: (input) =>
      binding(input).pipe(
        Effect.flatMap((value) =>
          value === undefined
            ? ProductAuthority.ProductAuthorizationError.make({
                kind: "invalid",
                message: "Thread execution binding is unavailable",
              })
            : Effect.succeed(value),
        ),
      ),
  })
  const product = ProductControl.makeProductControl({
    executorPolicy: dependencies.executorPolicy,
    product: services.product,
    runners: services.runners,
    clientAuthority: services.clientAuthority,
    authorization: Context.get(yield* Layer.build(AuthorizationPolicy.layer), AuthorizationPolicy),
    crypto: services.crypto,
    repositories: dependencies.repositories,
    orb: dependencies.productPlacement,
  })
  const runnerGateway = yield* RunnerGatewayModule.makeRunnerGateway({
    identity: services.identity,
    directory: services.directory,
    devices: services.devices,
    product: services.product,
    environment: config.environment,
  })
  const workspace: RuntimeActorOptions["workspace"] = (execution) =>
    execution.placement._tag === "Runner"
      ? Effect.succeed(runnerGateway.executor(execution.workspaceBinding))
      : dependencies
          .orbWorkspace(execution)
          .pipe(
            Effect.mapError(() =>
              ExecutorTransportError.make({ phase: "connection", message: "Workspace Executor is unavailable" }),
            ),
          )
  const context: RuntimeActorOptions["context"] = dependencies.context
  const registry: NonNullable<RuntimeActorOptions["registry"]> = {
    runtime: "native",
    endpoint: config.rivet.endpoint,
    namespace: config.rivet.namespace,
    startEngine: false,
    startServices: false,
    noWelcome: true,
  }
  const options: ApiV2LocalServerOptions = {
    authority,
    product: authority.product,
    productControl: {
      identity: services.identity,
      directory: services.directory,
      devices: services.devices,
      product,
    },
    workspaceSeeds: {
      identity: services.identity,
      directory: services.directory,
      devices: services.devices,
      workspaceSeeds: dependencies.workspaceSeeds,
    },
    runnerGateway,
    boxGateway: dependencies.boxGateway,
    environment: config.environment,
    storage,
    revision: config.revision,
    workspace,
    context,
    registry,
    rivetEndpoint: config.rivet.endpoint,
    rivetNamespace: config.rivet.namespace,
    port: config.port,
    hostname: config.hostname,
    publicUrl: config.identity.baseUrl,
  }
  if (config.rivet.token !== undefined) {
    const token = Redacted.value(config.rivet.token)
    Object.assign(registry, { token })
    Object.assign(options, { rivetToken: token })
  }
  return { authority, runnerGateway, options }
})

export const makeApiV2ProductionComposition: {
  (
    dependencies: ApiV2ProductionDependencies,
    services: ApiV2ProductionServices,
    storage: RuntimeStorage,
  ): (config: ApiV2ProductionConfig) => Effect.Effect<ApiV2ProductionComposition, never, Scope.Scope>
  (
    config: ApiV2ProductionConfig,
    dependencies: ApiV2ProductionDependencies,
    services: ApiV2ProductionServices,
    storage: RuntimeStorage,
  ): Effect.Effect<ApiV2ProductionComposition, never, Scope.Scope>
} = Function.dual(4, makeApiV2ProductionCompositionImpl)

export const resolveApiV2ProductionDependencies = Effect.fn("Rika.ApiV2Production.resolveDependencies")(
  function* (input: {
    readonly factory: ApiV2ProductionDependenciesFactory
    readonly services: ApiV2ProductionServices
  }): Effect.fn.Return<ApiV2ProductionDependencies, ApiV2ProductionStartupError, Scope.Scope> {
    return yield* sanitize(
      "composition",
      Effect.suspend(() => input.factory(input.services)),
    )
  },
)

const makeProductionApiImpl = Effect.fn("Rika.ApiV2Production.make")(function* (
  config: ApiV2ProductionConfig,
  dependencyFactory: ApiV2ProductionDependenciesFactory,
) {
  const runtimeStorageContext = yield* sanitize(
    "runtime-storage",
    Layer.build(runtimeStorageLayer(storageOptions(config))),
  )
  const persistence = yield* acquireApiV2ProductionServices(config)
  const services: ApiV2ProductionServices = {
    ...persistence,
    crypto: Context.get(runtimeStorageContext, Crypto.Crypto),
  }
  const dependencies = yield* resolveApiV2ProductionDependencies({ factory: dependencyFactory, services })
  const composition = yield* makeApiV2ProductionComposition(
    config,
    dependencies,
    services,
    runtimeStorageFromContext(runtimeStorageContext),
  )
  const server = yield* Effect.acquireRelease(sanitize("server", serveApiV2LocalHost(composition.options)), (current) =>
    Effect.tryPromise(() => current.close()).pipe(Effect.ignore),
  )
  yield* sanitize(
    "rivet",
    Effect.tryPromise(() => server.registry.startAndWait()),
  )
  return { ...composition, server }
})

export const makeProductionApi: {
  (
    dependencyFactory: ApiV2ProductionDependenciesFactory,
  ): (config: ApiV2ProductionConfig) => Effect.Effect<ApiV2ProductionApi, ApiV2ProductionStartupError, Scope.Scope>
  (
    config: ApiV2ProductionConfig,
    dependencyFactory: ApiV2ProductionDependenciesFactory,
  ): Effect.Effect<ApiV2ProductionApi, ApiV2ProductionStartupError, Scope.Scope>
} = Function.dual(2, makeProductionApiImpl)
