import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Logger, Option, Redacted, Stream } from "effect"
import { GatewayTestHarness } from "./gateway/fixture"

const {
  encode,
  decode,
  milestone,
  workspaceCapabilities,
  environmentDigest,
  makeGateway,
  fence,
  access,
  socket,
  controller,
  workspaceReady,
} = GatewayTestHarness

describe("executor gateway: connection-publication", () => {
  it.effect("decodes hello and writes the controller welcome", () =>
    Effect.gen(function* () {
      const target = socket()
      const gateway = yield* makeGateway(controller())
      yield* gateway.receive(
        target,
        encode({
          _tag: "ExecutorHello",
          lifecycle: "fresh",
          environmentDigest,
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence,
            templateBuildId: "build-1",
            capabilities: { nativeTools: true, checkpoints: true, pty: true },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      expect(target.closed).toEqual([])
      expect(decode(target.sent[0]!)).toMatchObject({
        _tag: "ExecutorWelcome",
        welcome: { sessionToken: "session-token" },
      })
    }),
  )

  it.effect("logs a bounded executor-side connection failure", () =>
    Effect.gen(function* () {
      const observability: Array<ReturnType<typeof Logger.formatStructured.log>> = []
      const target = socket()
      const gateway = yield* makeGateway(controller())
      yield* gateway.receive(
        target,
        encode({
          _tag: "ExecutorHello",
          lifecycle: "fresh",
          environmentDigest,
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence,
            templateBuildId: "build-1",
            capabilities: { nativeTools: true, checkpoints: true, pty: true },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* gateway
        .receive(
          target,
          encode({
            _tag: "ExecutorConnectionFailed",
            access,
            stage: "api",
            message: "Executor request has no runtime authorization",
          }),
        )
        .pipe(
          Effect.provideService(
            Logger.CurrentLoggers,
            new Set([Logger.map(Logger.formatStructured, (record) => observability.push(record))]),
          ),
        )
      expect(target.closed).toEqual([])
      expect(milestone(observability, "executor-host.connection-failed").map((record) => record.annotations)).toEqual([
        {
          "rika.assignment.id": "assignment-1",
          "rika.executor.id": "executor-1",
          "rika.executor.failure.stage": "api",
          "rika.error.message": "Executor request has no runtime authorization",
        },
      ])
    }),
  )

  it.effect("routes one publication-fenced branch push and its purpose-scoped credential", () =>
    Effect.gen(function* () {
      const target = socket()
      const commands: Array<unknown> = []
      const gateway = yield* makeGateway(
        controller({
          credential: (_access, command) => {
            commands.push(command)
            return Effect.succeed({
              repositoryUrl: "https://github.com/example/repo.git",
              username: "x-access-token",
              token: Redacted.make("write-secret"),
              expiresAt: 4_102_444_800_000,
            })
          },
        }),
      )
      yield* gateway.receive(
        target,
        encode({
          _tag: "ExecutorHello",
          lifecycle: "fresh",
          environmentDigest,
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence,
            templateBuildId: "build-1",
            capabilities: { nativeTools: true, checkpoints: true, pty: true },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* workspaceReady(gateway, target)
      const input = {
        assignmentId: fence.assignmentId,
        publicationId: "publication-1",
        ownerId: "owner-1",
        repositoryId: "repository-1",
        workspaceId: "workspace-1",
        branch: "rika/thread-1",
        ref: "refs/heads/rika/thread-1",
        commitSha: "a".repeat(40),
      }
      const pushed = yield* Effect.forkChild(gateway.pushBranch(input))
      yield* Effect.yieldNow
      const { assignmentId: _, ...wireInput } = input
      expect(target.sent.map((frame) => decode(frame)).find((message) => message._tag === "BranchPush")).toMatchObject({
        _tag: "BranchPush",
        request: wireInput,
      })
      yield* gateway.receive(
        target,
        encode({
          _tag: "CredentialRequested",
          requestId: input.publicationId,
          access,
          ownerId: input.ownerId,
          assignmentId: input.assignmentId,
          repositoryId: input.repositoryId,
          workspaceId: input.workspaceId,
          purpose: "branch-push",
          publicationId: input.publicationId,
          branch: input.branch,
          ref: input.ref,
          commitSha: input.commitSha,
          assignmentGeneration: 1,
          leaseEpoch: 1,
        }),
      )
      expect(commands).toEqual([
        {
          ownerId: input.ownerId,
          assignmentId: input.assignmentId,
          repositoryId: input.repositoryId,
          workspaceId: input.workspaceId,
          purpose: "branch-push",
          publicationId: input.publicationId,
          branch: input.branch,
          ref: input.ref,
          commitSha: input.commitSha,
          assignmentGeneration: 1,
          leaseEpoch: 1,
        },
      ])
      expect(
        target.sent.map((frame) => decode(frame)).find((message) => message._tag === "RepositoryCredential"),
      ).toMatchObject({
        _tag: "RepositoryCredential",
        credential: {
          purpose: "branch-push",
          publicationId: input.publicationId,
          branch: input.branch,
          ref: input.ref,
          commitSha: input.commitSha,
        },
      })
      yield* gateway.receive(
        target,
        encode({
          _tag: "BranchPushResult",
          access,
          publicationId: input.publicationId,
          branch: input.branch,
          commitSha: input.commitSha,
          outcome: {
            _tag: "Succeeded",
            branch: input.branch,
            ref: input.ref,
            commitSha: input.commitSha,
          },
        }),
      )
      expect(yield* Fiber.join(pushed)).toEqual({
        _tag: "Succeeded",
        branch: input.branch,
        ref: input.ref,
        commitSha: input.commitSha,
      })
      expect(target.closed).toEqual([])
    }),
  )

  it.effect("rejects a branch-push credential request without an active approved operation", () =>
    Effect.gen(function* () {
      const target = socket()
      const commands: Array<unknown> = []
      const gateway = yield* makeGateway(
        controller({
          credential: (_access, command) => {
            commands.push(command)
            return Effect.die("unreachable")
          },
        }),
      )
      yield* gateway.receive(
        target,
        encode({
          _tag: "ExecutorHello",
          lifecycle: "fresh",
          environmentDigest,
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence,
            templateBuildId: "build-1",
            capabilities: { nativeTools: true, checkpoints: true, pty: true },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* gateway.receive(
        target,
        encode({
          _tag: "CredentialRequested",
          requestId: "publication-1",
          access,
          ownerId: "owner-1",
          assignmentId: fence.assignmentId,
          repositoryId: "repository-1",
          workspaceId: "workspace-1",
          purpose: "branch-push",
          publicationId: "publication-1",
          branch: "rika/thread-1",
          ref: "refs/heads/rika/thread-1",
          commitSha: "a".repeat(40),
          assignmentGeneration: 1,
          leaseEpoch: 1,
        }),
      )
      expect(commands).toEqual([])
      expect(target.closed).toContainEqual([1008, "fenced"])
    }),
  )

  it.effect("routes assignment-fenced PTY requests and events through the live executor session", () =>
    Effect.gen(function* () {
      const target = socket()
      const gateway = yield* makeGateway(controller())
      yield* gateway.receive(
        target,
        encode({
          _tag: "ExecutorHello",
          lifecycle: "fresh",
          environmentDigest,
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence,
            templateBuildId: "build-1",
            capabilities: { nativeTools: true, checkpoints: false, pty: true },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* workspaceReady(gateway, target)
      for (const request of [
        {
          _tag: "PtyCreate" as const,
          request: { ptyId: "pty-1", command: "bash", cwd: "/workspace", cols: 80, rows: 24 },
        },
        { _tag: "PtyInput" as const, request: { ptyId: "pty-1", data: "echo routed\n" } },
        { _tag: "PtyResize" as const, request: { ptyId: "pty-1", cols: 120, rows: 40 } },
        { _tag: "PtyDisconnect" as const, ptyId: "pty-1" },
        { _tag: "PtyReconnect" as const, request: { ptyId: "pty-1", cursor: 4 } },
        { _tag: "PtyTerminate" as const, ptyId: "pty-1" },
      ])
        yield* gateway.sendPty("assignment-1", request)
      expect(decode(target.sent[1]!)).toEqual({
        _tag: "PhaseEnvironmentGranted",
        phase: "setup",
        digest: `sha256:${"0".repeat(64)}`,
        operationKey: null,
        values: {},
        redactedNames: [],
      })
      expect(target.sent.slice(2).map((message) => decode(message))).toEqual([
        {
          _tag: "PtyCreate",
          fence,
          request: { ptyId: "pty-1", command: "bash", cwd: "/workspace", cols: 80, rows: 24 },
        },
        { _tag: "PtyInput", fence, request: { ptyId: "pty-1", data: "echo routed\n" } },
        { _tag: "PtyResize", fence, request: { ptyId: "pty-1", cols: 120, rows: 40 } },
        { _tag: "PtyDisconnect", fence, ptyId: "pty-1" },
        { _tag: "PtyReconnect", fence, request: { ptyId: "pty-1", cursor: 4 } },
        { _tag: "PtyTerminate", fence, ptyId: "pty-1" },
      ])

      const observed = yield* Effect.forkChild(Stream.runHead(gateway.ptyEvents("assignment-1")))
      yield* Effect.yieldNow
      const output = {
        _tag: "PtyOutput" as const,
        access,
        ptyId: "pty-1",
        chunk: { cursor: 5, data: "routed\r\n" },
      }
      yield* gateway.receive(target, encode(output))
      expect(Option.getOrThrow(yield* Fiber.join(observed))).toEqual(output)
      expect(target.closed).toEqual([])

      yield* gateway.receive(target, encode({ ...output, access: { ...access, leaseEpoch: 2 } }))
      expect(decode(target.sent.at(-1)!)).toEqual({
        _tag: "Fenced",
        fence,
        message: "PTY frame has a stale executor session",
      })
      expect(target.closed).toEqual([[1008, "fenced"]])
    }),
  )
})
