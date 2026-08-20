import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { CellRequest, ApiMessage, FilesystemCheckpoint, ExecutorMessage } from "../src/protocol"

const fence = {
  target: "e2b" as const,
  assignmentId: "assignment-1",
  assignmentGeneration: 1,
  instanceId: "sandbox-1",
  executorId: "executor-1",
  processIncarnation: "process-1",
}

describe("executor protocol v1", () => {
  it.effect("accepts both execution targets and rejects every other protocol version", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(ExecutorMessage)
      for (const target of ["local_device", "e2b"] as const) {
        const message = yield* decode({
          _tag: "ExecutorHello",
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence: { ...fence, target },
            templateBuildId: target === "e2b" ? "build-1" : null,
            capabilities: { cells: true, checkpoints: true, pty: true },
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap",
          },
        })
        expect(message._tag).toBe("ExecutorHello")
      }
      const rejected = yield* Effect.flip(
        decode({
          _tag: "ExecutorHello",
          hello: {
            minimumVersion: 1,
            maximumVersion: 2,
            fence,
            templateBuildId: "build-1",
            capabilities: { cells: true, checkpoints: true, pty: true },
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap",
          },
        }),
      )
      expect(String(rejected)).toContain("Version")
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

  it.effect("accepts a schema-validated operation-keyed cell request", () =>
    Effect.gen(function* () {
      const request = CellRequest.make({
        access: { version: 1, fence, leaseEpoch: 1, sessionToken: "session" },
        operationKey: "run:1:cell:1",
        workspace: "/workspace",
        sessionId: "session-1",
        toolCallId: "call-1",
        code: "console.log('hello')",
      })
      expect(yield* Schema.decodeUnknownEffect(ApiMessage)({ _tag: "CellExecute", request })).toEqual({
        _tag: "CellExecute",
        request,
      })
      expect(
        (yield* Effect.flip(Schema.decodeUnknownEffect(CellRequest)({ ...request, operationKey: "" }))).issue,
      ).toBeDefined()
    }),
  )
})
