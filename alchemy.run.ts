import * as Alchemy from "alchemy"
import * as Command from "alchemy/Command"
import * as Docker from "alchemy/Docker"
import * as Output from "alchemy/Output"
import { Effect, Layer, Redacted } from "effect"
import { developmentTemplateSourceDigest } from "./packages/e2b-executor/src/development-template"

process.umask(0o077)
const securedAlchemyState = Bun.spawnSync(["chmod", "-R", "go-rwx", ".alchemy"], {
  stdout: "ignore",
  stderr: "ignore",
})
if (securedAlchemyState.exitCode !== 0 && (await Bun.file(".alchemy").exists()))
  throw new Error("Alchemy state permissions could not be secured")

const publicPort = Number(Bun.env.PORT ?? "3000")
if (!Number.isSafeInteger(publicPort) || publicPort <= 0 || publicPort > 65_535) throw new Error("PORT must be valid")
const publicUrl = Bun.env.PUBLIC_URL?.trim() || `http://localhost:${publicPort}`
const openRouterApiKey = Bun.env.OPENROUTER_API_KEY?.trim()
if (openRouterApiKey === undefined || openRouterApiKey.length === 0) throw new Error("OPENROUTER_API_KEY is required")

const e2bNames = ["E2B_API_KEY", "E2B_APP_ID", "E2B_DEPLOYMENT_ID"] as const
const configuredE2b = Object.fromEntries(
  e2bNames.flatMap((name) => {
    const value = Bun.env[name]?.trim()
    return value === undefined || value.length === 0 ? [] : [[name, value]]
  }),
) as Partial<Record<(typeof e2bNames)[number], string>>
const e2bEnabled = Object.keys(configuredE2b).length === e2bNames.length
if (Object.keys(configuredE2b).length !== 0 && !e2bEnabled)
  throw new Error(`E2B development requires ${e2bNames.join(", ")}`)
const e2b = e2bEnabled ? (configuredE2b as Record<(typeof e2bNames)[number], string>) : undefined
const e2bSourceDigest = e2b === undefined ? undefined : await developmentTemplateSourceDigest(process.cwd())

const providers = Layer.mergeAll(Docker.providers(), Command.providers(), Alchemy.RandomProvider())

export default Alchemy.Stack(
  "Rika",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const postgresPassword = yield* Alchemy.makeRandom("PostgresPassword", { bytes: 24 })
    const authSecret = yield* Alchemy.makeRandom("BetterAuthSecret")
    const providerKeyHex = yield* Alchemy.makeRandom("ProviderCredentialKey")
    const workspaceKeyHex = yield* Alchemy.makeRandom("WorkspaceEncryptionKey")
    const minioSecret = yield* Alchemy.makeRandom("MinioSecret")
    const providerCredentialKey = Output.map(providerKeyHex, (value) =>
      Redacted.make(Buffer.from(Redacted.value(value), "hex").toString("base64")),
    )
    const workspaceEncryptionKey = Output.map(workspaceKeyHex, (value) =>
      Redacted.make(Buffer.from(Redacted.value(value), "hex").toString("base64")),
    )
    const databaseUrl = Output.map(postgresPassword, (password) =>
      Redacted.make(`postgresql://rika:${Redacted.value(password)}@127.0.0.1:15432/rika`),
    )

    const network = yield* Docker.Network("DevelopmentNetwork", { name: "rika-development" })
    const postgresData = yield* Docker.Volume("PostgresData", { name: "rika-development-postgres" })
    const minioData = yield* Docker.Volume("MinioData", { name: "rika-development-minio" })
    const postgres = yield* Docker.Container("Postgres", {
      name: "rika-development-postgres",
      image: "postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94",
      environment: {
        POSTGRES_DB: "rika",
        POSTGRES_USER: "rika",
        POSTGRES_PASSWORD: postgresPassword,
      },
      ports: [{ external: "127.0.0.1:15432", internal: 5432 }],
      volumes: [{ hostPath: postgresData.name, containerPath: "/var/lib/postgresql/data" }],
      networks: [{ name: network.name }],
      healthcheck: { cmd: "pg_isready -U rika -d rika", interval: "1 second", retries: 30 },
      restart: "unless-stopped",
      start: true,
    })
    const minio = yield* Docker.Container("Minio", {
      name: "rika-development-minio",
      image: "minio/minio@sha256:d249d1fb6966de4d8ad26c04754b545205ff15a62e4fd19ebd0f26fa5baacbc0",
      command: ["server", "/data"],
      environment: {
        MINIO_ROOT_USER: "rika-development",
        MINIO_ROOT_PASSWORD: minioSecret,
      },
      ports: [{ external: "127.0.0.1:19000", internal: 9000 }],
      volumes: [{ hostPath: minioData.name, containerPath: "/data" }],
      networks: [{ name: network.name }],
      restart: "unless-stopped",
      start: true,
    })

    const containersReady = yield* Command.Exec("WaitForDevelopmentServices", {
      command: "bun scripts/development/wait-for-services.ts",
      env: {
        DATABASE_URL: databaseUrl,
        RIKA_DEV_OBJECT_STORE_URL: "http://127.0.0.1:19000",
        RIKA_DEV_POSTGRES_CONTAINER: Output.map(Output.of(postgres), () => "ready"),
        RIKA_DEV_MINIO_CONTAINER: Output.map(Output.of(minio), () => "ready"),
      },
      memo: false,
      timeout: "1 minute",
    })
    const serviceDependency = Output.map(Output.of(containersReady), () => "ready")
    const migrations = yield* Command.Exec("MigrateDevelopmentDatabase", {
      command: "bun --cwd apps/api migrate",
      env: {
        NODE_ENV: "development",
        DATABASE_URL: databaseUrl,
        DATABASE_SSL: "disable",
        RIKA_DEV_SERVICES: serviceDependency,
      },
      memo: false,
      timeout: "2 minutes",
    })
    const objectStore = yield* Command.Exec("InitializeDevelopmentObjectStore", {
      command: "bun scripts/development/initialize-object-store.ts",
      env: {
        AWS_ACCESS_KEY_ID: "rika-development",
        AWS_SECRET_ACCESS_KEY: minioSecret,
        AWS_REGION: "us-east-1",
        RIKA_DEV_OBJECT_STORE_URL: "http://127.0.0.1:19000",
        RIKA_WORKSPACE_CHECKPOINT_BUCKET: "rika-development",
        RIKA_DEV_SERVICES: serviceDependency,
      },
      memo: false,
      timeout: "1 minute",
    })
    const executorTemplate =
      e2b === undefined
        ? undefined
        : yield* Command.Exec("EnsureDevelopmentExecutorTemplate", {
            command: "bun packages/e2b-executor/scripts/ensure-development-template.ts",
            env: {
              E2B_API_KEY: Redacted.make(e2b.E2B_API_KEY),
              RIKA_DEV_E2B_SOURCE_DIGEST: e2bSourceDigest!,
              RIKA_DEV_E2B_IDENTITY_PATH: ".alchemy/e2b-development-template.json",
              RIKA_DEV_REPOSITORY_ROOT: process.cwd(),
            },
            memo: false,
            timeout: "30 minutes",
          })

    const proxy = yield* Command.Dev("DevelopmentProxy", {
      command: "bun scripts/development/caddy.ts",
      env: {
        PUBLIC_URL: publicUrl,
        PUBLIC_PORT: String(publicPort),
        API_PORT: "3001",
        WEB_PORT: "3002",
        EXECUTOR_PORT: "3003",
      },
    })

    const apiEnvironment = {
      NODE_ENV: "development",
      PORT: "3001",
      DATABASE_URL: databaseUrl,
      DATABASE_SSL: "disable",
      BETTER_AUTH_URL: publicUrl,
      BETTER_AUTH_TRUSTED_ORIGINS: publicUrl,
      BETTER_AUTH_SECRET: authSecret,
      RIKA_PROVIDER_CREDENTIAL_KEY: providerCredentialKey,
      RIKA_DEV_SEED: "1",
      RIKA_DEV_OPENROUTER_API_KEY: Redacted.make(openRouterApiKey),
      ...(Bun.env.RIKA_DEV_MODEL?.trim() === undefined ? {} : { RIKA_DEV_MODEL: Bun.env.RIKA_DEV_MODEL.trim() }),
      AWS_ACCESS_KEY_ID: "rika-development",
      AWS_SECRET_ACCESS_KEY: minioSecret,
      AWS_REGION: "us-east-1",
      RIKA_DEV_MIGRATIONS: Output.map(Output.of(migrations), () => "ready"),
      RIKA_DEV_OBJECT_STORE: Output.map(Output.of(objectStore), () => "ready"),
      ...(e2b === undefined
        ? {}
        : {
            E2B_API_KEY: Redacted.make(e2b.E2B_API_KEY),
            E2B_APP_ID: e2b.E2B_APP_ID,
            E2B_DEPLOYMENT_ID: e2b.E2B_DEPLOYMENT_ID,
            RIKA_DEV_E2B_SOURCE_DIGEST: e2bSourceDigest!,
            RIKA_DEV_E2B_IDENTITY_PATH: ".alchemy/e2b-development-template.json",
            RIKA_DEV_E2B_TEMPLATE_READY: Output.map(Output.of(executorTemplate!), () => "ready"),
            RIKA_DEV_EXECUTOR_ORIGIN: "http://127.0.0.1:3003",
            RIKA_DEV_PROXY: Output.map(Output.of(proxy), () => "ready"),
            RIKA_WORKSPACE_CHECKPOINT_BUCKET: "rika-development",
            RIKA_WORKSPACE_CHECKPOINT_REGION: "us-east-1",
            RIKA_WORKSPACE_CHECKPOINT_ENDPOINT: "http://127.0.0.1:19000",
            RIKA_WORKSPACE_ENCRYPTION_KEY: workspaceEncryptionKey,
            RIKA_WORKSPACE_SETUP_CACHE: "false",
          }),
    }
    yield* Command.Dev("Api", {
      command: "bun scripts/development/api.ts",
      env: apiEnvironment,
    })

    const webBuild = yield* Command.Build("WebBuild", {
      command: "bun run build",
      cwd: "apps/web",
      outdir: "dist",
    })
    yield* Command.Dev("Web", {
      command: "bun dist/server/main.js",
      cwd: "apps/web",
      env: {
        NODE_ENV: "development",
        PORT: "3002",
        API_DOMAIN: "127.0.0.1",
        API_PORT: "3001",
        RIKA_DEV_WEB_BUILD: Output.map(webBuild.hash.output, (hash) => hash ?? "built"),
      },
    })

    return { url: publicUrl, orbExecution: e2bEnabled }
  }),
)
