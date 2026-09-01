import { describe, expect, it } from "@effect/vitest"
import { runnerProtocolVersion } from "@rika/product/runner-registration"
import { Effect, Schema } from "effect"
import {
  ApiMessage,
  FilesystemCheckpoint,
  ExecutorMessage,
  BranchPushRequest,
  MachineOutcome,
  RunnerMessage,
} from "../../src/protocol/messages"
import { workspaceCapabilities } from "../support/workspace-capabilities"

const fence = {
  target: "orb" as const,
  assignmentId: "assignment-1",
  assignmentGeneration: 1,
  instanceId: "sandbox-1",
  executorId: "executor-1",
  processIncarnation: "process-1",
}

describe("executor protocol v1", () => {
  it.effect("represents a machine call definitively cancelled through the native protocol", () =>
    Effect.gen(function* () {
      expect(yield* Schema.decodeEffect(MachineOutcome)({ _tag: "Cancelled" })).toEqual({ _tag: "Cancelled" })
    }),
  )

  it.effect("accepts both execution targets and rejects every other protocol version", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(ExecutorMessage)
      for (const target of ["runner", "orb"] as const) {
        for (const lifecycle of ["fresh", "resume", "replacement"] as const) {
          const message = yield* decode({
            _tag: "ExecutorHello",
            lifecycle,
            environmentDigest: `sha256:${"0".repeat(64)}`,
            hello: {
              minimumVersion: 1,
              maximumVersion: 1,
              fence: { ...fence, target },
              templateBuildId: target === "orb" ? "build-1" : null,
              capabilities: { nativeTools: true, checkpoints: true, pty: true },
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
            capabilities: { nativeTools: true, checkpoints: true, pty: true },
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

  it.effect("binds a branch push to one publication, workspace, ref, and commit", () =>
    Effect.gen(function* () {
      const request = {
        access: { version: 1 as const, fence, leaseEpoch: 1, sessionToken: "session" },
        publicationId: "publication-1",
        ownerId: "owner-1",
        repositoryId: "repository-1",
        workspaceId: "workspace-1",
        branch: "rika/thread-1",
        ref: "refs/heads/rika/thread-1",
        commitSha: "a".repeat(40),
      }
      expect(yield* Schema.decodeEffect(BranchPushRequest)(request)).toEqual(request)
      expect(
        (yield* Effect.flip(Schema.decodeEffect(BranchPushRequest)({ ...request, commitSha: "b" }))).issue,
      ).toBeDefined()
      expect(
        (yield* Effect.flip(
          Schema.decodeEffect(ApiMessage)({ _tag: "BranchPush", request: { ...request, workspaceId: "" } }),
        )).issue,
      ).toBeDefined()
      expect(
        yield* Schema.decodeEffect(ExecutorMessage)({
          _tag: "BranchPushResult",
          access: request.access,
          publicationId: request.publicationId,
          branch: request.branch,
          commitSha: request.commitSha,
          outcome: {
            _tag: "Succeeded",
            branch: request.branch,
            ref: request.ref,
            commitSha: request.commitSha,
          },
        }),
      ).toMatchObject({ _tag: "BranchPushResult", publicationId: "publication-1" })
    }),
  )

  it.effect("round trips native machine execute, cancel, and result frames", () =>
    Effect.gen(function* () {
      const access = { version: 1 as const, fence, leaseEpoch: 1, sessionToken: "session" }
      const execute = {
        _tag: "MachineExecute" as const,
        access,
        operationKey: "operation-1",
        attempt: 0,
        machineId: "machine-1",
        requestDigest: "a".repeat(64),
        request: { _tag: "NativeTool" as const, request: { _tag: "Read" as const, path: "src/main.ts" } },
      }
      const cancel = {
        _tag: "MachineCancel" as const,
        access,
        operationKey: execute.operationKey,
        attempt: execute.attempt,
        machineId: execute.machineId,
        requestDigest: execute.requestDigest,
      }
      const result = {
        _tag: "MachineResult" as const,
        access,
        operationKey: execute.operationKey,
        attempt: execute.attempt,
        machineId: execute.machineId,
        requestDigest: execute.requestDigest,
        outcome: { _tag: "Cancelled" as const },
      }
      expect(yield* Schema.decodeEffect(ApiMessage)(execute)).toEqual(execute)
      expect(yield* Schema.decodeEffect(ApiMessage)(cancel)).toEqual(cancel)
      expect(yield* Schema.decodeEffect(ExecutorMessage)(result)).toEqual(result)
      expect(yield* Schema.decodeEffect(RunnerMessage)(result)).toEqual(result)
      expect(
        (yield* Effect.flip(Schema.decodeEffect(ApiMessage)({ ...execute, requestDigest: "invalid" }))).issue,
      ).toBeDefined()
    }),
  )

  it.effect("bounds sanitized executor connection failure reports", () =>
    Effect.gen(function* () {
      const access = { version: 1 as const, fence, leaseEpoch: 1, sessionToken: "session" }
      const report = {
        _tag: "ExecutorConnectionFailed" as const,
        access,
        stage: "api" as const,
        message: "Native tool request has no runtime authorization",
      }
      expect(yield* Schema.decodeEffect(ExecutorMessage)(report)).toEqual(report)
      expect(
        (yield* Effect.flip(Schema.decodeEffect(ExecutorMessage)({ ...report, message: "x".repeat(513) }))).issue,
      ).toBeDefined()
    }),
  )

  it.effect("keeps local admission frames out of the E2B executor decoder", () =>
    Effect.gen(function* () {
      const hello = {
        protocolVersion: runnerProtocolVersion,
        admissionId: "admission-1",
        ticket: "one-use-ticket",
        processIncarnation: "process-1",
        capabilities: { nativeTools: true, checkpoints: false, pty: false },
        workspaceCapabilities,
        cursors: { command: 0, event: 0, pty: 0 },
      } as const
      const local = RunnerMessage.make({
        _tag: "RunnerHello",
        hello,
      })
      expect(yield* Schema.decodeEffect(RunnerMessage)(local)).toEqual(local)
      expect((yield* Effect.flip(Schema.decodeUnknownEffect(ExecutorMessage)(local))).issue).toBeDefined()
      expect(
        (yield* Effect.flip(
          Schema.decodeUnknownEffect(RunnerMessage)({ ...local, hello: { ...hello, protocolVersion: undefined } }),
        )).issue,
      ).toBeDefined()
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
      expect(yield* Schema.decodeEffect(ApiMessage)(request)).toEqual(request)
      const response = {
        _tag: "WorkspaceResponse" as const,
        access: { version: 1 as const, fence, leaseEpoch: 1, sessionToken: "session" },
        response: { _tag: "RepositoryServiceRunning" as const, requestId: "service-1", serviceId: "docs" },
      }
      expect(yield* Schema.decodeEffect(ExecutorMessage)(response)).toEqual(response)
    }),
  )

  it.effect("accepts local goodbye frames and rejects PTY frames on the local decoder", () =>
    Effect.gen(function* () {
      const localAccess = {
        version: 1 as const,
        fence: { ...fence, target: "runner" as const },
        leaseEpoch: 1,
        sessionToken: "session",
      }
      const goodbye = {
        _tag: "RunnerGoodbye" as const,
        access: localAccess,
      }
      expect(yield* Schema.decodeEffect(RunnerMessage)(goodbye)).toEqual(goodbye)
      expect(
        (yield* Effect.flip(
          Schema.decodeUnknownEffect(RunnerMessage)({
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
      expect(yield* Schema.decodeEffect(ApiMessage)(terminate)).toEqual(terminate)
      expect(yield* Schema.decodeEffect(ExecutorMessage)(gap)).toEqual(gap)
      expect(yield* Schema.decodeEffect(ExecutorMessage)(terminated)).toEqual(terminated)
      expect(
        (yield* Effect.flip(
          Schema.decodeEffect(ApiMessage)({
            _tag: "PtyInput",
            fence,
            request: { ptyId: "pty-1", data: "x".repeat(16_385) },
          }),
        )).issue,
      ).toBeDefined()
    }),
  )
})
