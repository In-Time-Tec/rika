import { Effect, Redacted, Schema } from "effect"
import { loadIdentityConfig } from "@rika/identity"
import { loadConfig as loadExecutorConfig } from "../executor/service"
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

export const loadApiConfig = Effect.fn("ApiConfig.load")(function* (input: RuntimeEnvironment) {
  const environment = yield* Effect.try({
    try: () => runtimeEnvironment(input),
    catch: () => failure("runtime", new Error("Runtime environment is invalid")),
  })
  const identity = yield* loadIdentityConfig(environment).pipe(
    Effect.mapError((error) => failure(error.message.startsWith("DATABASE_") ? "database" : "identity", error)),
  )
  const executor = yield* loadExecutorConfig(environment).pipe(
    Effect.mapError((error) => failure("executor-provider", error)),
  )
  const githubAppId = Number(environment.GITHUB_APP_ID)
  const githubPrivateKey = environment.GITHUB_APP_PRIVATE_KEY?.replaceAll("\\n", "\n").trim()
  if (
    !Number.isSafeInteger(githubAppId) ||
    githubAppId <= 0 ||
    githubPrivateKey === undefined ||
    githubPrivateKey.length === 0
  ) {
    return yield* ApiConfigError.make({
      dependency: "github-app",
      message: "GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required",
    })
  }
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
    executor,
    github: { appId: githubAppId, privateKey: Redacted.make(githubPrivateKey) },
    providerCredentialKey: Redacted.make(encodedCredentialKey),
  }
})
