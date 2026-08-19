import { Effect, Redacted, Schema } from "effect"

export type Environment = Readonly<Record<string, string | undefined>>

export interface IdentityDatabaseConfig {
  readonly databaseUrl: Redacted.Redacted<string>
  readonly databaseSsl: "disable" | "require" | "verify-full"
}

export interface IdentityConfig extends IdentityDatabaseConfig {
  readonly production: boolean
  readonly port: number
  readonly baseUrl: string
  readonly trustedOrigins: ReadonlyArray<string>
  readonly authSecret: Redacted.Redacted<string>
  readonly githubClientId: string
  readonly githubClientSecret: Redacted.Redacted<string>
  readonly resendApiKey: Redacted.Redacted<string>
  readonly emailFrom: string
  readonly resource: string
}

export class IdentityConfigError extends Schema.TaggedError<IdentityConfigError>()("IdentityConfigError", {
  message: Schema.String,
}) {}

const failure = (message: string) => IdentityConfigError.make({ message })

const required = (environment: Environment, name: string): Effect.Effect<string, IdentityConfigError> => {
  const value = environment[name]?.trim()
  return value === undefined || value.length === 0 ? Effect.fail(failure(`${name} is required`)) : Effect.succeed(value)
}

const parseUrl = (name: string, value: string, protocols: ReadonlyArray<string>) =>
  Effect.try({
    try: () => {
      const url = new URL(value)
      if (!protocols.includes(url.protocol)) throw new TypeError("unsupported protocol")
      if (url.username.length > 0 || url.password.length > 0) throw new TypeError("URL credentials are not allowed")
      return url
    },
    catch: () => failure(`${name} must be a valid ${protocols.join(" or ")} URL without credentials`),
  })

const parseDatabaseUrl = (value: string) =>
  Effect.try({
    try: () => {
      const url = new URL(value)
      if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new TypeError("unsupported protocol")
      return Redacted.make(value)
    },
    catch: () => failure("DATABASE_URL must be a valid PostgreSQL URL"),
  })

const databaseSsl = (
  environment: Environment,
  production: boolean,
): Effect.Effect<IdentityDatabaseConfig["databaseSsl"], IdentityConfigError> => {
  const value = environment.DATABASE_SSL?.trim() ?? (production ? undefined : "disable")
  switch (value) {
    case "disable":
    case "require":
    case "verify-full":
      return Effect.succeed(value)
    default:
      return Effect.fail(failure("DATABASE_SSL must be disable, require, or verify-full"))
  }
}

export const loadIdentityDatabaseConfig = Effect.fn("IdentityConfig.loadDatabase")(function* (
  environment: Environment,
) {
  const nodeEnvironment = yield* required(environment, "NODE_ENV")
  if (nodeEnvironment !== "development" && nodeEnvironment !== "test" && nodeEnvironment !== "production")
    return yield* failure("NODE_ENV must be development, test, or production")
  const production = nodeEnvironment === "production"
  const databaseUrl = yield* required(environment, "DATABASE_URL").pipe(Effect.flatMap(parseDatabaseUrl))
  return {
    databaseUrl,
    databaseSsl: yield* databaseSsl(environment, production),
  } satisfies IdentityDatabaseConfig
})

const parseOrigin = (name: string, value: string, production: boolean) =>
  parseUrl(name, value, production ? ["https:"] : ["http:", "https:"]).pipe(
    Effect.flatMap((url) => {
      if (url.pathname !== "/" || url.search.length > 0 || url.hash.length > 0)
        return Effect.fail(failure(`${name} must be an origin without a path, query, or fragment`))
      return Effect.succeed(url.origin)
    }),
  )

const parsePort = (value: string) => {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port <= 65_535
    ? Effect.succeed(port)
    : Effect.fail(failure("PORT must be an integer between 1 and 65535"))
}

const parseSecret = (value: string) => {
  const uniqueCharacters = new Set(value).size
  return value.length >= 32 && uniqueCharacters >= 16
    ? Effect.succeed(Redacted.make(value))
    : Effect.fail(
        failure("BETTER_AUTH_SECRET must contain at least 32 characters with at least 16 distinct characters"),
      )
}

const parseEmailFrom = (value: string) =>
  /^(?:[^<>\r\n]*<[^<>\s@]+@[^<>\s@]+>|[^<>\s@]+@[^<>\s@]+)$/.test(value)
    ? Effect.succeed(value)
    : Effect.fail(failure("EMAIL_FROM must contain a valid sender email address"))

export const loadIdentityConfig = Effect.fn("IdentityConfig.load")(function* (environment: Environment) {
  const nodeEnvironment = yield* required(environment, "NODE_ENV")
  if (nodeEnvironment !== "development" && nodeEnvironment !== "test" && nodeEnvironment !== "production")
    return yield* failure("NODE_ENV must be development, test, or production")
  const production = nodeEnvironment === "production"
  const database = yield* loadIdentityDatabaseConfig(environment)
  const baseUrl = yield* required(environment, "BETTER_AUTH_URL").pipe(
    Effect.flatMap((value) => parseOrigin("BETTER_AUTH_URL", value, production)),
  )
  const configuredOrigins = (environment.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
  const trustedOrigins = yield* Effect.forEach(configuredOrigins, (origin) =>
    parseOrigin("BETTER_AUTH_TRUSTED_ORIGINS", origin, production),
  )
  const githubClientId = yield* required(environment, "GITHUB_CLIENT_ID")
  const emailFrom = yield* required(environment, "EMAIL_FROM").pipe(Effect.flatMap(parseEmailFrom))
  return {
    ...database,
    production,
    port: yield* required(environment, "PORT").pipe(Effect.flatMap(parsePort)),
    baseUrl,
    trustedOrigins: Array.from(new Set([baseUrl, ...trustedOrigins])),
    authSecret: yield* required(environment, "BETTER_AUTH_SECRET").pipe(Effect.flatMap(parseSecret)),
    githubClientId,
    githubClientSecret: Redacted.make(yield* required(environment, "GITHUB_CLIENT_SECRET")),
    resendApiKey: Redacted.make(yield* required(environment, "RESEND_API_KEY")),
    emailFrom,
    resource: `${baseUrl}/api`,
  } satisfies IdentityConfig
})
