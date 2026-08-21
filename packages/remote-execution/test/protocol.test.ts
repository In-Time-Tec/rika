import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import {
  CellRequest,
  ApiMessage,
  CellLifecycleFrame,
  FilesystemCheckpoint,
  ExecutorMessage,
  LocalExecutorMessage,
} from "../src/protocol"
import { workspaceCapabilities } from "./support/workspace-capabilities"

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
        for (const lifecycle of ["fresh", "resume", "replacement"] as const) {
          const message = yield* decode({
            _tag: "ExecutorHello",
            lifecycle,
            environmentDigest: `sha256:${"0".repeat(64)}`,
            hello: {
              minimumVersion: 1,
              maximumVersion: 1,
              fence: { ...fence, target },
              templateBuildId: target === "e2b" ? "build-1" : null,
              capabilities: { cells: true, checkpoints: true, pty: true },
              workspaceCapabilities,
              cursors: { command: 0, event: 0, pty: 0 },
              latestCheckpointId: null,
              bootstrapToken: "bootstrap",
            },
          })
          expect(message).toMatchObject({ _tag: "ExecutorHello", lifecycle })
        }
      }
      const rejected = yield* Effect.flip(
        decode({
          _tag: "ExecutorHello",
          lifecycle: "fresh",
          environmentDigest: `sha256:${"0".repeat(64)}`,
          hello: {
            minimumVersion: 1,
            maximumVersion: 2,
            fence,
            templateBuildId: "build-1",
            capabilities: { cells: true, checkpoints: true, pty: true },
            workspaceCapabilities,
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
        workspaceId: "workspace-1",
        sessionId: "session-1",
        threadId: "thread-1",
        turnId: "turn-1",
        runId: "run-1",
        rootRunId: "run-1",
        toolCallId: "call-1",
        code: "console.log('hello')",
        attempt: 0,
        replayPolicy: "pure",
        admittedAt: null,
        deadline: null,
        bindings: { digest: "a".repeat(64), descriptors: [] },
      })
      expect(yield* Schema.decodeUnknownEffect(ApiMessage)({ _tag: "CellExecute", request })).toEqual({
        _tag: "CellExecute",
        request,
      })
      for (const identity of [
        "workspaceId",
        "sessionId",
        "threadId",
        "turnId",
        "runId",
        "rootRunId",
        "toolCallId",
      ] as const) {
        const { [identity]: _, ...incomplete } = request
        expect((yield* Effect.flip(Schema.decodeUnknownEffect(CellRequest)(incomplete))).issue).toBeDefined()
      }
      expect(
        (yield* Effect.flip(Schema.decodeUnknownEffect(CellRequest)({ ...request, operationKey: "" }))).issue,
      ).toBeDefined()
    }),
  )

  it.effect("keeps local admission frames out of the E2B executor decoder", () =>
    Effect.gen(function* () {
      const local = LocalExecutorMessage.make({
        _tag: "LocalExecutorHello",
        hello: {
          admissionId: "admission-1",
          ticket: "one-use-ticket",
          processIncarnation: "process-1",
          capabilities: { cells: true, checkpoints: false, pty: false },
          workspaceCapabilities,
          cursors: { command: 0, event: 0, pty: 0 },
        },
      })
      expect(yield* Schema.decodeUnknownEffect(LocalExecutorMessage)(local)).toEqual(local)
      expect((yield* Effect.flip(Schema.decodeUnknownEffect(ExecutorMessage)(local))).issue).toBeDefined()
    }),
  )

  it.effect("round trips assignment-fenced Workspace file and service frames", () =>
    Effect.gen(function* () {
      const request = {
        _tag: "WorkspaceRequest" as const,
        fence,
        request: {
          _tag: "WorkspaceFileInspect" as const,
          requestId: "inspect-1",
          path: "src/main.ts",
          maximumBytes: 1024,
        },
      }
      expect(yield* Schema.decodeUnknownEffect(ApiMessage)(request)).toEqual(request)
      const response = {
        _tag: "WorkspaceResponse" as const,
        access: { version: 1 as const, fence, leaseEpoch: 1, sessionToken: "session" },
        response: { _tag: "RepositoryServiceRunning" as const, requestId: "service-1", serviceId: "docs" },
      }
      expect(yield* Schema.decodeUnknownEffect(ExecutorMessage)(response)).toEqual(response)
    }),
  )

  it.effect("decodes attributed lifecycle frames and bounds redacted output", () =>
    Effect.gen(function* () {
      const attribution = {
        operationKey: "operation-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        threadId: "thread-1",
        turnId: "turn-1",
        runId: "run-1",
        rootRunId: "run-1",
        toolCallId: "call-1",
        attempt: 0,
      }
      const output = {
        _tag: "Output" as const,
        attribution,
        cursor: 3,
        stream: "stdout" as const,
        text: "safe output",
        redacted: true as const,
        truncated: false,
      }
      expect(yield* Schema.decodeUnknownEffect(CellLifecycleFrame)(output)).toEqual(output)
      expect(
        (yield* Effect.flip(Schema.decodeUnknownEffect(CellLifecycleFrame)({ ...output, text: "x".repeat(16_385) })))
          .issue,
      ).toBeDefined()
      expect(
        (yield* Effect.flip(Schema.decodeUnknownEffect(CellLifecycleFrame)({ ...output, redacted: false }))).issue,
      ).toBeDefined()
    }),
  )

  it.effect("accepts local goodbye and receipt frames and rejects PTY frames on the local decoder", () =>
    Effect.gen(function* () {
      const localAccess = {
        version: 1 as const,
        fence: { ...fence, target: "local_device" as const },
        leaseEpoch: 1,
        sessionToken: "session",
      }
      const goodbye = {
        _tag: "LocalExecutorGoodbye" as const,
        access: localAccess,
      }
      const receipt = {
        _tag: "LocalCellReceipt" as const,
        access: localAccess,
        operationKey: "operation-1",
        attempt: 0,
      }
      expect(yield* Schema.decodeUnknownEffect(LocalExecutorMessage)(goodbye)).toEqual(goodbye)
      expect(yield* Schema.decodeUnknownEffect(ApiMessage)(receipt)).toEqual(receipt)
      expect(
        (yield* Effect.flip(
          Schema.decodeUnknownEffect(LocalExecutorMessage)({
            _tag: "PtyOpened",
            access: localAccess,
            pty: { ptyId: "pty-1", command: "bash", cwd: "/tmp", cols: 80, rows: 24 },
          }),
        )).issue,
      ).toBeDefined()
    }),
  )

  it.effect("decodes bounded PTY replay gaps and explicit termination", () =>
    Effect.gen(function* () {
      const access = { version: 1 as const, fence, leaseEpoch: 1, sessionToken: "session" }
      const terminate = { _tag: "PtyTerminate" as const, fence, ptyId: "pty-1" }
      const gap = {
        _tag: "PtyReplayGap" as const,
        access,
        ptyId: "pty-1",
        gap: { fromCursor: 1, toCursor: 4 },
      }
      const terminated = { _tag: "PtyTerminated" as const, access, ptyId: "pty-1", cursor: 8 }
      expect(yield* Schema.decodeUnknownEffect(ApiMessage)(terminate)).toEqual(terminate)
      expect(yield* Schema.decodeUnknownEffect(ExecutorMessage)(gap)).toEqual(gap)
      expect(yield* Schema.decodeUnknownEffect(ExecutorMessage)(terminated)).toEqual(terminated)
      expect(
        (yield* Effect.flip(
          Schema.decodeUnknownEffect(ApiMessage)({
            _tag: "PtyInput",
            fence,
            request: { ptyId: "pty-1", data: "x".repeat(16_385) },
          }),
        )).issue,
      ).toBeDefined()
    }),
  )
})
