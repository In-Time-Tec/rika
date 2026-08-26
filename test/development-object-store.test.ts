import { expect, it } from "@effect/vitest"
import { CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3"
import { Effect } from "effect"
import {
  initializeBucket,
  isMissingBucket,
  isRejectedObjectStoreCredential,
} from "../scripts/development/initialize-object-store"
import { postgresUnavailableMessage } from "../scripts/development/wait-for-services"

const bucketClient = (headFailure?: unknown) => {
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

it("creates only when object storage proves the bucket is missing", () => {
  expect(isMissingBucket({ name: "NotFound" })).toBe(true)
  expect(isMissingBucket({ name: "NoSuchBucket" })).toBe(true)
  expect(isMissingBucket({ name: "S3ServiceException", $metadata: { httpStatusCode: 404 } })).toBe(true)
  expect(isMissingBucket({ name: "AccessDenied", $metadata: { httpStatusCode: 403 } })).toBe(false)
  expect(isMissingBucket({ name: "InternalError", $metadata: { httpStatusCode: 500 } })).toBe(false)
  expect(isMissingBucket({ name: "NotFound", $metadata: { httpStatusCode: 403 } })).toBe(false)
  expect(isMissingBucket({ name: "NoSuchBucket", $metadata: { httpStatusCode: 500 } })).toBe(false)
  expect(isMissingBucket({ name: "NotFound", $metadata: { httpStatusCode: "404" } })).toBe(false)
  expect(isMissingBucket(new Error("connection refused"))).toBe(false)
})

it("identifies stale development service credentials without guessing from connectivity failures", () => {
  expect(isRejectedObjectStoreCredential({ name: "AccessDenied", $metadata: { httpStatusCode: 403 } })).toBe(true)
  expect(isRejectedObjectStoreCredential({ name: "InvalidAccessKeyId" })).toBe(true)
  expect(isRejectedObjectStoreCredential({ name: "InternalError", $metadata: { httpStatusCode: 500 } })).toBe(false)
  expect(postgresUnavailableMessage({ code: "28P01" })).toContain("different Alchemy state")
  expect(postgresUnavailableMessage({ code: "ECONNREFUSED" })).toBe("PostgreSQL is not ready")
})

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
