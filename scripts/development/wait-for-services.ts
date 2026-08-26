import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Client } from "pg"
import { Config, Console, Data, Effect, Layer, Option, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"

class DevelopmentServiceUnavailable extends Data.TaggedError("DevelopmentServiceUnavailable")<{
  readonly message: string
  readonly cause?: unknown
  readonly retryable: boolean
}> {}

const unavailable = (message: string, retryable: boolean, cause?: unknown) =>
  new DevelopmentServiceUnavailable({ message, retryable, cause })

const PostgresFailure = Schema.Struct({ code: Schema.optionalKey(Schema.String) })

export const postgresUnavailableMessage = (cause: unknown) =>
  Option.match(Schema.decodeUnknownOption(PostgresFailure)(cause), {
    onNone: () => "PostgreSQL is not ready",
    onSome: (failure) =>
      failure.code === "28P01"
        ? "PostgreSQL rejected the development credential because the rika-development-postgres volume belongs to different Alchemy state; restore .alchemy or explicitly remove the stale development container and volume"
        : "PostgreSQL is not ready",
  })

const checkPostgres = (databaseUrl: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new Client({ connectionString: databaseUrl })).pipe(
      Effect.tap((client) =>
        Effect.tryPromise({
          try: () => client.connect(),
          catch: (cause) =>
            unavailable(
              postgresUnavailableMessage(cause),
              postgresUnavailableMessage(cause) === "PostgreSQL is not ready",
              cause,
            ),
        }),
      ),
    ),
    (client) =>
      Effect.tryPromise({
        try: () => client.query("SELECT 1"),
        catch: (cause) =>
          unavailable(
            postgresUnavailableMessage(cause),
            postgresUnavailableMessage(cause) === "PostgreSQL is not ready",
            cause,
          ),
      }),
    (client) => Effect.tryPromise(() => client.end()).pipe(Effect.ignore),
  )

const program = Effect.gen(function* () {
  const databaseUrl = yield* Config.string("DATABASE_URL")
  const objectStoreUrl = yield* Config.url("RIKA_DEV_OBJECT_STORE_URL")
  const http = yield* HttpClient.HttpClient
  const check = Effect.all(
    [
      checkPostgres(databaseUrl),
      http.get(new URL("/minio/health/live", objectStoreUrl)).pipe(
        Effect.mapError((cause) => unavailable("Object storage is not ready", true, cause)),
        Effect.filterOrFail(
          (response) => response.status >= 200 && response.status < 300,
          (response) => unavailable(`Object storage health returned ${response.status}`, true),
        ),
      ),
    ],
    { concurrency: 2, discard: true },
  )
  yield* check.pipe(
    Effect.retry({ times: 240, schedule: Schedule.spaced("250 millis"), while: (error) => error.retryable }),
  )
  yield* Console.log("PostgreSQL and object storage are ready")
})

if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(
      Effect.flatMap(Layer.build(Layer.merge(BunServices.layer, FetchHttpClient.layer)), (context) =>
        Effect.provide(program, context),
      ),
    ),
  )
