import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3"
import { Config, Console, Data, Effect, Layer, Option, Schema } from "effect"

class ObjectStoreInitializationError extends Data.TaggedError("ObjectStoreInitializationError")<{
  readonly message: string
  readonly cause: unknown
}> {}

class ObjectStoreClientError extends Data.TaggedError("ObjectStoreClientError")<{
  readonly cause: unknown
}> {}

const BucketFailure = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  $metadata: Schema.optionalKey(Schema.Struct({ httpStatusCode: Schema.optionalKey(Schema.Finite) })),
})
const decodeBucketFailure = Schema.decodeUnknownOption(BucketFailure)

export const isMissingBucket = (cause: unknown) =>
  Option.match(decodeBucketFailure(cause), {
    onNone: () => false,
    onSome: (failure) =>
      failure.$metadata?.httpStatusCode === undefined
        ? failure.name === "NotFound" || failure.name === "NoSuchBucket"
        : failure.$metadata.httpStatusCode === 404,
  })

export const isRejectedObjectStoreCredential = (cause: unknown) =>
  Option.match(decodeBucketFailure(cause), {
    onNone: () => false,
    onSome: (failure) =>
      failure.$metadata?.httpStatusCode === 403 ||
      failure.name === "AccessDenied" ||
      failure.name === "InvalidAccessKeyId",
  })

interface BucketClient<E> {
  readonly send: (command: HeadBucketCommand | CreateBucketCommand) => Effect.Effect<unknown, E>
}

const clientFailureCause = <E>(failure: E | ObjectStoreClientError) =>
  failure instanceof ObjectStoreClientError ? failure.cause : failure

export const initializeBucket = Effect.fn("DevelopmentObjectStore.initializeBucket")(function* <E>(
  client: BucketClient<E>,
  bucket: string,
) {
  yield* client.send(new HeadBucketCommand({ Bucket: bucket })).pipe(
    Effect.mapError(
      (cause) =>
        new ObjectStoreInitializationError({
          message: "Object store bucket is unavailable",
          cause: clientFailureCause(cause),
        }),
    ),
    Effect.catchIf(
      (error) => isMissingBucket(error.cause),
      () =>
        client.send(new CreateBucketCommand({ Bucket: bucket })).pipe(
          Effect.mapError(
            (cause) =>
              new ObjectStoreInitializationError({
                message: "Object store bucket creation failed",
                cause: clientFailureCause(cause),
              }),
          ),
        ),
    ),
  )
})

const s3BucketClient = (client: S3Client): BucketClient<ObjectStoreClientError> => ({
  send: (command) =>
    Effect.tryPromise({
      try: () => client.send(command),
      catch: (cause) => new ObjectStoreClientError({ cause }),
    }),
})

const program = Effect.gen(function* () {
  const endpoint = yield* Config.url("RIKA_DEV_OBJECT_STORE_URL")
  const bucket = yield* Config.string("RIKA_WORKSPACE_CHECKPOINT_BUCKET")
  const region = yield* Config.string("AWS_REGION")
  const client = new S3Client({ endpoint: endpoint.toString(), region, forcePathStyle: true })
  yield* initializeBucket(s3BucketClient(client), bucket).pipe(
    Effect.mapError((error) =>
      isRejectedObjectStoreCredential(error.cause)
        ? new ObjectStoreInitializationError({
            message:
              "Object storage rejected the development credential because the rika-development-minio volume belongs to different Alchemy state; restore .alchemy or explicitly remove the stale development container and volume",
            cause: error.cause,
          })
        : error,
    ),
    Effect.ensuring(Effect.sync(() => client.destroy())),
  )
  yield* Console.log(`Object store bucket ${bucket} is ready`)
})

if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(program, context))),
  )
