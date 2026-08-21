import { Effect, Redacted, Schema } from "effect"
import { loadIdentityConfig } from "@rika/identity"
import { loadConfig as loadExecutorConfig } from "./executor"
import { runtimeEnvironment, type RuntimeEnvironment } from "./runtime-environment"

export class ApiConfigError extends Schema.TaggedError<ApiConfigError>()("ApiConfigError", {
  dependency: Schema.Literals(["runtime", "database", "identity", "executor-provider", "model-provider"]),
  message: Schema.String,
}) {}

const failure = (dependency: ApiConfigError["dependency"], error: unknown) =>
  ApiConfigError.make({
    dependency,
    message: error instanceof Error ? error.message : String(error),
  })

export const loadApiConfig = Effect.fn("ApiConfig.load")(function* (input: RuntimeEnvironment) {
  const environment = yield* Effect.try({
    try: () => runtimeEnvironment(input),
    catch: (error) => failure("runtime", error),
  })
  const identity = yield* loadIdentityConfig(environment).pipe(
    Effect.mapError((error) => failure(error.message.startsWith("DATABASE_") ? "database" : "identity", error)),
  )
  const executor = yield* loadExecutorConfig(environment).pipe(
    Effect.mapError((error) => failure("executor-provider", error)),
  )
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
  return { environment, identity, executor, providerCredentialKey: Redacted.make(encodedCredentialKey) }
})
