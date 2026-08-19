import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { ExecutorHostMessage, FilesystemCheckpoint } from "../src/protocol"

const fence = {
  target: "e2b" as const,
  assignmentId: "assignment-1",
  generation: 1,
  instanceId: "sandbox-1",
  executorId: "executor-1",
}

describe("executor protocol v1", () => {
  it.effect("accepts both execution targets and rejects every other protocol version", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(ExecutorHostMessage)
      for (const target of ["local_device", "e2b"] as const) {
        const message = yield* decode({
          _tag: "ExecutorHello",
          hello: { version: 1, fence: { ...fence, target }, bootstrapToken: "bootstrap" },
        })
        expect(message._tag).toBe("ExecutorHello")
      }
      const rejected = yield* Effect.flip(
        decode({
          _tag: "ExecutorHello",
          hello: { version: 2, fence, bootstrapToken: "bootstrap" },
        }),
      )
      expect(String(rejected)).toContain("version")
    }),
  )

  it.effect("requires content-addressed filesystem checkpoint evidence", () =>
    Effect.gen(function* () {
      const checkpoint = {
        version: 1,
        checkpointId: "checkpoint-1",
        objectKey: "assignments/assignment-1/checkpoint-1.tar.zst",
        contentDigest: `sha256:${"a".repeat(64)}`,
        sizeBytes: 42,
        format: "tar.zst",
        cursor: { sequence: 3, value: "executor:3" },
      }
      expect(yield* Schema.decodeUnknownEffect(FilesystemCheckpoint)(checkpoint)).toEqual(checkpoint)
      expect(
        (yield* Effect.flip(
          Schema.decodeUnknownEffect(FilesystemCheckpoint)({ ...checkpoint, contentDigest: "sha256:not-a-digest" }),
        )).issue,
      ).toBeDefined()
    }),
  )
})
