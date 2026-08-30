import { Effect, Redacted, Schema } from "effect"
import { loadIdentityConfig, type IdentityConfig } from "@rika/identity"
import { loadConfig as loadExecutorConfig, type ExecutorConfig } from "../executor/service"
import { runtimeEnvironment, type RuntimeEnvironment } from "./runtime-environment"

export class ApiConfigError extends Schema.TaggedError<ApiConfigError>()("ApiConfigError", {
  dependency: Schema.Literals(["runtime", "database", "identity", "executor-provider", "github-app", "model-provider"]),
  message: Schema.String,
}) {}

const failure = (dependency: ApiConfigError["dependency"], error: Error) =>
  ApiConfigError.make({
    dependency,
    message: error.message,
  })

const configured = (environment: RuntimeEnvironment, name: string) => (environment[name]?.trim() ?? "").length > 0

const executorVariables = [
  "E2B_API_KEY",
  "E2B_APP_ID",
  "E2B_DEPLOYMENT_ID",
  "E2B_TEMPLATE_ID",
  "E2B_TEMPLATE_BUILD_ID",
  "RIKA_EXECUTOR_API_URL",
  "RIKA_WORKSPACE_CHECKPOINT_BUCKET",
  "RIKA_WORKSPACE_CHECKPOINT_REGION",
  "RIKA_WORKSPACE_ENCRYPTION_KEY",
] as const

interface LoadedApiConfig {
  environment: RuntimeEnvironment
  identity: IdentityConfig
  developmentSeedEnabled: boolean
  executor?: ExecutorConfig
  github?: { appId: number; privateKey: Redacted.Redacted<string> }
  developmentModel?: string
  providerCredentialKey: Redacted.Redacted<string>
}

const loadGithub = (environment: RuntimeEnvironment, production: boolean) => {
  const appIdValue = environment.GITHUB_APP_ID?.trim()
  const privateKey = environment.GITHUB_APP_PRIVATE_KEY?.replaceAll("\\n", "\n").trim()
  const hasAppId = appIdValue !== undefined && appIdValue.length > 0
  const hasPrivateKey = privateKey !== undefined && privateKey.length > 0
  if (hasAppId !== hasPrivateKey || (production && !hasAppId))
    return Effect.fail(
      ApiConfigError.make({
        dependency: "github-app",
        message: production
          ? "GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required"
          : "GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be configured together",
      }),
    )
  const appId = Number(appIdValue)
  if (hasAppId && (!Number.isSafeInteger(appId) || appId <= 0))
    return Effect.fail(
      ApiConfigError.make({ dependency: "github-app", message: "GITHUB_APP_ID must be a positive integer" }),
    )
  return Effect.succeed(
    hasAppId && privateKey !== undefined ? { appId, privateKey: Redacted.make(privateKey) } : undefined,
  )
}

const loadProviderCredentialKey = (environment: RuntimeEnvironment) => {
  const encoded = environment.RIKA_PROVIDER_CREDENTIAL_KEY
  const valid =
    encoded !== undefined &&
    /^[A-Za-z0-9+/]{43}=$/.test(encoded) &&
    Buffer.from(encoded, "base64").toString("base64") === encoded
  return valid
    ? Effect.succeed(Redacted.make(encoded))
    : Effect.fail(
        ApiConfigError.make({
          dependency: "model-provider",
          message: "RIKA_PROVIDER_CREDENTIAL_KEY must be a base64-encoded 32-byte key",
        }),
      )
}

export const loadApiConfig = Effect.fn("ApiConfig.load")(function* (input: RuntimeEnvironment) {
  const environment = yield* Effect.try({
    try: () => runtimeEnvironment(input),
    catch: () => failure("runtime", new Error("Runtime environment is invalid")),
  })
  const identity = yield* loadIdentityConfig(environment).pipe(
    Effect.mapError((error) => failure(error.message.startsWith("DATABASE_") ? "database" : "identity", error)),
  )
  const configuredExecutorVariables = executorVariables.filter((name) => configured(environment, name))
  const executor =
    !identity.production && configuredExecutorVariables.length === 0
      ? undefined
      : yield* loadExecutorConfig(environment).pipe(Effect.mapError((error) => failure("executor-provider", error)))
  const github = yield* loadGithub(environment, identity.production)
  const providerCredentialKey = yield* loadProviderCredentialKey(environment)
  const result: LoadedApiConfig = {
    environment,
    identity,
    developmentSeedEnabled: !identity.production && environment.RIKA_DEV_SEED?.trim() === "1",
    providerCredentialKey,
  }
  if (executor !== undefined) result.executor = executor
  if (github !== undefined) result.github = github
  if (!identity.production) result.developmentModel = environment.RIKA_DEV_MODEL?.trim() || "minimax/minimax-m2.7:free"
  return result
})
