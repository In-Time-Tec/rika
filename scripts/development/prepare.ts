import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3"
import { Client } from "pg"
import { Config, Console, Data, Effect, Layer, Option, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"

class PreparationError extends Data.TaggedError("PreparationError")<{
  readonly message: string
  readonly retryable: boolean
}> {}

const ServiceFailure = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  $metadata: Schema.optionalKey(Schema.Struct({ httpStatusCode: Schema.optionalKey(Schema.Finite) })),
})
const decodeFailure = Schema.decodeUnknownOption(ServiceFailure)
const clientFailure = (cause: unknown) => Option.getOrElse(decodeFailure(cause), () => ({}))

const unavailable = (message: string) => new PreparationError({ message, retryable: true })
const rejectedCredential = (service: string, volume: string) =>
  new PreparationError({
    message: `${service} rejected the development credential because the ${volume} volume belongs to different Alchemy state; restore .alchemy or explicitly remove the stale development container and volume`,
    retryable: false,
  })

const postgresFailure = (cause: unknown) =>
  Option.match(decodeFailure(cause), {
    onNone: () => unavailable("PostgreSQL is not ready"),
    onSome: (failure) =>
      failure.code === "28P01"
        ? rejectedCredential("PostgreSQL", "rika-development-postgres")
        : unavailable("PostgreSQL is not ready"),
  })

const objectStoreFailure = (cause: unknown) =>
  Option.match(decodeFailure(cause), {
    onNone: () => unavailable("Object store bucket is unavailable"),
    onSome: (failure) =>
      failure.$metadata?.httpStatusCode === 403 ||
      failure.name === "AccessDenied" ||
      failure.name === "InvalidAccessKeyId"
        ? rejectedCredential("Object storage", "rika-development-minio")
        : unavailable("Object store bucket is unavailable"),
  })

const isMissingBucket = (cause: unknown) =>
  Option.match(decodeFailure(cause), {
    onNone: () => false,
    onSome: (failure) =>
      failure.$metadata?.httpStatusCode === undefined
        ? failure.name === "NotFound" || failure.name === "NoSuchBucket"
        : failure.$metadata.httpStatusCode === 404,
  })

const checkPostgres = (databaseUrl: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new Client({ connectionString: databaseUrl })),
    (client) =>
      Effect.tryPromise({ try: () => client.connect(), catch: postgresFailure }).pipe(
        Effect.andThen(Effect.tryPromise({ try: () => client.query("SELECT 1"), catch: postgresFailure })),
        Effect.asVoid,
      ),
    (client) => Effect.tryPromise(() => client.end()).pipe(Effect.ignore),
  )

const initializeBucket = (client: S3Client, bucket: string) => {
  const send = (command: HeadBucketCommand | CreateBucketCommand) =>
    Effect.tryPromise({ try: () => client.send(command), catch: clientFailure }).pipe(Effect.asVoid)
  return send(new HeadBucketCommand({ Bucket: bucket })).pipe(
    Effect.catchIf(isMissingBucket, () => send(new CreateBucketCommand({ Bucket: bucket }))),
    Effect.mapError(objectStoreFailure),
  )
}

const program = Effect.gen(function* () {
  const databaseUrl = yield* Config.string("DATABASE_URL")
  const endpoint = yield* Config.url("RIKA_DEV_OBJECT_STORE_URL")
  const bucket = yield* Config.string("RIKA_WORKSPACE_CHECKPOINT_BUCKET")
  const region = yield* Config.string("AWS_REGION")
  const http = yield* HttpClient.HttpClient

  yield* Effect.all(
    [
      checkPostgres(databaseUrl),
      http.get(new URL("/minio/health/live", endpoint)).pipe(
        Effect.mapError(() => unavailable("Object storage is not ready")),
        Effect.filterOrFail(
          (response) => response.status >= 200 && response.status < 300,
          (response) => unavailable(`Object storage health returned ${response.status}`),
        ),
      ),
    ],
    { concurrency: 2, discard: true },
  ).pipe(Effect.retry({ times: 240, schedule: Schedule.spaced("250 millis"), while: (error) => error.retryable }))

  yield* Effect.acquireUseRelease(
    Effect.sync(() => new S3Client({ endpoint: endpoint.toString(), region, forcePathStyle: true })),
    (client) => initializeBucket(client, bucket),
    (client) => Effect.sync(() => client.destroy()),
  )
  yield* Console.log(`PostgreSQL and object store bucket ${bucket} are ready`)
})

if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(
      Effect.flatMap(Layer.build(Layer.merge(BunServices.layer, FetchHttpClient.layer)), (context) =>
        Effect.provide(program, context),
      ),
    ),
  )
