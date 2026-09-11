import { loadIdentityConfig, type Environment, type IdentityConfig } from "@rika/identity"
import { Effect, Redacted, Schema } from "effect"

export class ApiV2ProductionConfigError extends Schema.TaggedError<ApiV2ProductionConfigError>()(
  "RikaApiV2ProductionConfigError",
  {
    dependency: Schema.Literals(["database", "identity", "runtime", "runtime-storage", "rivet"]),
    message: Schema.String,
  },
) {}

export interface ApiV2RuntimeStorageCredentials {
  readonly accessKeyId: Redacted.Redacted<string>
  readonly secretAccessKey: Redacted.Redacted<string>
  readonly sessionToken?: Redacted.Redacted<string>
}

export interface ApiV2RuntimeStorageConfig {
  readonly bucket: string
  readonly region: string
  readonly endpoint?: string
  readonly forcePathStyle?: boolean
  readonly credentials?: ApiV2RuntimeStorageCredentials
}

export interface ApiV2RivetConfig {
  readonly endpoint: string
  readonly namespace: string
  readonly token?: Redacted.Redacted<string>
}

export interface ApiV2ProductionConfig {
  readonly identity: IdentityConfig
  readonly environment: string
  readonly revision: string
  readonly hostname: string
  readonly port: number
  readonly runtimeStorage: ApiV2RuntimeStorageConfig
  readonly rivet: ApiV2RivetConfig
}

type ConfigDependency = ApiV2ProductionConfigError["dependency"]

const failure = (dependency: ConfigDependency, message: string) =>
  ApiV2ProductionConfigError.make({ dependency, message })

const configured = (environment: Environment, name: string): string | undefined =>
  environment[name]?.trim() || undefined

const required = (
  environment: Environment,
  name: string,
  dependency: ConfigDependency,
): Effect.Effect<string, ApiV2ProductionConfigError> => {
  const value = configured(environment, name)
  return value === undefined ? Effect.fail(failure(dependency, `${name} is required`)) : Effect.succeed(value)
}

const visibleIdentifier = (
  name: string,
  value: string,
  dependency: ConfigDependency,
  maximum: number,
): Effect.Effect<string, ApiV2ProductionConfigError> =>
  /^[\x21-\x7e]+$/.test(value) && value.length <= maximum
    ? Effect.succeed(value)
    : Effect.fail(failure(dependency, `${name} must contain 1–${maximum} visible ASCII characters`))

const runtimeEnvironment = (value: string): Effect.Effect<string, ApiV2ProductionConfigError> =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
    ? Effect.succeed(value)
    : Effect.fail(
        failure(
          "runtime",
          "RIKA_RUNTIME_ENVIRONMENT must start with an alphanumeric character and contain only letters, numbers, '.', '_', or '-'",
        ),
      )

const hostname = (value: string): Effect.Effect<string, ApiV2ProductionConfigError> =>
  Effect.try({
    try: () => {
      const parsed = new URL(`http://${value.includes(":") ? `[${value}]` : value}`)
      if (
        value.length > 253 ||
        parsed.hostname.length === 0 ||
        parsed.username.length > 0 ||
        parsed.password.length > 0 ||
        parsed.port.length > 0 ||
        parsed.pathname !== "/" ||
        parsed.search.length > 0 ||
        parsed.hash.length > 0
      )
        throw new TypeError("invalid hostname")
      if (
        !value.includes(":") &&
        value !== "localhost" &&
        !value.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))
      )
        throw new TypeError("invalid hostname")
      return value
    },
    catch: () => failure("runtime", "HOST must be a hostname or IP address without a port"),
  })

const endpoint = (
  name: string,
  value: string,
  production: boolean,
  dependency: "runtime-storage" | "rivet",
): Effect.Effect<string, ApiV2ProductionConfigError> =>
  Effect.try({
    try: () => {
      const parsed = new URL(value)
      const protocols = production ? ["https:"] : ["http:", "https:"]
      if (!protocols.includes(parsed.protocol)) throw new TypeError("unsupported protocol")
      if (parsed.username.length > 0 || parsed.password.length > 0) throw new TypeError("embedded credentials")
      if (parsed.search.length > 0) throw new TypeError("query")
      if (parsed.hash.length > 0) throw new TypeError("fragment")
      return parsed.toString().replace(/\/$/, "")
    },
    catch: () =>
      failure(
        dependency,
        `${name} must be a valid ${production ? "HTTPS" : "HTTP or HTTPS"} URL without credentials, a query, or a fragment`,
      ),
  })

const booleanOption = (
  environment: Environment,
  name: string,
  dependency: ConfigDependency,
): Effect.Effect<boolean | undefined, ApiV2ProductionConfigError> => {
  const value = configured(environment, name)
  if (value === undefined) return Effect.as(Effect.void, undefined)
  if (value === "true") return Effect.succeed<boolean | undefined>(true)
  if (value === "false") return Effect.succeed<boolean | undefined>(false)
  return Effect.fail(failure(dependency, `${name} must be true or false`))
}

const storageCredentials = (
  environment: Environment,
): Effect.Effect<ApiV2RuntimeStorageCredentials | undefined, ApiV2ProductionConfigError> => {
  const accessKeyId = configured(environment, "AWS_ACCESS_KEY_ID")
  const secretAccessKey = configured(environment, "AWS_SECRET_ACCESS_KEY")
  const sessionToken = configured(environment, "AWS_SESSION_TOKEN")
  if ((accessKeyId === undefined) !== (secretAccessKey === undefined))
    return Effect.fail(
      failure("runtime-storage", "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be configured together"),
    )
  if (sessionToken !== undefined && accessKeyId === undefined)
    return Effect.fail(
      failure("runtime-storage", "AWS_SESSION_TOKEN requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY"),
    )
  if (accessKeyId === undefined || secretAccessKey === undefined) return Effect.as(Effect.void, undefined)
  const credentials: ApiV2RuntimeStorageCredentials = {
    accessKeyId: Redacted.make(accessKeyId),
    secretAccessKey: Redacted.make(secretAccessKey),
  }
  if (sessionToken !== undefined) Object.assign(credentials, { sessionToken: Redacted.make(sessionToken) })
  return Effect.succeed<ApiV2RuntimeStorageCredentials | undefined>(credentials)
}

export const loadApiV2ProductionConfig = Effect.fn("Rika.ApiV2ProductionConfig.load")(function* (
  environment: Environment,
): Effect.fn.Return<ApiV2ProductionConfig, ApiV2ProductionConfigError> {
  const identity = yield* loadIdentityConfig(environment).pipe(
    Effect.mapError((error) => failure(error.message.startsWith("DATABASE_") ? "database" : "identity", error.message)),
  )
  const runtimeName = yield* required(environment, "RIKA_RUNTIME_ENVIRONMENT", "runtime").pipe(
    Effect.flatMap(runtimeEnvironment),
  )
  const runtimeStorage: ApiV2RuntimeStorageConfig = {
    bucket: yield* required(environment, "RIKA_RUNTIME_STORAGE_BUCKET", "runtime-storage").pipe(
      Effect.flatMap((value) => visibleIdentifier("RIKA_RUNTIME_STORAGE_BUCKET", value, "runtime-storage", 255)),
    ),
    region: yield* required(environment, "RIKA_RUNTIME_STORAGE_REGION", "runtime-storage").pipe(
      Effect.flatMap((value) => visibleIdentifier("RIKA_RUNTIME_STORAGE_REGION", value, "runtime-storage", 64)),
    ),
  }
  const storageEndpoint = configured(environment, "RIKA_RUNTIME_STORAGE_ENDPOINT")
  if (storageEndpoint !== undefined)
    Object.assign(runtimeStorage, {
      endpoint: yield* endpoint(
        "RIKA_RUNTIME_STORAGE_ENDPOINT",
        storageEndpoint,
        identity.production,
        "runtime-storage",
      ),
    })
  const forcePathStyle = yield* booleanOption(environment, "RIKA_RUNTIME_STORAGE_FORCE_PATH_STYLE", "runtime-storage")
  if (forcePathStyle !== undefined) Object.assign(runtimeStorage, { forcePathStyle })
  const credentials = yield* storageCredentials(environment)
  if (credentials !== undefined) Object.assign(runtimeStorage, { credentials })
  const rivet: ApiV2RivetConfig = {
    endpoint: yield* required(environment, "RIVET_ENDPOINT", "rivet").pipe(
      Effect.flatMap((value) => endpoint("RIVET_ENDPOINT", value, identity.production, "rivet")),
    ),
    namespace: yield* visibleIdentifier(
      "RIVET_NAMESPACE",
      configured(environment, "RIVET_NAMESPACE") ?? runtimeName,
      "rivet",
      128,
    ),
  }
  const rivetToken = configured(environment, "RIVET_TOKEN")
  if (rivetToken !== undefined) Object.assign(rivet, { token: Redacted.make(rivetToken) })
  return {
    identity,
    environment: runtimeName,
    revision: yield* required(environment, "RIKA_API_REVISION", "runtime").pipe(
      Effect.flatMap((value) => visibleIdentifier("RIKA_API_REVISION", value, "runtime", 256)),
    ),
    hostname: yield* hostname(configured(environment, "HOST") ?? "0.0.0.0"),
    port: identity.port,
    runtimeStorage,
    rivet,
  } satisfies ApiV2ProductionConfig
})
