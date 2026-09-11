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
        runtime: {
          RIVET_ENDPOINT: readRequired("Rivet runtime", "RIVET_ENDPOINT"),
          RIKA_API_REVISION: readRequired("Runtime", "RIKA_API_REVISION"),
        },
        model: {
          RIKA_MODEL_PROVIDER: readRequired("Model", "RIKA_MODEL_PROVIDER"),
          RIKA_MODEL_ID: readRequired("Model", "RIKA_MODEL_ID"),
        },
        box: {
          BOX_API_URL: readRequired("Box", "BOX_API_URL"),
          BOX_API_KEY: readRequired("Box", "BOX_API_KEY"),
          RIKA_BOX_TEMPLATE_BOX_ID: readRequired("Box", "RIKA_BOX_TEMPLATE_BOX_ID"),
          RIKA_BOX_TEMPLATE_SNAPSHOT_ID: readRequired("Box", "RIKA_BOX_TEMPLATE_SNAPSHOT_ID"),
          RIKA_BOX_PROVIDER_SCOPE: readRequired("Box", "RIKA_BOX_PROVIDER_SCOPE"),
        },
      }

const publicPort = target === "local" ? Number(Bun.env.PORT ?? "3000") : 3000
if (!Number.isSafeInteger(publicPort) || publicPort <= 0 || publicPort > 65_533)
  throw new Error("PORT must leave two consecutive ports available")
const apiPort = publicPort + 1
const webPort = publicPort + 2
const publicUrl = Bun.env.PUBLIC_URL?.trim() || `http://localhost:${publicPort}`

const readLocal = (name: string) => {
  if (target !== "local") return undefined
  const value = Bun.env[name]?.trim()
  return value === undefined || value.length === 0 ? undefined : value
}
const readOptional = (name: string) => {
  const value = Bun.env[name]?.trim()
  return value === undefined || value.length === 0 ? undefined : value
}
const localOrbConfigured = readLocal("BOX_API_KEY") !== undefined

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
    const workspaceInputKeyHex = yield* Alchemy.makeRandom("WorkspaceInputKey")
    const minioSecret = yield* Alchemy.makeRandom("MinioSecret")
    const providerCredentialKey = Output.map(providerKeyHex, (value) =>
      Redacted.make(Buffer.from(Redacted.value(value), "hex").toString("base64")),
    )
    const workspaceInputKey = Output.map(workspaceInputKeyHex, (value) =>
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
        RIKA_RUNTIME_STORAGE_BUCKET: "rika-development",
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
    const proxy = yield* Command.Dev("DevelopmentProxy", {
      command: "bun scripts/development/caddy.ts",
      env: {
        PUBLIC_URL: publicUrl,
        PUBLIC_PORT: String(publicPort),
        API_PORT: String(apiPort),
        WEB_PORT: String(webPort),
      },
    })

    const apiEnvironment = {
      NODE_ENV: "development",
      HOST: "127.0.0.1",
      PORT: String(apiPort),
      DATABASE_URL: databaseUrl,
      DATABASE_SSL: "disable",
      BETTER_AUTH_URL: publicUrl,
      BETTER_AUTH_TRUSTED_ORIGINS: publicUrl,
      BETTER_AUTH_SECRET: authSecret,
      RIKA_PROVIDER_CREDENTIAL_KEY: providerCredentialKey,
      RIKA_WORKSPACE_INPUT_KEY: workspaceInputKey,
      RIKA_RUNTIME_ENVIRONMENT: readLocal("RIKA_RUNTIME_ENVIRONMENT") ?? "development",
      RIKA_API_REVISION: readLocal("RIKA_API_REVISION") ?? "development",
      RIKA_RUNTIME_STORAGE_BUCKET: "rika-development",
      RIKA_RUNTIME_STORAGE_REGION: "us-east-1",
      RIKA_RUNTIME_STORAGE_ENDPOINT: "http://127.0.0.1:19000",
      RIKA_RUNTIME_STORAGE_FORCE_PATH_STYLE: "true",
      AWS_ACCESS_KEY_ID: "rika-development",
      AWS_SECRET_ACCESS_KEY: minioSecret,
      RIKA_DEV_MIGRATIONS: Output.map(Output.of(migrations), () => "ready"),
      RIKA_DEV_PROXY: Output.map(Output.of(proxy), () => "ready"),
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

    return { url: publicUrl, orbExecution: localOrbConfigured }
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
        runtime: { RIVET_ENDPOINT: "https://destroy.invalid", RIKA_API_REVISION: "destroy" },
        model: { RIKA_MODEL_PROVIDER: "destroy", RIKA_MODEL_ID: "destroy" },
        box: {
          BOX_API_URL: "https://destroy.invalid",
          BOX_API_KEY: "destroy",
          RIKA_BOX_TEMPLATE_BOX_ID: "destroy",
          RIKA_BOX_TEMPLATE_SNAPSHOT_ID: "destroy",
          RIKA_BOX_PROVIDER_SCOPE: "destroy",
        },
      }
      const stage = yield* Alchemy.Stage
      if (stage !== personalRailwayStage)
        return yield* Effect.die("The Alchemy stage must match .alchemy/rika-dev-stage")
      const authSecret = Output.map(yield* Alchemy.makeRandom("BetterAuthSecret"), (value) =>
        Redacted.make(`0123456789abcdef${Redacted.value(value)}`),
      )
      const providerKeyHex = yield* Alchemy.makeRandom("ProviderCredentialKey")
      const workspaceInputKeyHex = yield* Alchemy.makeRandom("WorkspaceInputKey")
      const providerCredentialKey = Output.map(providerKeyHex, (value) =>
        Redacted.make(Buffer.from(Redacted.value(value), "hex").toString("base64")),
      )
      const workspaceInputKey = Output.map(workspaceInputKeyHex, (value) =>
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
      const bucket = yield* RailwayBucket("runtime-storage", {
        project,
        name: "runtime-storage",
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

      const rivetNamespace = readOptional("RIVET_NAMESPACE")
      const rivetToken = readOptional("RIVET_TOKEN")
      const storageSessionToken = readOptional("AWS_SESSION_TOKEN")
      const storageForcePathStyle = readOptional("RIKA_RUNTIME_STORAGE_FORCE_PATH_STYLE")
      const modelMaxOutputTokens = readOptional("RIKA_MODEL_MAX_OUTPUT_TOKENS")
      const modelReasoningEffort = readOptional("RIKA_MODEL_REASONING_EFFORT")
      const boxTtlSeconds = readOptional("RIKA_BOX_TTL_SECONDS")
      const apiEnvironment = {
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
        RIKA_PROVIDER_CREDENTIAL_KEY: providerCredentialKey,
        RIKA_WORKSPACE_INPUT_KEY: workspaceInputKey,
        RIKA_RUNTIME_ENVIRONMENT: `rika-${stage}`,
        RIKA_API_REVISION: inputs.runtime.RIKA_API_REVISION,
        RIVET_ENDPOINT: inputs.runtime.RIVET_ENDPOINT,
        RIKA_MODEL_PROVIDER: inputs.model.RIKA_MODEL_PROVIDER,
        RIKA_MODEL_ID: inputs.model.RIKA_MODEL_ID,
        BOX_API_URL: inputs.box.BOX_API_URL,
        BOX_API_KEY: Redacted.make(inputs.box.BOX_API_KEY),
        RIKA_BOX_TEMPLATE_BOX_ID: inputs.box.RIKA_BOX_TEMPLATE_BOX_ID,
        RIKA_BOX_TEMPLATE_SNAPSHOT_ID: inputs.box.RIKA_BOX_TEMPLATE_SNAPSHOT_ID,
        RIKA_BOX_PROVIDER_SCOPE: inputs.box.RIKA_BOX_PROVIDER_SCOPE,
        RIKA_RUNTIME_STORAGE_BUCKET: bucketName,
        RIKA_RUNTIME_STORAGE_REGION: bucketRegion,
        RIKA_RUNTIME_STORAGE_ENDPOINT: bucketEndpoint,
        AWS_ACCESS_KEY_ID: bucketAccessKey,
        AWS_SECRET_ACCESS_KEY: bucketSecretKey,
      }
      if (rivetNamespace !== undefined) Object.assign(apiEnvironment, { RIVET_NAMESPACE: rivetNamespace })
      if (rivetToken !== undefined) Object.assign(apiEnvironment, { RIVET_TOKEN: Redacted.make(rivetToken) })
      if (storageSessionToken !== undefined)
        Object.assign(apiEnvironment, { AWS_SESSION_TOKEN: Redacted.make(storageSessionToken) })
      if (storageForcePathStyle !== undefined)
        Object.assign(apiEnvironment, { RIKA_RUNTIME_STORAGE_FORCE_PATH_STYLE: storageForcePathStyle })
      if (modelMaxOutputTokens !== undefined)
        Object.assign(apiEnvironment, { RIKA_MODEL_MAX_OUTPUT_TOKENS: modelMaxOutputTokens })
      if (modelReasoningEffort !== undefined)
        Object.assign(apiEnvironment, { RIKA_MODEL_REASONING_EFFORT: modelReasoningEffort })
      if (boxTtlSeconds !== undefined) Object.assign(apiEnvironment, { RIKA_BOX_TTL_SECONDS: boxTtlSeconds })

      const api = yield* RailwayService("api", {
        project,
        name: "api",
        context: ".",
        dockerfilePath: "apps/api/Dockerfile",
        port: 3000,
        publicDomain: false,
        preDeploy: { command: "bun --cwd apps/api migrate" },
        startCommand: "bun --cwd apps/api start",
        healthcheckPath: "/api/rivet/metadata",
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
        env: apiEnvironment,
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
