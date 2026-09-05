import * as Alchemy from "alchemy"
import * as Command from "alchemy/Command"
import * as Docker from "alchemy/Docker"
import * as Output from "alchemy/Output"
import * as Provider from "alchemy/Provider"
import { Bucket as RailwayBucket } from "alchemy/Railway/Bucket"
import { Postgres as RailwayPostgres } from "alchemy/Railway/Postgres"
import { Project as RailwayProject } from "alchemy/Railway/Project"
import { providers as railwayProviders } from "alchemy/Railway/Providers"
import { Service as RailwayService } from "alchemy/Railway/Service"
import { ref as railwayRef } from "alchemy/Railway/ref"
import { Effect, Layer, Redacted } from "effect"
import { developmentTemplateSourceDigest } from "./packages/e2b-executor/src/development-template"
const pathIs = (flag: "-L" | "-f", path: string) =>
  Bun.spawnSync(["test", flag, path], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
process.umask(0o077)
if (pathIs("-L", ".alchemy") || pathIs("-L", ".alchemy/rika-dev-stage"))
  throw new Error("Alchemy identity paths must not be symbolic links")
const target = Bun.env.RIKA_ALCHEMY_TARGET?.trim() || "local"
if (target !== "local" && target !== "railway") throw new Error("RIKA_ALCHEMY_TARGET must be local or railway")
const operation = Bun.env.RIKA_ALCHEMY_OPERATION?.trim() || (target === "local" ? "local" : "remote")
if (operation !== "local" && operation !== "remote" && operation !== "destroy")
  throw new Error("RIKA_ALCHEMY_OPERATION must be local, remote, or destroy")
if ((target === "local") !== (operation === "local")) throw new Error("Alchemy target and operation do not match")
const personalRailwayStagePattern = /^dev-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const personalRailwayIdentity = ".alchemy/rika-dev-stage"
const personalRailwayIdentityIsFile =
  target === "railway" && pathIs("-f", personalRailwayIdentity) && !pathIs("-L", personalRailwayIdentity)
const personalRailwayStage = personalRailwayIdentityIsFile
  ? (await Bun.file(personalRailwayIdentity).text()).trim()
  : undefined
if (target === "railway" && !personalRailwayStagePattern.test(personalRailwayStage ?? ""))
  throw new Error("Railway operations require the generated .alchemy/rika-dev-stage UUIDv4 identity")
const protectedAlchemyPaths = [
  ".alchemy",
  personalRailwayIdentity,
  ".alchemy/state",
  ".alchemy/state/Rika",
  ...(personalRailwayStage === undefined
    ? []
    : [`.alchemy/state/Rika/${personalRailwayStage}`, `.alchemy/state/Rika/${personalRailwayStage}/Project.json`]),
]
if (protectedAlchemyPaths.some((path) => pathIs("-L", path)))
  throw new Error("Alchemy identity and state paths must not be symbolic links")
const securedAlchemyState = Bun.spawnSync(["chmod", "-R", "go-rwx", ".alchemy"], {
  stdout: "ignore",
  stderr: "ignore",
})
if (securedAlchemyState.exitCode !== 0 && (await Bun.file(".alchemy").exists()) === true)
  throw new Error("Alchemy state permissions could not be secured")

const readRequired = (group: string, name: string) => {
  const value = Bun.env[name]?.trim()
  if (value === undefined || value.length === 0) throw new Error(`${group} requires ${name}`)
  return value
}

const requireOutput = <T, Req>(name: string, output: Output.Output<T | undefined, Req>, destroyValue: T) =>
  Output.map(output, (value) => {
    if (value !== undefined) return value
    if (operation === "destroy") return destroyValue
    throw new Error(`Railway did not return ${name}`)
  })

const railwayInputs =
  target !== "railway" || operation === "destroy"
    ? undefined
    : {
        provisioning: {
          RAILWAY_WORKSPACE_ID: readRequired("Railway provisioning", "RAILWAY_WORKSPACE_ID"),
        },
        githubOauth: {
          GITHUB_CLIENT_ID: readRequired("GitHub OAuth", "GITHUB_CLIENT_ID"),
          GITHUB_CLIENT_SECRET: readRequired("GitHub OAuth", "GITHUB_CLIENT_SECRET"),
        },
        githubApp: {
          GITHUB_APP_ID: readRequired("GitHub App", "GITHUB_APP_ID"),
          GITHUB_APP_PRIVATE_KEY: readRequired("GitHub App", "GITHUB_APP_PRIVATE_KEY"),
        },
        mail: {
          RESEND_API_KEY: readRequired("Email", "RESEND_API_KEY"),
          EMAIL_FROM: readRequired("Email", "EMAIL_FROM"),
        },
        e2b: {
          E2B_API_KEY: readRequired("Remote E2B", "E2B_API_KEY"),
          E2B_TEMPLATE_ID: readRequired("Remote E2B", "E2B_TEMPLATE_ID"),
          E2B_TEMPLATE_BUILD_ID: readRequired("Remote E2B", "E2B_TEMPLATE_BUILD_ID"),
        },
      }

const publicPort = target === "local" ? Number(Bun.env.PORT ?? "3000") : 3000
if (!Number.isSafeInteger(publicPort) || publicPort <= 0 || publicPort > 65_532)
  throw new Error("PORT must leave three consecutive ports available")
const apiPort = publicPort + 1
const webPort = publicPort + 2
const executorPort = publicPort + 3
const publicUrl = Bun.env.PUBLIC_URL?.trim() || `http://localhost:${publicPort}`
const openRouterApiKey = target === "local" ? Bun.env.OPENROUTER_API_KEY?.trim() : "unused"
if (openRouterApiKey === undefined || openRouterApiKey.length === 0) throw new Error("OPENROUTER_API_KEY is required")

const readLocal = (name: string) => {
  if (target !== "local") return undefined
  const value = Bun.env[name]?.trim()
  return value === undefined || value.length === 0 ? undefined : value
}
const e2bApiKey = readLocal("E2B_API_KEY")
const e2bAppId = readLocal("E2B_APP_ID")
const e2bDeploymentId = readLocal("E2B_DEPLOYMENT_ID")
const e2bConfigured = e2bApiKey !== undefined || e2bAppId !== undefined || e2bDeploymentId !== undefined
const e2bEnabled = e2bApiKey !== undefined && e2bAppId !== undefined && e2bDeploymentId !== undefined
if (e2bConfigured && !e2bEnabled) throw new Error("E2B development requires E2B_API_KEY, E2B_APP_ID, E2B_DEPLOYMENT_ID")
const e2b =
  e2bApiKey === undefined || e2bAppId === undefined || e2bDeploymentId === undefined
    ? undefined
    : {
        apiKey: e2bApiKey,
        appId: e2bAppId,
        deploymentId: e2bDeploymentId,
        sourceDigest: await developmentTemplateSourceDigest(process.cwd()),
      }

const dockerProviders = Layer.effect(
  Docker.Providers,
  Provider.collection([Docker.Container, Docker.Network, Docker.RemoteImage, Docker.Volume]),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      Docker.ContainerProvider(),
      Docker.NetworkProvider(),
      Docker.RemoteImageProvider(),
      Docker.VolumeProvider(),
    ),
  ),
  Layer.provideMerge(Docker.DockerLive),
)
const providers = dockerProviders.pipe(
  Layer.provideMerge(Layer.mergeAll(Command.providers(), Alchemy.RandomProvider())),
)

const localStack = Alchemy.Stack(
  "Rika",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const postgresPassword = yield* Alchemy.makeRandom("PostgresPassword", { bytes: 24 })
    const authSecret = Output.map(yield* Alchemy.makeRandom("BetterAuthSecret"), (value) =>
      Redacted.make(`0123456789abcdef${Redacted.value(value)}`),
    )
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

    const services = yield* Command.Exec("PrepareDevelopmentServices", {
      command: "bun scripts/development/prepare.ts",
      env: {
        DATABASE_URL: databaseUrl,
        AWS_ACCESS_KEY_ID: "rika-development",
        AWS_SECRET_ACCESS_KEY: minioSecret,
        AWS_REGION: "us-east-1",
        RIKA_WORKSPACE_CHECKPOINT_BUCKET: "rika-development",
        RIKA_DEV_OBJECT_STORE_URL: "http://127.0.0.1:19000",
        RIKA_DEV_POSTGRES_CONTAINER: Output.map(Output.of(postgres), () => "ready"),
        RIKA_DEV_MINIO_CONTAINER: Output.map(Output.of(minio), () => "ready"),
      },
      memo: false,
      timeout: "2 minutes",
    })
    const serviceDependency = Output.map(Output.of(services), () => "ready")
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
    const executorTemplate =
      e2b === undefined
        ? undefined
        : yield* Command.Exec("EnsureDevelopmentExecutorTemplate", {
            command: "bun packages/e2b-executor/scripts/ensure-development-template.ts",
            env: {
              E2B_API_KEY: Redacted.make(e2b.apiKey),
              RIKA_DEV_E2B_SOURCE_DIGEST: e2b.sourceDigest,
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
        API_PORT: String(apiPort),
        WEB_PORT: String(webPort),
        EXECUTOR_PORT: String(executorPort),
      },
    })

    const apiEnvironmentBase = {
      NODE_ENV: "development",
      PORT: String(apiPort),
      DATABASE_URL: databaseUrl,
      DATABASE_SSL: "disable",
      BETTER_AUTH_URL: publicUrl,
      BETTER_AUTH_TRUSTED_ORIGINS: publicUrl,
      BETTER_AUTH_SECRET: authSecret,
      RIKA_PROVIDER_CREDENTIAL_KEY: providerCredentialKey,
      RIKA_DEV_SEED: "1",
      RIKA_DEV_OPENROUTER_API_KEY: Redacted.make(openRouterApiKey),
      AWS_ACCESS_KEY_ID: "rika-development",
      AWS_SECRET_ACCESS_KEY: minioSecret,
      AWS_REGION: "us-east-1",
      RIKA_DEV_MIGRATIONS: Output.map(Output.of(migrations), () => "ready"),
    }
    const developmentModel = Bun.env.RIKA_DEV_MODEL?.trim()
    const modelEnvironment =
      developmentModel === undefined ? apiEnvironmentBase : { ...apiEnvironmentBase, RIKA_DEV_MODEL: developmentModel }
    const apiEnvironment =
      e2b === undefined || executorTemplate === undefined
        ? modelEnvironment
        : {
            ...modelEnvironment,
            E2B_API_KEY: Redacted.make(e2b.apiKey),
            E2B_APP_ID: e2b.appId,
            E2B_DEPLOYMENT_ID: e2b.deploymentId,
            RIKA_DEV_E2B_SOURCE_DIGEST: e2b.sourceDigest,
            RIKA_DEV_E2B_IDENTITY_PATH: ".alchemy/e2b-development-template.json",
            RIKA_DEV_E2B_TEMPLATE_READY: Output.map(Output.of(executorTemplate), () => "ready"),
            RIKA_DEV_EXECUTOR_ORIGIN: `http://127.0.0.1:${executorPort}`,
            RIKA_DEV_PROXY: Output.map(Output.of(proxy), () => "ready"),
            RIKA_WORKSPACE_CHECKPOINT_BUCKET: "rika-development",
            RIKA_WORKSPACE_CHECKPOINT_REGION: "us-east-1",
            RIKA_WORKSPACE_CHECKPOINT_ENDPOINT: "http://127.0.0.1:19000",
            RIKA_WORKSPACE_ENCRYPTION_KEY: workspaceEncryptionKey,
            RIKA_WORKSPACE_SETUP_CACHE: "false",
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
        PORT: String(webPort),
        API_DOMAIN: "127.0.0.1",
        API_PORT: String(apiPort),
        RIKA_DEV_WEB_BUILD: Output.map(webBuild.hash.output, (hash) => hash ?? "built"),
      },
    })

    return { url: publicUrl, orbExecution: e2bEnabled }
  }),
)

const railwayStack = () =>
  Alchemy.Stack(
    "Rika",
    { providers: railwayProviders(), state: Alchemy.localState() },
    Effect.gen(function* () {
      const inputs = railwayInputs ?? {
        provisioning: { RAILWAY_WORKSPACE_ID: "destroy" },
        githubOauth: { GITHUB_CLIENT_ID: "destroy", GITHUB_CLIENT_SECRET: "destroy" },
        githubApp: { GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "destroy" },
        mail: { RESEND_API_KEY: "destroy", EMAIL_FROM: "destroy@example.invalid" },
        e2b: {
          E2B_API_KEY: "destroy",
          E2B_TEMPLATE_ID: "destroy",
          E2B_TEMPLATE_BUILD_ID: "destroy",
        },
      }
      const stage = yield* Alchemy.Stage
      if (stage !== personalRailwayStage)
        return yield* Effect.die("The Alchemy stage must match .alchemy/rika-dev-stage")
      const authSecret = Output.map(yield* Alchemy.makeRandom("BetterAuthSecret"), (value) =>
        Redacted.make(`0123456789abcdef${Redacted.value(value)}`),
      )
      const providerKeyHex = yield* Alchemy.makeRandom("ProviderCredentialKey")
      const workspaceKeyHex = yield* Alchemy.makeRandom("WorkspaceEncryptionKey")
      const providerCredentialKey = Output.map(providerKeyHex, (value) =>
        Redacted.make(Buffer.from(Redacted.value(value), "hex").toString("base64")),
      )
      const workspaceEncryptionKey = Output.map(workspaceKeyHex, (value) =>
        Redacted.make(Buffer.from(Redacted.value(value), "hex").toString("base64")),
      )

      const project = yield* RailwayProject("Project", {
        name: `rika-${stage}`,
        description: "Disposable Rika development project managed by Alchemy",
        workspaceId: inputs.provisioning.RAILWAY_WORKSPACE_ID,
        defaultEnvironmentName: "development",
      })
      const postgres = yield* RailwayPostgres("postgres", {
        project,
        name: "postgres",
        image: "ghcr.io/railwayapp-templates/postgres-ssl:17",
        user: "rika",
        database: "rika",
        public: false,
      })
      const databaseUrl = Output.map(Output.of(postgres), () => railwayRef("postgres", "DATABASE_URL"))
      const bucket = yield* RailwayBucket("workspace-checkpoints", {
        project,
        name: "workspace-checkpoints",
      })
      const bucketName = requireOutput("the Storage Bucket name", bucket.s3BucketName, "destroy")
      const bucketRegion = requireOutput("the Storage Bucket region", bucket.s3Region, "auto")
      const bucketEndpoint = requireOutput("the Storage Bucket endpoint", bucket.endpoint, "https://destroy.invalid")
      const bucketAccessKey = requireOutput(
        "the Storage Bucket access key",
        bucket.accessKeyId,
        Redacted.make("destroy"),
      )
      const bucketSecretKey = requireOutput(
        "the Storage Bucket secret key",
        bucket.secretAccessKey,
        Redacted.make("destroy"),
      )

      const proxy = yield* RailwayService("proxy", {
        project,
        name: "proxy",
        context: ".",
        dockerfilePath: "apps/proxy/Dockerfile",
        port: 3000,
        publicDomain: true,
        healthcheckPath: "/_healthz",
        healthcheckTimeout: 30,
        restartPolicyType: "ON_FAILURE",
        restartPolicyMaxRetries: 5,
        overlapSeconds: 15,
        drainingSeconds: 30,
        watchPatterns: ["apps/proxy/**", "apps/proxy/Dockerfile"],
        env: {
          PORT: "3000",
          API_DOMAIN: "api.railway.internal",
          API_PORT: "3000",
          WEB_DOMAIN: "web.railway.internal",
          WEB_PORT: "3000",
        },
      })
      const proxyDomain = requireOutput("the proxy public domain", proxy.domain, "destroy.invalid")
      const publicOrigin = Output.map(proxyDomain, (domain) => `https://${domain}`)

      const web = yield* RailwayService("web", {
        project,
        name: "web",
        context: ".",
        dockerfilePath: "apps/web/Dockerfile",
        port: 3000,
        publicDomain: false,
        healthcheckPath: "/healthz",
        healthcheckTimeout: 60,
        restartPolicyType: "ON_FAILURE",
        restartPolicyMaxRetries: 5,
        overlapSeconds: 15,
        drainingSeconds: 30,
        watchPatterns: ["apps/web/**", "apps/web/Dockerfile", "package.json", "bun.lock", "tsconfig.json"],
        env: {
          NODE_ENV: "production",
          PORT: "3000",
          API_DOMAIN: "api.railway.internal",
          API_PORT: "3000",
        },
      })

      const api = yield* RailwayService("api", {
        project,
        name: "api",
        context: ".",
        dockerfilePath: "apps/api/Dockerfile",
        port: 3000,
        publicDomain: false,
        preDeploy: { command: "bun --cwd apps/api migrate" },
        startCommand: "bun --cwd apps/api start",
        healthcheckPath: "/readyz",
        healthcheckTimeout: 300,
        restartPolicyType: "ON_FAILURE",
        restartPolicyMaxRetries: 5,
        overlapSeconds: 30,
        drainingSeconds: 60,
        watchPatterns: [
          "apps/api/**",
          "packages/**",
          "apps/api/Dockerfile",
          "package.json",
          "bun.lock",
          "tsconfig.json",
        ],
        env: {
          NODE_ENV: "production",
          PORT: "3000",
          DATABASE_URL: databaseUrl,
          DATABASE_SSL: "disable",
          BETTER_AUTH_URL: publicOrigin,
          BETTER_AUTH_TRUSTED_ORIGINS: publicOrigin,
          BETTER_AUTH_SECRET: authSecret,
          GITHUB_CLIENT_ID: inputs.githubOauth.GITHUB_CLIENT_ID,
          GITHUB_CLIENT_SECRET: Redacted.make(inputs.githubOauth.GITHUB_CLIENT_SECRET),
          GITHUB_APP_ID: inputs.githubApp.GITHUB_APP_ID,
          GITHUB_APP_PRIVATE_KEY: Redacted.make(inputs.githubApp.GITHUB_APP_PRIVATE_KEY),
          RESEND_API_KEY: Redacted.make(inputs.mail.RESEND_API_KEY),
          EMAIL_FROM: inputs.mail.EMAIL_FROM,
          E2B_API_KEY: Redacted.make(inputs.e2b.E2B_API_KEY),
          E2B_APP_ID: "rika",
          E2B_DEPLOYMENT_ID: `rika-${stage}`,
          E2B_TEMPLATE_ID: inputs.e2b.E2B_TEMPLATE_ID,
          E2B_TEMPLATE_BUILD_ID: inputs.e2b.E2B_TEMPLATE_BUILD_ID,
          RIKA_EXECUTOR_API_URL: Output.map(proxyDomain, (domain) => `wss://${domain}/api/v1/executors`),
          RIKA_WORKSPACE_CHECKPOINT_BUCKET: bucketName,
          RIKA_WORKSPACE_CHECKPOINT_REGION: bucketRegion,
          RIKA_WORKSPACE_CHECKPOINT_ENDPOINT: bucketEndpoint,
          RIKA_WORKSPACE_ENCRYPTION_KEY: workspaceEncryptionKey,
          RIKA_WORKSPACE_SETUP_CACHE: "false",
          RIKA_PROVIDER_CREDENTIAL_KEY: providerCredentialKey,
          RIKA_PROXY_PUBLIC_DOMAIN: proxyDomain,
          AWS_ACCESS_KEY_ID: bucketAccessKey,
          AWS_SECRET_ACCESS_KEY: bucketSecretKey,
          AWS_REGION: bucketRegion,
        },
      })

      return {
        url: publicOrigin,
        project: project.url,
        stage,
        orbExecution: true,
        services: { api: api.dnsName, web: web.dnsName },
      }
    }),
  )

export default target === "railway" ? railwayStack() : localStack
