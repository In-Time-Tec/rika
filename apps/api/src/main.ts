import { BunCrypto } from "@effect/platform-bun"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as PgClient from "@effect/sql-pg/PgClient"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Console, Context, Effect, Layer, Redacted } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import {
  closePostgresPool,
  makeBetterAuthIdentityRuntime,
  makePostgresCliDeviceDirectory,
  makePostgresIdentityDirectory,
  makePostgresPool,
  makeResendMailSender,
  noOpMailSender,
} from "@rika/identity"
import { serveApi } from "./server/bun"
import { loadApiConfig } from "./config/api"
import { seedDevelopment } from "./development/seed"
import { HostedApplication, layer as hostedApplicationLayer } from "./hosted/application"

type MutableHostedApplicationOptions = {
  -readonly [Key in keyof Parameters<typeof hostedApplicationLayer>[0]]: Parameters<
    typeof hostedApplicationLayer
  >[0][Key]
}

const program = Effect.scoped(
  Effect.gen(function* () {
    const loaded = yield* loadApiConfig(Bun.env)
    const {
      developmentSeedEnabled,
      developmentModel,
      environment,
      identity: config,
      executor: executorOptions,
      github,
      providerCredentialKey,
    } = loaded
    const httpClient = yield* HttpClient.HttpClient
    const pool = makePostgresPool(config)
    yield* Effect.addFinalizer(() => closePostgresPool(pool).pipe(Effect.ignore))
    const identity = makeBetterAuthIdentityRuntime({
      config,
      pool,
      mail:
        config.mail === undefined ? noOpMailSender : makeResendMailSender({ config: config.mail, client: httpClient }),
    })
    const postgres = {
      url: config.databaseUrl,
      ssl: config.databaseSsl === "disable" ? false : { rejectUnauthorized: config.databaseSsl === "verify-full" },
      maxConnections: 10,
    }
    const postgresContext = yield* Layer.build(PgClient.layer(postgres))
    const identityDatabase = yield* PgDrizzle.makeWithDefaults().pipe(Effect.provideContext(postgresContext))
    const applicationOptions: MutableHostedApplicationOptions = {
      database: postgres,
      databaseUrl: config.databaseUrl,
      providerCredentialKey,
      workerId: environment.RAILWAY_DEPLOYMENT_ID ?? executorOptions?.deploymentId ?? "rika-development",
    }
    if (executorOptions !== undefined) applicationOptions.executor = executorOptions
    if (github !== undefined) applicationOptions.github = github
    if (developmentModel !== undefined) applicationOptions.developmentModel = developmentModel
    const application = Context.get(yield* Layer.build(hostedApplicationLayer(applicationOptions)), HostedApplication)
    if (developmentSeedEnabled) {
      const openRouterApiKey = environment.RIKA_DEV_OPENROUTER_API_KEY?.trim()
      if (openRouterApiKey === undefined || openRouterApiKey.length === 0)
        return yield* Effect.die("RIKA_DEV_OPENROUTER_API_KEY is required in development")
      yield* seedDevelopment({
        baseUrl: config.baseUrl,
        database: identityDatabase,
        identity,
        pool,
        product: application.product,
        credentials: application.credentials,
        openRouterApiKey: Redacted.make(openRouterApiKey),
      })
    }
    const dependencies = {
      identity,
      directory: makePostgresIdentityDirectory(identityDatabase),
      devices: makePostgresCliDeviceDirectory(identityDatabase),
      product: application.product,
      threads: application.threadProtocol,
      threadApplication: application.threadApplication,
      credentials: application.credentials,
      environment: application.environment,
      models: application.models,
      recovery: application.recovery,
      publication: application.publication,
      executor: application.executor,
      execution: application.execution.readiness,
      production: config.production,
    }
    if (application.workspaceSeeds !== undefined)
      Object.assign(dependencies, { workspaceSeeds: application.workspaceSeeds })
    yield* serveApi({
      config,
      dependencies,
    })
    yield* Console.log(`Rika API listening on port ${config.port}`)
    return yield* Effect.never
  }),
)

BunRuntime.runMain(program.pipe(Effect.provide(Layer.merge(FetchHttpClient.layer, BunCrypto.layer))))
