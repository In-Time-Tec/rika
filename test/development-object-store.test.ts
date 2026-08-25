import { CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3"
import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { initializeBucket } from "../scripts/development/initialize-object-store"

const bucketClient = <E = never>(headFailure?: E) => {
  const commands: string[] = []
  return {
    commands,
    client: {
      send: (command: HeadBucketCommand | CreateBucketCommand) =>
        Effect.sync(() => commands.push(command instanceof HeadBucketCommand ? "head" : "create")).pipe(
          Effect.andThen(
            command instanceof HeadBucketCommand && headFailure !== undefined
              ? Effect.fail(headFailure)
              : Effect.succeed({}),
          ),
        ),
    },
  }
}

it.effect("does not create a bucket that already exists", () =>
  Effect.gen(function* () {
    const probe = bucketClient()
    expect(yield* Effect.exit(initializeBucket(probe.client, "rika"))).toMatchObject({ _tag: "Success" })
    expect(probe.commands).toEqual(["head"])
  }),
)

it.effect("creates a bucket only after the head request proves it is missing", () =>
  Effect.gen(function* () {
    const probe = bucketClient({ name: "NotFound", $metadata: { httpStatusCode: 404 } })
    expect(yield* Effect.exit(initializeBucket(probe.client, "rika"))).toMatchObject({ _tag: "Success" })
    expect(probe.commands).toEqual(["head", "create"])
  }),
)

it.effect("stops without a create request when bucket absence is not proven", () =>
  Effect.forEach(
    [
      { name: "AccessDenied", $metadata: { httpStatusCode: 403 } },
      { name: "InternalError", $metadata: { httpStatusCode: 500 } },
      { name: "NotFound", $metadata: { httpStatusCode: "404" } },
      new Error("connection refused"),
    ],
    (failure) =>
      Effect.gen(function* () {
        const probe = bucketClient(failure)
        expect(yield* Effect.exit(initializeBucket(probe.client, "rika"))).toMatchObject({ _tag: "Failure" })
        expect(probe.commands).toEqual(["head"])
      }),
    { discard: true },
  ),
)
