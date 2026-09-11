import { LifecyclePolicy } from "@rika/box-executor/contract"
import { ModelSettings, type ModelConfiguration } from "@rika/context"
import type { Environment } from "@rika/identity"
import { Effect, Redacted, Schema } from "effect"

export class ExecutionConfigError extends Schema.TaggedError<ExecutionConfigError>()("RikaExecutionConfigError", {
  dependency: Schema.Literals(["credentials", "model", "github", "box"]),
  message: Schema.String,
}) {}

export interface ExecutionConfig {
  readonly providerCredentialKey: Redacted.Redacted<string>
  readonly workspaceInputKey: Redacted.Redacted<string>
  readonly model: Omit<ModelConfiguration, "credentialRefs">
  readonly github: {
    readonly appId: number
    readonly privateKey: Redacted.Redacted<string>
  }
  readonly box: {
    readonly baseUrl: string
    readonly apiKey: Redacted.Redacted<string>
    readonly providerScope: string
    readonly policy: LifecyclePolicy
  }
}

const failure = (dependency: ExecutionConfigError["dependency"], message: string) =>
  ExecutionConfigError.make({ dependency, message })

const required = (
  environment: Environment,
  name: string,
  dependency: ExecutionConfigError["dependency"],
): Effect.Effect<string, ExecutionConfigError> => {
  const value = environment[name]?.trim()
  return value === undefined || value.length === 0
    ? Effect.fail(failure(dependency, `${name} is required`))
    : Effect.succeed(value)
}

const identifier = (environment: Environment, name: string, dependency: ExecutionConfigError["dependency"]) =>
  required(environment, name, dependency).pipe(
    Effect.filterOrFail(
      (value) => /^[\x21-\x7e]{1,256}$/.test(value),
      () => failure(dependency, `${name} must contain 1–256 visible ASCII characters`),
    ),
  )

const modelConfig = Effect.fn("Rika.ExecutionConfig.model")(function* (environment: Environment) {
  const provider = yield* required(environment, "RIKA_MODEL_PROVIDER", "model").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Literals(["openai", "anthropic", "openrouter"]))),
    Effect.mapError(() => failure("model", "RIKA_MODEL_PROVIDER must be openai, anthropic, or openrouter")),
  )
  const model = yield* identifier(environment, "RIKA_MODEL_ID", "model")
  const settings: ModelSettings = {}
  if (environment.RIKA_MODEL_MAX_OUTPUT_TOKENS !== undefined)
    Object.assign(settings, {
      maxOutputTokens: yield* Schema.decodeEffect(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)))(
        Number(environment.RIKA_MODEL_MAX_OUTPUT_TOKENS),
      ).pipe(Effect.mapError(() => failure("model", "RIKA_MODEL_MAX_OUTPUT_TOKENS must be a positive integer"))),
    })
  if (environment.RIKA_MODEL_REASONING_EFFORT !== undefined)
    Object.assign(settings, {
      reasoningEffort: yield* identifier(environment, "RIKA_MODEL_REASONING_EFFORT", "model"),
    })
  return { selection: { provider, model }, settings }
})

const boxConfig = Effect.fn("Rika.ExecutionConfig.box")(function* (environment: Environment, production: boolean) {
  const configuredUrl = yield* required(environment, "BOX_API_URL", "box")
  const baseUrl = yield* Effect.try({
    try: () => {
      const url = new URL(configuredUrl)
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      if (
        (url.protocol !== "https:" && !(url.protocol === "http:" && !production && local)) ||
        url.username !== "" ||
        url.password !== "" ||
        url.search !== "" ||
        url.hash !== ""
      )
        throw new Error("Invalid Box endpoint")
      return url.href.replace(/\/$/, "")
    },
    catch: () => failure("box", "BOX_API_URL must be an HTTPS endpoint without credentials, query, or fragment"),
  })
  const policy = yield* Schema.decodeEffect(LifecyclePolicy)({
    template: {
      sourceBoxId: yield* required(environment, "RIKA_BOX_TEMPLATE_BOX_ID", "box"),
      snapshotId: yield* required(environment, "RIKA_BOX_TEMPLATE_SNAPSHOT_ID", "box"),
    },
    ttlSeconds: Number(environment.RIKA_BOX_TTL_SECONDS ?? "3600"),
    readinessAttempts: 60,
    readinessDelayMillis: 1_000,
  }).pipe(Effect.mapError(() => failure("box", "Box template pins or bounded lifetime are invalid")))
  return {
    baseUrl,
    apiKey: Redacted.make(yield* required(environment, "BOX_API_KEY", "box")),
    providerScope: yield* identifier(environment, "RIKA_BOX_PROVIDER_SCOPE", "box"),
    policy,
  }
})

export const loadExecutionConfig = Effect.fn("Rika.ExecutionConfig.load")(function* (
  environment: Environment,
  production: boolean,
): Effect.fn.Return<ExecutionConfig, ExecutionConfigError> {
  const appIdValue = yield* required(environment, "GITHUB_APP_ID", "github")
  const appId = Number(appIdValue)
  if (!/^[1-9][0-9]*$/.test(appIdValue) || !Number.isSafeInteger(appId))
    return yield* failure("github", "GITHUB_APP_ID must be a positive integer")
  return {
    providerCredentialKey: Redacted.make(yield* required(environment, "RIKA_PROVIDER_CREDENTIAL_KEY", "credentials")),
    workspaceInputKey: Redacted.make(yield* required(environment, "RIKA_WORKSPACE_INPUT_KEY", "credentials")),
    model: yield* modelConfig(environment),
    github: {
      appId,
      privateKey: Redacted.make(
        (yield* required(environment, "GITHUB_APP_PRIVATE_KEY", "github")).replaceAll("\\n", "\n"),
      ),
    },
    box: yield* boxConfig(environment, production),
  }
})
