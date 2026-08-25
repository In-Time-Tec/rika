import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3"
import { Config, Console, Data, Effect, Layer } from "effect"

class ObjectStoreInitializationError extends Data.TaggedError("ObjectStoreInitializationError")<{
  readonly message: string
  readonly cause: unknown
}> {}

const program = Effect.gen(function* () {
  const endpoint = yield* Config.url("RIKA_DEV_OBJECT_STORE_URL")
  const bucket = yield* Config.string("RIKA_WORKSPACE_CHECKPOINT_BUCKET")
  const region = yield* Config.string("AWS_REGION")
  const client = new S3Client({ endpoint: endpoint.toString(), region, forcePathStyle: true })
  yield* Effect.tryPromise({
    try: () => client.send(new HeadBucketCommand({ Bucket: bucket })),
    catch: (cause) => new ObjectStoreInitializationError({ message: "Object store bucket is unavailable", cause }),
  }).pipe(
    Effect.catch(() =>
      Effect.tryPromise({
        try: () => client.send(new CreateBucketCommand({ Bucket: bucket })),
        catch: (cause) => new ObjectStoreInitializationError({ message: "Object store bucket creation failed", cause }),
      }),
    ),
    Effect.ensuring(Effect.sync(() => client.destroy())),
  )
  yield* Console.log(`Object store bucket ${bucket} is ready`)
})

if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(program, context))),
  )
