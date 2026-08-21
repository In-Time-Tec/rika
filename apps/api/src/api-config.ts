import { Effect, Schema } from "effect"
import { loadIdentityConfig } from "@rika/identity"
import { loadConfig as loadExecutorConfig } from "./executor"
import { runtimeEnvironment, type RuntimeEnvironment } from "./runtime-environment"

export class ApiConfigError extends Schema.TaggedError<ApiConfigError>()("ApiConfigError", {
  dependency: Schema.Literals(["runtime", "database", "identity", "executor-provider"]),
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
  return { environment, identity, executor }
})
