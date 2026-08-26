import { Effect, Redacted, Schema } from "effect"
import { loadIdentityConfig } from "@rika/identity"
import { loadConfig as loadExecutorConfig } from "./executor"
import { runtimeEnvironment, type RuntimeEnvironment } from "./runtime-environment"

export class ApiConfigError extends Schema.TaggedError<ApiConfigError>()("ApiConfigError", {
  dependency: Schema.Literals(["runtime", "database", "identity", "executor-provider", "github-app", "model-provider"]),
  message: Schema.String,
}) {}

const failure = (dependency: ApiConfigError["dependency"], error: unknown) =>
  ApiConfigError.make({
    dependency,
    message: error instanceof Error ? error.message : String(error),
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

export const loadApiConfig = Effect.fn("ApiConfig.load")(function* (input: RuntimeEnvironment) {
  const environment = yield* Effect.try({
    try: () => runtimeEnvironment(input),
    catch: (error) => failure("runtime", error),
  })
  const identity = yield* loadIdentityConfig(environment).pipe(
    Effect.mapError((error) => failure(error.message.startsWith("DATABASE_") ? "database" : "identity", error)),
  )
  const configuredExecutorVariables = executorVariables.filter((name) => configured(environment, name))
  const executor =
    !identity.production && configuredExecutorVariables.length === 0
      ? undefined
      : yield* loadExecutorConfig(environment).pipe(Effect.mapError((error) => failure("executor-provider", error)))
  const githubAppIdValue = environment.GITHUB_APP_ID?.trim()
  const githubPrivateKey = environment.GITHUB_APP_PRIVATE_KEY?.replaceAll("\\n", "\n").trim()
  const hasGithubAppId = githubAppIdValue !== undefined && githubAppIdValue.length > 0
  const hasGithubPrivateKey = githubPrivateKey !== undefined && githubPrivateKey.length > 0
  if (hasGithubAppId !== hasGithubPrivateKey || (identity.production && !hasGithubAppId)) {
    return yield* ApiConfigError.make({
      dependency: "github-app",
      message: identity.production
        ? "GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required"
        : "GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be configured together",
    })
  }
  const githubAppId = Number(githubAppIdValue)
  if (hasGithubAppId && (!Number.isSafeInteger(githubAppId) || githubAppId <= 0))
    return yield* ApiConfigError.make({ dependency: "github-app", message: "GITHUB_APP_ID must be a positive integer" })
  const encodedCredentialKey = environment.RIKA_PROVIDER_CREDENTIAL_KEY
  if (
    encodedCredentialKey === undefined ||
    !/^[A-Za-z0-9+/]{43}=$/.test(encodedCredentialKey) ||
    Buffer.from(encodedCredentialKey, "base64").toString("base64") !== encodedCredentialKey
  ) {
    return yield* ApiConfigError.make({
      dependency: "model-provider",
      message: "RIKA_PROVIDER_CREDENTIAL_KEY must be a base64-encoded 32-byte key",
    })
  }
  return {
    environment,
    identity,
    developmentSeedEnabled: !identity.production && environment.RIKA_DEV_SEED?.trim() === "1",
    ...(executor === undefined ? {} : { executor }),
    ...(hasGithubAppId ? { github: { appId: githubAppId, privateKey: Redacted.make(githubPrivateKey!) } } : {}),
    ...(identity.production ? {} : { developmentModel: environment.RIKA_DEV_MODEL?.trim() || "openai/gpt-5-mini" }),
    providerCredentialKey: Redacted.make(encodedCredentialKey),
  }
})
