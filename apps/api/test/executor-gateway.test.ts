import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { describe, expect, it } from "@effect/vitest"
import { ControllerError, type Interface as Controller } from "@rika/e2b-executor/controller"
import * as WorkspaceBinding from "@rika/kernel/workspace-binding"
import {
  ApiMessage,
  BindingRequest,
  ExecutorMessage,
  type CellLifecycleFrame,
  type CellResponse,
} from "@rika/remote-execution/protocol"
import { NestedOperation, ToolContext } from "tenetkit"
import { HostBindingRegistry } from "tenetkit/repl"
import { Context, Crypto, Deferred, Effect, Fiber, Layer, Logger, Option, Redacted, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import {
  GatewayError,
  makeGateway as makeGatewayService,
  type BindingAuthority,
  type Gateway,
  type LifecycleStore,
  type PreparationStore,
  type Socket,
} from "../src/executor-gateway"
import { testToolPolicy } from "./hosted-tool-policy-fixture"

const encode = Schema.encodeSync(Schema.fromJsonString(ExecutorMessage))
const decode = Schema.decodeSync(Schema.fromJsonString(ApiMessage))
const encodeBindingRequest = Schema.encodeSync(Schema.fromJsonString(BindingRequest))
const encodeUnknown = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const bindingRequestDigest = (request: BindingRequest) =>
  new Bun.CryptoHasher("sha256").update(encodeBindingRequest(request)).digest("hex")
const milestone = (observability: ReadonlyArray<ReturnType<typeof Logger.formatStructured.log>>, message: string) =>
  observability.filter((record) => record.message === message)
const ready = (detail: string) => ({ _tag: "Ready" as const, detail })
const workspaceCapabilities = {
  environmentDigest: `sha256:${"0".repeat(64)}`,
  capturedAt: "2026-08-21T00:00:00.000Z",
  filesystem: ready("filesystem ready"),
  typescriptKernel: ready("TypeScript kernel ready"),
  git: ready("Git ready"),
  process: ready("process ready"),
  pty: ready("PTY ready"),
  browser: ready("browser ready"),
  services: ready("repository services ready"),
  workspaceLifecycle: ready("workspace lifecycle ready"),
}

const lifecycleStore = (
  append: LifecycleStore["append"] = () => Effect.succeed({ _tag: "Appended" }),
  load: LifecycleStore["load"] = () => Effect.succeed([]),
): LifecycleStore => {
  const operations = new Map<
    string,
    {
      state: "accepted" | "dispatched" | "completed" | "unknown"
      started: boolean
      response?: CellResponse
      outcome?: "completed" | "failed" | "cancelled" | "unknown"
      dispatchedGeneration?: number
      dispatchedExecutorInstanceId?: string
      dispatchedProcessIncarnation?: string
    }
  >()
  const persistedFrames = new Map<string, ReadonlyArray<CellLifecycleFrame>>()
  const operationalWindows = new Map<string, { admittedAt: string | null; deadlineAt: string }>()
  const operation = (input: {
    readonly assignmentId: string
    readonly operationKey: string
    readonly attempt: number
  }) => `${input.assignmentId}\u0000${input.operationKey}\u0000${input.attempt}`
  const readFrames: LifecycleStore["load"] = (assignmentId, operationKey, attempt) => {
    const operationId = operation({ assignmentId, operationKey, attempt })
    const persisted = persistedFrames.get(operationId)
    return persisted === undefined
      ? load(assignmentId, operationKey, attempt).pipe(
          Effect.tap((frames) => Effect.sync(() => void persistedFrames.set(operationId, frames))),
        )
      : Effect.succeed(persisted)
  }
  return {
    append: (access, frame) =>
      Effect.gen(function* () {
        const assignmentId = access.fence.assignmentId
        const operationKey = `${assignmentId}\u0000${frame.attribution.operationKey}\u0000${frame.attribution.attempt}`
        const current = operations.get(operationKey)
        if (
          (current?.state === "completed" || current?.state === "unknown") &&
          current.response !== undefined &&
          current.outcome !== undefined
        )
          return { _tag: "AlreadyTerminal", result: { response: current.response, outcome: current.outcome } } as const
        const disposition = yield* append(access, frame)
        if (disposition._tag === "AlreadyTerminal" || disposition._tag === "AlreadyAppended" || current === undefined)
          return disposition
        persistedFrames.set(operationKey, [...(persistedFrames.get(operationKey) ?? []), frame])
        if (frame._tag === "Started") operations.set(operationKey, { ...current, started: true })
        if (frame._tag === "Terminal")
          operations.set(operationKey, {
            ...current,
            state: frame.outcome === "unknown" ? "unknown" : "completed",
            response: frame.response,
            outcome: frame.outcome,
          })
        return disposition
      }),
    load: readFrames,
    replay: (assignmentId) =>
      Effect.sync(() =>
        [...operations.entries()].flatMap(([operationId, current]) => {
          const [knownAssignmentId, operationKey, attempt] = operationId.split("\u0000")
          return knownAssignmentId === assignmentId && current.state === "dispatched"
            ? [
                {
                  operationKey: operationKey!,
                  attempt: Number(attempt),
                  afterCursor: persistedFrames.get(operationId)?.at(-1)?.cursor ?? 0,
                },
              ]
            : []
        }),
      ),
    prepare: (input) =>
      readFrames(input.assignmentId, input.operationKey, input.attempt).pipe(
        Effect.flatMap((frames) =>
          Effect.sync(() => {
            const operationId = operation(input)
            const terminal = frames.find((frame) => frame._tag === "Terminal")
            if (terminal?._tag === "Terminal")
              operations.set(operationId, {
                state: "completed",
                started: true,
                response: terminal.response,
                outcome: terminal.outcome,
              })
            else if (!operations.has(operationId))
              operations.set(operationId, { state: "accepted", started: frames.some((frame) => frame._tag === "Started") })
            const operationalWindow = operationalWindows.get(operationId) ?? {
              admittedAt: input.admittedAt,
              deadlineAt: input.deadlineAt,
            }
            operationalWindows.set(operationId, operationalWindow)
            return operationalWindow
          }),
        ),
      ),
    inspect: (input) => Effect.sync(() => operations.get(operation(input)) ?? { state: "accepted", started: false }),
    dispatch: (input, access) =>
      Effect.sync(
        () =>
          void operations.set(operation(input), {
            state: "dispatched",
            started: false,
            dispatchedGeneration: access.fence.assignmentGeneration,
            dispatchedExecutorInstanceId: access.fence.executorId,
            dispatchedProcessIncarnation: access.fence.processIncarnation,
          }),
      ),
    resolveDeadline: (input) =>
      Effect.sync(() => {
        const current = operations.get(operation(input)) ?? { state: "accepted" as const, started: false }
        const unknown = current.state === "dispatched"
        const response = {
          _tag: "DomainFailure" as const,
          failure: unknown
            ? { kind: "unknown", message: "Executor operation outcome is unknown after executor loss" }
            : { kind: "timeout", message: "Cell operation deadline exceeded" },
        }
        if (!unknown)
          operations.set(operation(input), {
            ...current,
            state: "completed",
            response,
            outcome: "failed",
          })
        return {
          _tag: "Resolved" as const,
          result: { response, outcome: unknown ? ("unknown" as const) : ("failed" as const) },
        }
      }),
  }
}
const readyPreparation: PreparationStore = {
  start: () => Effect.void,
  output: () => Effect.void,
  complete: () => Effect.void,
  fail: () => Effect.void,
  retry: () => Effect.succeed(2),
  ready: () => Effect.void,
}
const environmentDigest = `sha256:${"0".repeat(64)}`
const makeGateway = (
  service: Controller,
  append: LifecycleStore["append"] = () => Effect.succeed({ _tag: "Appended" }),
  load: LifecycleStore["load"] = () => Effect.succeed([]),
  preparation: PreparationStore = readyPreparation,
  retainedLifecycle?: LifecycleStore,
) =>
  makeGatewayService(
    service,
    retainedLifecycle ?? lifecycleStore(append, load),
    {
      activate: (_access, _phase, use) => use({ digest: environmentDigest, values: {}, redactedNames: [] }),
      publication: (_access, use) => use(),
      replace: (key) =>
        service
          .replace(key, {
            egress: { phase: "runtime", allow: ["api.example.test"] },
            environmentDigest,
          })
          .pipe(
            Effect.asVoid,
            Effect.mapError((error) => GatewayError.make({ kind: "fenced", message: error.message })),
          ),
    },
    preparation,
    () => Effect.succeed("a".repeat(64)),
    testToolPolicy,
  ).pipe(
    Effect.provideServiceEffect(
      Crypto.Crypto,
      Effect.scoped(Layer.build(BunCrypto.layer)).pipe(Effect.map((context) => Context.get(context, Crypto.Crypto))),
    ),
  )

const bindings = {
  registry: HostBindingRegistry.HostBindingRegistry.of({
    descriptors: [],
    resolve: (request) => Effect.fail(HostBindingRegistry.HostBindingNotFound.make({ module: request.module })),
    invoke: (request) => Effect.fail(HostBindingRegistry.HostBindingNotFound.make({ module: request.module })),
  }),
  context: Context.empty(),
  manifest: { digest: "a".repeat(64), descriptors: [] },
} as unknown as BindingAuthority

const fence = {
  target: "orb" as const,
  assignmentId: "assignment-1",
  assignmentGeneration: 1,
  instanceId: "sandbox-1",
  executorId: "executor-1",
  processIncarnation: "process-1",
}

const access = { version: 1 as const, fence, leaseEpoch: 1, sessionToken: "session-token" }
const cellIdentity = {
  threadId: "thread-1",
  turnId: "turn-1",
  runId: "run-1",
  rootRunId: "run-1",
  toolCallId: "call-1",
  attempt: 0,
  replayPolicy: "pure",
  admittedAt: null,
  deadlineAt: "2999-01-01T00:00:00.000Z",
  bindings,
} as const
const attribution = (operationKey: string) => ({
  operationKey,
  workspaceId: "workspace-1",
  sessionId: "thread-1",
  threadId: cellIdentity.threadId,
  turnId: cellIdentity.turnId,
  runId: cellIdentity.runId,
  rootRunId: cellIdentity.rootRunId,
  toolCallId: cellIdentity.toolCallId,
  attempt: cellIdentity.attempt,
})

const socket = () => {
  const sent: Array<string> = []
  const closed: Array<readonly [number | undefined, string | undefined]> = []
  return {
    sent,
    closed,
    send: (message: string) => sent.push(message),
    close: (code?: number, reason?: string) => closed.push([code, reason]),
  } as Socket & {
    readonly sent: Array<string>
    readonly closed: Array<readonly [number | undefined, string | undefined]>
  }
}

const controller = (overrides: Partial<Controller> = {}): Controller =>
  ({
    provision: () => Effect.die("unused"),
    replace: () => Effect.die("unused"),
    resume: () => Effect.die("unused"),
    pause: () => Effect.die("unused"),
    kill: () => Effect.die("unused"),
    hello: () =>
      Effect.succeed({
        version: 1,
        fence,
        sessionToken: Redacted.make("session-token"),
        leaseEpoch: 1,
        leaseExpiresAt: 4_102_444_800_000,
        heartbeatIntervalMillis: 20,
        cursor: { sequence: 0, value: "" },
      }),
    reconnect: () => Effect.die("unused"),
    validateAccess: () => Effect.void,
    heartbeat: () =>
      Effect.succeed({
        version: 1,
        fence,
        leaseEpoch: 1,
        leaseExpiresAt: 4_102_444_800_000,
        cursor: { sequence: 1, value: "cursor-1" },
      }),
    checkpoint: () => Effect.die("unused"),
    credential: () => Effect.die("unused"),
    revokeCredential: () => Effect.die("unused"),
    workspace: () => Effect.die("unused"),
    ready: () => Effect.void,
    loadSetupCache: () => Effect.succeed(null),
    storeSetupCache: () => Effect.void,
    activatePhase: () => Effect.die("unused"),
    cleanupOrphans: Effect.die("unused"),
    ...overrides,
  }) as Controller

const workspaceReady = (gateway: Gateway, target: ReturnType<typeof socket>, current = access) => {
  const retained = target.sent.length
  return gateway
    .receive(
      target,
      encode({
        _tag: "ExecutorWorkspaceReady",
        access: current,
        proof: {
          workspaceId: "workspace-1",
          repositoryId: null,
          baseCommit: null,
          headCommit: null,
          setupHookDigest: `sha256:${"a".repeat(64)}`,
          environmentDigest,
          templateBuildId: "build-1",
          restoredCheckpointId: null,
        },
        capabilities: workspaceCapabilities,
      }),
    )
    .pipe(Effect.tap(() => Effect.sync(() => target.sent.splice(retained, 1))))
}

describe("executor gateway", () => {
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
            capabilities: { cells: true, checkpoints: true, pty: true },
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
            capabilities: { cells: true, checkpoints: true, pty: true },
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
            capabilities: { cells: true, checkpoints: true, pty: true },
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
            capabilities: { cells: true, checkpoints: false, pty: true },
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

  it.effect("reports a registered executor inactive when its durable authority is revoked", () =>
    Effect.gen(function* () {
      const target = socket()
      let active = true
      const gateway = yield* makeGateway(
        controller({
          validateAccess: () =>
            active ? Effect.void : Effect.fail(ControllerError.make({ kind: "fenced", message: "revoked" })),
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
            capabilities: { cells: true, checkpoints: false, pty: true },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      expect(yield* gateway.active(target)).toBe(true)
      active = false
      expect(yield* gateway.active(target)).toBe(false)
    }),
  )

  it.effect("correlates Workspace requests and replays them on a resumed executor session", () =>
    Effect.gen(function* () {
      const first = socket()
      const resumed = socket()
      const gateway = yield* makeGateway(
        controller({
          reconnect: () =>
            Effect.succeed({
              version: 1,
              fence,
              leaseEpoch: 2,
              leaseExpiresAt: 4_102_444_800_000,
              heartbeatIntervalMillis: 20,
              cursor: { sequence: 1, value: "cursor-1" },
            }),
        }),
      )
      yield* gateway.receive(
        first,
        encode({
          _tag: "ExecutorHello",
          lifecycle: "fresh",
          environmentDigest,
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence,
            templateBuildId: "build-1",
            capabilities: { cells: true, checkpoints: false, pty: true },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* workspaceReady(gateway, first)
      const request = {
        _tag: "WorkspaceFileInspect" as const,
        requestId: "inspect-1",
        path: "src/main.ts",
        maximumBytes: 1024,
      }
      const pending = yield* Effect.forkChild(gateway.workspace("assignment-1", request))
      yield* Effect.yieldNow
      expect(
        first.sent.map((message) => decode(message)).find((message) => message._tag === "WorkspaceRequest"),
      ).toEqual({
        _tag: "WorkspaceRequest",
        fence,
        request,
      })

      yield* gateway.disconnected(first)
      yield* gateway.receive(resumed, encode({ _tag: "ExecutorReconnect", access }))
      const resumedAccess = { ...access, leaseEpoch: 2 }
      yield* workspaceReady(gateway, resumed, resumedAccess)
      expect(
        resumed.sent.map((message) => decode(message)).find((message) => message._tag === "WorkspaceRequest"),
      ).toEqual({
        _tag: "WorkspaceRequest",
        fence,
        request,
      })
      const response = {
        _tag: "WorkspaceFileContent" as const,
        requestId: "inspect-1",
        path: "src/main.ts",
        sizeBytes: 2,
        contentBase64: "e30=",
      }
      yield* gateway.receive(resumed, encode({ _tag: "WorkspaceResponse", access: resumedAccess, response }))
      expect(yield* Fiber.join(pending)).toEqual(response)
    }),
  )

  it.effect("rejects an acknowledged Hello replay without displacing the live socket", () =>
    Effect.gen(function* () {
      const first = socket()
      const replay = socket()
      const gateway = yield* makeGateway(controller())
      const hello = encode({
        _tag: "ExecutorHello",
        lifecycle: "fresh",
        environmentDigest,
        hello: {
          minimumVersion: 1,
          maximumVersion: 1,
          fence,
          templateBuildId: "build-1",
          capabilities: { cells: true, checkpoints: false, pty: false },
          workspaceCapabilities,
          cursors: { command: 0, event: 0, pty: 0 },
          latestCheckpointId: null,
          bootstrapToken: "bootstrap-token",
        },
      })
      yield* gateway.receive(first, hello)
      yield* gateway.receive(replay, hello)
      expect(first.closed).toEqual([])
      expect(replay.sent).toEqual([])
      expect(replay.closed).toEqual([[1008, "duplicate"]])
    }),
  )

  it.effect("replaces authority instead of accepting a stale reconnect when no live session exists", () =>
    Effect.gen(function* () {
      const target = socket()
      let replacements = 0
      const gateway = yield* makeGateway(
        controller({
          reconnect: () => Effect.fail(ControllerError.make({ kind: "fenced", message: "stale reconnect" })),
          replace: () =>
            Effect.sync(() => {
              replacements += 1
              return {
                assignmentId: "assignment-1",
                threadId: "thread-1",
                generation: 2,
                templateBuildId: "build-1",
                sandboxId: "sandbox-2",
                state: "provisioning" as const,
                cursor: { sequence: 0, value: "" },
              }
            }),
        }),
      )
      yield* gateway.receive(target, encode({ _tag: "ExecutorReconnect", access }))
      expect(replacements).toBe(1)
      expect(decode(target.sent[0]!)).toEqual({ _tag: "Fenced", fence, message: "stale reconnect" })
      expect(target.closed).toEqual([[1008, "fenced"]])
    }),
  )

  it.effect("does not replace a provisioning resume when its persisted reconnect is fenced", () =>
    Effect.gen(function* () {
      const target = socket()
      let replacements = 0
      const gateway = yield* makeGateway(
        controller({
          reconnect: () => Effect.fail(ControllerError.make({ kind: "fenced", message: "resume in progress" })),
          validateAccess: () => Effect.fail(ControllerError.make({ kind: "fenced", message: "not active" })),
          replace: () =>
            Effect.sync(() => {
              replacements += 1
              return {
                assignmentId: "assignment-1",
                threadId: "thread-1",
                generation: 2,
                templateBuildId: "build-1",
                sandboxId: "sandbox-2",
                state: "provisioning" as const,
                cursor: { sequence: 0, value: "" },
              }
            }),
        }),
      )
      yield* gateway.receive(target, encode({ _tag: "ExecutorReconnect", access }))
      expect(replacements).toBe(0)
      expect(target.closed).toEqual([[1008, "fenced"]])
    }),
  )

  it.effect("dispatches a cell once and retains its first operational window", () =>
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
            capabilities: { cells: true, checkpoints: false, pty: false },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* workspaceReady(gateway, target)
      const running = yield* Effect.forkChild(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-1",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "echo hosted-mvp",
        }),
      )
      yield* Effect.yieldNow
      const repeated = yield* Effect.forkChild(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-1",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          admittedAt: "2026-08-25T00:00:00.000Z",
          deadlineAt: "2026-08-25T00:02:00.000Z",
          code: "echo hosted-mvp",
        }),
      )
      yield* Effect.yieldNow
      const dispatched = target.sent.map((message) => decode(message)).find((message) => message._tag === "CellExecute")
      expect(dispatched).toMatchObject({
        _tag: "CellExecute",
        request: {
          access,
          operationKey: "operation-1",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "echo hosted-mvp",
          bindings: bindings.manifest,
        },
      })
      const response = { _tag: "Success" as const, result: { stdout: "hosted-mvp\n", stderr: "", exitCode: 0 } }
      for (const frame of [
        { _tag: "Accepted" as const, attribution: attribution("operation-1"), cursor: 1 },
        { _tag: "Started" as const, attribution: attribution("operation-1"), cursor: 2 },
      ])
        yield* gateway.receive(target, encode({ _tag: "CellLifecycle", access, frame }))
      yield* gateway.receive(
        target,
        encode({
          _tag: "CellLifecycle",
          access,
          frame: {
            _tag: "Terminal",
            attribution: attribution("operation-1"),
            cursor: 3,
            outcome: "completed",
            response,
          },
        }),
      )
      expect(
        target.sent.map((message) => decode(message)).find((message) => message._tag === "CellTerminalReceipt"),
      ).toEqual({
        _tag: "CellTerminalReceipt",
        access,
        operationKey: "operation-1",
        attempt: 0,
        cursor: 3,
      })
      yield* gateway.receive(
        target,
        encode({
          _tag: "CellResult",
          access,
          operationKey: "operation-1",
          attempt: 0,
          response,
        }),
      )
      expect(yield* Fiber.join(running)).toEqual({
        access,
        response,
        outcome: "completed",
      })
      expect(yield* Fiber.join(repeated)).toEqual({
        access,
        response,
        outcome: "completed",
      })
      expect(target.sent.map((message) => decode(message)).filter((message) => message._tag === "CellExecute")).toHaveLength(
        1,
      )
    }),
  )

  it.effect("replays a durable Orb receipt request after API replacement", () =>
    Effect.gen(function* () {
      const retained = lifecycleStore()
      const firstSocket = socket()
      const first = yield* makeGateway(controller(), undefined, undefined, readyPreparation, retained)
      yield* first.receive(
        firstSocket,
        encode({
          _tag: "ExecutorHello",
          lifecycle: "fresh",
          environmentDigest,
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence,
            templateBuildId: "build-1",
            capabilities: { cells: true, checkpoints: false, pty: false },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* workspaceReady(first, firstSocket)
      const running = yield* Effect.forkChild(
        first.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-api-restart",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "wait for api restart",
        }),
      )
      yield* Effect.yieldNow
      for (const frame of [
        { _tag: "Accepted" as const, attribution: attribution("operation-api-restart"), cursor: 1 },
        { _tag: "Started" as const, attribution: attribution("operation-api-restart"), cursor: 2 },
      ])
        yield* first.receive(firstSocket, encode({ _tag: "CellLifecycle", access, frame }))
      yield* Fiber.interrupt(running)
      expect(
        firstSocket.sent.map((message) => decode(message)).some((message) => message._tag === "CellCancel"),
      ).toBe(false)

      const restartedSocket = socket()
      const restarted = yield* makeGateway(controller(), undefined, undefined, readyPreparation, retained)
      yield* restarted.receive(
        restartedSocket,
        encode({
          _tag: "ExecutorHello",
          lifecycle: "fresh",
          environmentDigest,
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence,
            templateBuildId: "build-1",
            capabilities: { cells: true, checkpoints: false, pty: false },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* workspaceReady(restarted, restartedSocket)
      expect(
        restartedSocket.sent
          .map((message) => decode(message))
          .find(
            (message) => message._tag === "CellReplay" && message.operationKey === "operation-api-restart",
          ),
      ).toEqual({
        _tag: "CellReplay",
        access,
        operationKey: "operation-api-restart",
        attempt: 0,
        afterCursor: 2,
      })
    }),
  )

  it.effect("keeps the late executor terminal authoritative after the caller deadline", () =>
    Effect.gen(function* () {
      const observability: Array<ReturnType<typeof Logger.formatStructured.log>> = []
      const observed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(
            Logger.CurrentLoggers,
            new Set([Logger.map(Logger.formatStructured, (record) => observability.push(record))]),
          ),
        )
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
            capabilities: { cells: true, checkpoints: false, pty: false },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* workspaceReady(gateway, target)
      const running = yield* Effect.forkChild(
        observed(
          gateway.execute({
            assignmentId: "assignment-1",
            operationKey: "operation-deadline",
            workspaceId: "workspace-1",
            sessionId: "thread-1",
            ...cellIdentity,
            deadlineAt: "1970-01-01T00:00:01.000Z",
            code: "wait forever",
          }),
        ),
      )
      yield* Effect.yieldNow
      for (const frame of [
        { _tag: "Accepted" as const, attribution: attribution("operation-deadline"), cursor: 1 },
        { _tag: "Started" as const, attribution: attribution("operation-deadline"), cursor: 2 },
      ])
        yield* gateway.receive(target, encode({ _tag: "CellLifecycle", access, frame }))
      yield* TestClock.adjust("1 second")
      expect(yield* Fiber.join(running)).toEqual({
        response: {
          _tag: "DomainFailure",
          failure: { kind: "unknown", message: "Executor operation outcome is unknown after executor loss" },
        },
        outcome: "unknown",
      })
      expect(
        target.sent
          .map((message) => decode(message))
          .some((message) => message._tag === "CellCancel" && message.operationKey === "operation-deadline"),
      ).toBe(true)

      const cancelled = {
        _tag: "DomainFailure" as const,
        failure: { kind: "cancelled", message: "Cell operation was cancelled" },
      }
      yield* observed(
        gateway.receive(
          target,
          encode({
            _tag: "CellLifecycle",
            access,
            frame: {
              _tag: "Terminal",
              attribution: attribution("operation-deadline"),
              cursor: 3,
              outcome: "cancelled",
              response: cancelled,
            },
          }),
        ),
      )
      yield* gateway.receive(
        target,
        encode({
          _tag: "CellResult",
          access,
          operationKey: "operation-deadline",
          attempt: 0,
          response: cancelled,
        }),
      )
      expect(target.closed).toEqual([])
      const renderedObservability = encodeUnknown(observability)
      expect(renderedObservability.match(/hosted\.terminal\.unknown/g)).toHaveLength(1)
      expect(renderedObservability.match(/hosted\.terminal\.interrupted/g)).toHaveLength(1)
      const deadlineAcknowledgements = target.sent
        .map((message) => decode(message))
        .filter(
          (message) =>
            (message._tag === "CellTerminalReceipt" || message._tag === "CellTerminalSuperseded") &&
            message.operationKey === "operation-deadline",
        )
      expect(deadlineAcknowledgements).toEqual([
        {
          _tag: "CellTerminalReceipt",
          access,
          operationKey: "operation-deadline",
          attempt: 0,
          cursor: 3,
        },
      ])

      const next = yield* Effect.forkChild(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-after-deadline",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "42",
        }),
      )
      yield* Effect.yieldNow
      const response = { _tag: "Success" as const, result: 42 }
      for (const frame of [
        { _tag: "Accepted" as const, attribution: attribution("operation-after-deadline"), cursor: 1 },
        { _tag: "Started" as const, attribution: attribution("operation-after-deadline"), cursor: 2 },
        {
          _tag: "Terminal" as const,
          attribution: attribution("operation-after-deadline"),
          cursor: 3,
          outcome: "completed" as const,
          response,
        },
      ])
        yield* gateway.receive(target, encode({ _tag: "CellLifecycle", access, frame }))
      yield* gateway.receive(
        target,
        encode({
          _tag: "CellResult",
          access,
          operationKey: "operation-after-deadline",
          attempt: 0,
          response,
        }),
      )
      expect(yield* Fiber.join(next)).toEqual({ access, response, outcome: "completed" })
      expect(target.closed).toEqual([])
    }),
  )

  it.effect("bounds binding and machine children by the parent cell deadline", () =>
    Effect.gen(function* () {
      const invocationStarted = yield* Deferred.make<void>()
      const cleanupStarted = yield* Deferred.make<void>()
      const releaseCleanup = yield* Deferred.make<void>()
      const cleanupCompleted = yield* Deferred.make<void>()
      const signal = yield* Effect.abortSignal
      const context = Context.empty().pipe(
        Context.add(
          ToolContext.ToolContext,
          ToolContext.ToolContext.of({
            signal,
            emit: () => Effect.void,
            sessionId: "thread-1",
            runId: "run-1",
            toolCallId: "call-1",
            operationKey: "operation-child-deadline",
          }),
        ),
        Context.add(
          NestedOperation.NestedOperations,
          NestedOperation.NestedOperations.of({ run: (_request, operation) => operation }),
        ),
      )
      const registry = HostBindingRegistry.HostBindingRegistry.of({
        descriptors: [{ module: "workspace", operations: ["read"] }],
        resolve: () => Effect.die("unused"),
        invoke: () =>
          Deferred.succeed(invocationStarted, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Deferred.succeed(cleanupStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseCleanup)),
                Effect.andThen(Deferred.succeed(cleanupCompleted, undefined)),
              ),
            ),
          ),
      })
      const authority = {
        registry,
        context,
        manifest: { digest: "c".repeat(64), descriptors: registry.descriptors },
      } as unknown as BindingAuthority
      const target = socket()
      let reconnectLease = 1
      const gateway = yield* makeGateway(
        controller({
          reconnect: () =>
            Effect.succeed({
              version: 1,
              fence,
              leaseEpoch: ++reconnectLease,
              leaseExpiresAt: 4_102_444_800_000,
              heartbeatIntervalMillis: 20,
              cursor: { sequence: 1, value: "cursor-1" },
            }),
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
            capabilities: { cells: true, checkpoints: false, pty: false },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* workspaceReady(gateway, target)
      const running = yield* Effect.forkChild(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-child-deadline",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          deadlineAt: "1970-01-01T00:00:01.000Z",
          code: "wait for children",
          bindings: authority,
        }),
      )
      yield* Effect.yieldNow
      const request = {
        module: "workspace",
        operation: "read",
        input: { path: "README.md" },
        sessionId: "thread-1",
        cellId: "call-1",
      } as const
      const beforeBoundary = yield* Effect.forkChild(
        gateway.machine("assignment-1", "operation-child-deadline", 0, {
          _tag: "ProcessStop",
          processId: "process-before-boundary",
        }),
      )
      yield* Effect.yieldNow
      const beforeBoundaryRequest = target.sent
        .map((message) => decode(message))
        .findLast((message) => message._tag === "MachineExecute")
      if (beforeBoundaryRequest?._tag !== "MachineExecute")
        return yield* Effect.die("before-boundary machine request was not sent")
      yield* gateway.receive(
        target,
        encode({
          _tag: "MachineResult",
          access,
          operationKey: beforeBoundaryRequest.operationKey,
          attempt: beforeBoundaryRequest.attempt,
          machineId: beforeBoundaryRequest.machineId,
          requestDigest: beforeBoundaryRequest.requestDigest,
          outcome: { _tag: "Success", value: { _tag: "ProcessStopped" } },
        }),
      )
      expect(yield* Fiber.join(beforeBoundary)).toEqual({ _tag: "Success", value: { _tag: "ProcessStopped" } })
      const machine = yield* Effect.forkChild(
        gateway.machine("assignment-1", "operation-child-deadline", 0, {
          _tag: "ProcessStop",
          processId: "process-at-boundary",
        }),
      )
      yield* Effect.yieldNow
      const machineRequest = target.sent
        .map((message) => decode(message))
        .findLast((message) => message._tag === "MachineExecute")
      if (machineRequest?._tag !== "MachineExecute") return yield* Effect.die("machine request was not sent")
      const firstResumed = socket()
      const firstResumedAccess = { ...access, leaseEpoch: 2 }
      yield* gateway.disconnected(target)
      yield* gateway.receive(firstResumed, encode({ _tag: "ExecutorReconnect", access }))
      yield* workspaceReady(gateway, firstResumed, firstResumedAccess)
      expect(
        firstResumed.sent.map((message) => decode(message)).filter((message) => message._tag === "MachineExecute"),
      ).toEqual([
        expect.objectContaining({
          _tag: "MachineExecute",
          operationKey: machineRequest.operationKey,
          machineId: machineRequest.machineId,
        }),
      ])
      const binding = yield* Effect.forkChild(
        gateway.receive(
          firstResumed,
          encode({
            _tag: "BindingInvoke",
            access: firstResumedAccess,
            operationKey: "operation-child-deadline",
            attempt: 0,
            callId: "operation-child-deadline:binding:0",
            requestDigest: bindingRequestDigest(request),
            request,
          }),
        ),
      )
      yield* Deferred.await(invocationStarted)
      const advancing = yield* Effect.forkChild(TestClock.adjust("1 second"))
      yield* Deferred.await(cleanupStarted)
      expect(yield* Fiber.join(machine)).toEqual({
        _tag: "Unknown",
        message: "Machine outcome is unknown at the operation deadline",
      })
      expect(yield* Fiber.join(running)).toMatchObject({ outcome: "unknown" })
      expect(binding.pollUnsafe()).toBeUndefined()
      expect(
        firstResumed.sent.map((message) => decode(message)).filter((message) => message._tag === "BindingResult"),
      ).toEqual([])
      expect((yield* Deferred.poll(releaseCleanup))._tag).toBe("None")
      yield* gateway.receive(
        firstResumed,
        encode({
          _tag: "MachineResult",
          access: firstResumedAccess,
          operationKey: machineRequest.operationKey,
          attempt: machineRequest.attempt,
          machineId: machineRequest.machineId,
          requestDigest: machineRequest.requestDigest,
          outcome: { _tag: "Success", value: { _tag: "ProcessStopped" } },
        }),
      )
      expect(firstResumed.closed).toEqual([])
      yield* Deferred.succeed(releaseCleanup, undefined)
      yield* Deferred.await(cleanupCompleted)
      yield* Fiber.join(binding)
      yield* Fiber.join(advancing)
      expect(
        firstResumed.sent.map((message) => decode(message)).filter((message) => message._tag === "BindingResult"),
      ).toEqual([
        expect.objectContaining({
          _tag: "BindingResult",
          outcome: { _tag: "Unknown", message: "Cell binding outcome is unknown at the operation deadline" },
        }),
      ])

      const resumed = socket()
      const resumedAccess = { ...access, leaseEpoch: 3 }
      yield* gateway.disconnected(firstResumed)
      yield* gateway.receive(resumed, encode({ _tag: "ExecutorReconnect", access: firstResumedAccess }))
      yield* workspaceReady(gateway, resumed, resumedAccess)
      expect(
        resumed.sent.map((message) => decode(message)).filter((message) => message._tag === "MachineExecute"),
      ).toEqual([])

      const next = yield* Effect.forkChild(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-after-child-deadline",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "42",
        }),
      )
      yield* Effect.yieldNow
      const nextResponse = { _tag: "Success" as const, result: 42 }
      for (const frame of [
        { _tag: "Accepted" as const, attribution: attribution("operation-after-child-deadline"), cursor: 1 },
        { _tag: "Started" as const, attribution: attribution("operation-after-child-deadline"), cursor: 2 },
        {
          _tag: "Terminal" as const,
          attribution: attribution("operation-after-child-deadline"),
          cursor: 3,
          outcome: "completed" as const,
          response: nextResponse,
        },
      ])
        yield* gateway.receive(resumed, encode({ _tag: "CellLifecycle", access: resumedAccess, frame }))
      yield* gateway.receive(
        resumed,
        encode({
          _tag: "CellResult",
          access: resumedAccess,
          operationKey: "operation-after-child-deadline",
          attempt: 0,
          response: nextResponse,
        }),
      )
      expect(yield* Fiber.join(next)).toEqual({ access: resumedAccess, response: nextResponse, outcome: "completed" })
      expect(resumed.closed).toEqual([])
    }),
  )

  it.effect("runs binding cleanup before an interrupted receive fiber exits", () =>
    Effect.gen(function* () {
      const invocationStarted = yield* Deferred.make<void>()
      const cleanupStarted = yield* Deferred.make<void>()
      const releaseCleanup = yield* Deferred.make<void>()
      const cleanupCompleted = yield* Deferred.make<void>()
      const signal = yield* Effect.abortSignal
      const context = Context.empty().pipe(
        Context.add(
          ToolContext.ToolContext,
          ToolContext.ToolContext.of({
            signal,
            emit: () => Effect.void,
            sessionId: "thread-1",
            runId: "run-1",
            toolCallId: "call-1",
            operationKey: "operation-interrupted-binding",
          }),
        ),
        Context.add(
          NestedOperation.NestedOperations,
          NestedOperation.NestedOperations.of({ run: (_request, operation) => operation }),
        ),
      )
      const registry = HostBindingRegistry.HostBindingRegistry.of({
        descriptors: [{ module: "workspace", operations: ["read"] }],
        resolve: () => Effect.die("unused"),
        invoke: () =>
          Deferred.succeed(invocationStarted, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Deferred.succeed(cleanupStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseCleanup)),
                Effect.andThen(Deferred.succeed(cleanupCompleted, undefined)),
              ),
            ),
          ),
      })
      const authority = {
        registry,
        context,
        manifest: { digest: "d".repeat(64), descriptors: registry.descriptors },
      } as unknown as BindingAuthority
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
            capabilities: { cells: true, checkpoints: false, pty: false },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* workspaceReady(gateway, target)
      const running = yield* Effect.forkChild(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-interrupted-binding",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "wait for binding",
          bindings: authority,
        }),
      )
      yield* Effect.yieldNow
      const request = {
        module: "workspace",
        operation: "read",
        input: { path: "README.md" },
        sessionId: "thread-1",
        cellId: "call-1",
      } as const
      const receiving = yield* Effect.forkChild(
        gateway.receive(
          target,
          encode({
            _tag: "BindingInvoke",
            access,
            operationKey: "operation-interrupted-binding",
            attempt: 0,
            callId: "operation-interrupted-binding:binding:0",
            requestDigest: bindingRequestDigest(request),
            request,
          }),
        ),
      )
      yield* Deferred.await(invocationStarted)
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(receiving))
      yield* Deferred.await(cleanupStarted)
      expect(receiving.pollUnsafe()).toBeUndefined()
      expect(interrupting.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(releaseCleanup, undefined)
      yield* Deferred.await(cleanupCompleted)
      yield* Fiber.join(interrupting)
      expect(receiving.pollUnsafe()).toBeDefined()
      expect(
        target.sent.map((message) => decode(message)).filter((message) => message._tag === "BindingResult"),
      ).toEqual([])
      yield* Fiber.interrupt(running)
    }),
  )

  it.effect("runs canonical nested bindings under captured API authority and deduplicates replays", () =>
    Effect.gen(function* () {
      const observability: Array<ReturnType<typeof Logger.formatStructured.log>> = []
      const observed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(
            Logger.CurrentLoggers,
            new Set([Logger.map(Logger.formatStructured, (record) => observability.push(record))]),
          ),
        )
      const nestedRequests: Array<NestedOperation.Request> = []
      const signal = yield* Effect.abortSignal
      const context = Context.empty().pipe(
        Context.add(
          ToolContext.ToolContext,
          ToolContext.ToolContext.of({
            signal,
            emit: () => Effect.void,
            sessionId: "thread-1",
            runId: "run-1",
            toolCallId: "call-1",
            operationKey: "operation-bindings",
          }),
        ),
        Context.add(
          NestedOperation.NestedOperations,
          NestedOperation.NestedOperations.of({
            run: (request) => {
              nestedRequests.push(request as unknown as NestedOperation.Request)
              return NestedOperation.NestedOperationSuspended.make({
                token: "approval-token",
                operationKey: "operation-bindings",
                ordinal: 0,
                capability: request.approval?.capability ?? "unknown",
              })
            },
          }),
        ),
      )
      const registry = yield* HostBindingRegistry.make([
        WorkspaceBinding.module as HostBindingRegistry.Module<never>,
      ]).pipe(Effect.provideContext(context))
      const authority = {
        registry,
        context,
        manifest: { digest: "b".repeat(64), descriptors: registry.descriptors },
      } as unknown as BindingAuthority
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
            capabilities: { cells: true, checkpoints: false, pty: false },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* workspaceReady(gateway, target)
      const running = yield* Effect.forkChild(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-bindings",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: 'await rika.workspace.write({ path: "a", content: "b" })',
          bindings: authority,
        }),
      )
      yield* Effect.yieldNow
      const request = {
        module: "workspace",
        operation: "write",
        input: { path: "private-tool-input", content: "private-tool-input-secret" },
        sessionId: "thread-1",
        cellId: "call-1",
      } as const
      const invoke = {
        _tag: "BindingInvoke" as const,
        access,
        operationKey: "operation-bindings",
        attempt: 0,
        callId: "operation-bindings:binding:0",
        requestDigest: bindingRequestDigest(request),
        request,
      }
      yield* observed(gateway.receive(target, encode(invoke)))
      yield* observed(gateway.receive(target, encode(invoke)))
      const results = target.sent.map((value) => decode(value)).filter((message) => message._tag === "BindingResult")
      expect(results).toHaveLength(2)
      expect(results[0]?.outcome).toEqual({ _tag: "Suspend", token: "approval-token" })
      expect(nestedRequests).toHaveLength(1)
      expect(nestedRequests[0]).toMatchObject({
        kind: "rika.tool.workspace.write",
        replayPolicy: "never",
        approval: {
          capability: "workspace.write",
          request: {
            policy: { id: "hosted-tool-policy", version: 1 },
            operation: { module: "workspace", name: "write" },
            workspace: "workspace-1",
          },
        },
      })

      const missing = { ...request, operation: "missing" }
      yield* observed(
        gateway.receive(
          target,
          encode({
            ...invoke,
            callId: "operation-bindings:binding:1",
            requestDigest: bindingRequestDigest(missing),
            request: missing,
          }),
        ),
      )
      const rejected = target.sent.map((value) => decode(value)).findLast((message) => message._tag === "BindingResult")
      expect(rejected?._tag === "BindingResult" && rejected.outcome).toEqual({
        _tag: "Unknown",
        message: "Tool admission could not durably record its decision",
      })
      const renderedObservability = encodeUnknown(observability)
      const bindingCorrelation = {
        "rika.thread.id": "thread-1",
        "rika.turn.id": "turn-1",
        "rika.run.id": "run-1",
        "rika.operation.id": "operation-bindings",
        "rika.cell.id": "call-1",
      }
      expect(milestone(observability, "hosted.binding_send.success").map((record) => record.annotations)).toEqual([
        {
          ...bindingCorrelation,
          "rika.binding.id": "operation-bindings:binding:0",
          "rika.hosted.stage": "binding_send",
          "rika.hosted.outcome": "success",
        },
        {
          ...bindingCorrelation,
          "rika.binding.id": "operation-bindings:binding:1",
          "rika.hosted.stage": "binding_send",
          "rika.hosted.outcome": "success",
        },
      ])
      expect(milestone(observability, "hosted.binding_terminal.success")[0]?.annotations).toMatchObject({
        ...bindingCorrelation,
        "rika.binding.id": "operation-bindings:binding:0",
        "rika.hosted.stage": "binding_terminal",
        "rika.hosted.outcome": "success",
      })
      expect(milestone(observability, "hosted.binding_terminal.unknown")[0]?.annotations).toMatchObject({
        ...bindingCorrelation,
        "rika.binding.id": "operation-bindings:binding:1",
        "rika.hosted.stage": "binding_terminal",
        "rika.hosted.outcome": "unknown",
      })
      expect(renderedObservability).not.toContain("hosted.binding.")
      expect(renderedObservability).not.toContain("assignment-1")
      expect(renderedObservability).not.toContain(access.fence.instanceId)
      expect(renderedObservability).not.toContain("private-tool-input")
      expect(renderedObservability).not.toContain("private-tool-input-secret")
      expect(renderedObservability).not.toContain("approval-token")

      const conflicting = { ...request, input: { path: "a", content: "different" } }
      yield* gateway.receive(
        target,
        encode({
          ...invoke,
          requestDigest: bindingRequestDigest(conflicting),
          request: conflicting,
        }),
      )
      expect(target.closed).toContainEqual([1008, "fenced"])
      yield* Fiber.interrupt(running)
    }),
  )

  it.effect("never dispatches a cell for stale durable workspace readiness", () =>
    Effect.gen(function* () {
      const target = socket()
      const checked: Array<Parameters<PreparationStore["ready"]>[0]> = []
      const preparation: PreparationStore = {
        ...readyPreparation,
        ready: (candidate) => {
          checked.push(candidate)
          return Effect.fail(GatewayError.make({ kind: "fenced", message: "Workspace readiness fence is stale" }))
        },
      }
      const gateway = yield* makeGateway(controller(), undefined, undefined, preparation)
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
            capabilities: { cells: true, checkpoints: false, pty: false },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* workspaceReady(gateway, target)
      yield* Effect.flip(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "not-ready",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "echo should-not-run",
        }),
      )
      expect(checked).toEqual([access])
      expect(target.sent.map((message) => decode(message)._tag)).toEqual(["ExecutorWelcome", "PhaseEnvironmentGranted"])
    }),
  )

  it.effect("persists one bounded lifecycle before acknowledging terminal replay", () =>
    Effect.gen(function* () {
      const observability: Array<ReturnType<typeof Logger.formatStructured.log>> = []
      const observed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(
            Logger.CurrentLoggers,
            new Set([Logger.map(Logger.formatStructured, (record) => observability.push(record))]),
          ),
        )
      const target = socket()
      const persisted: Array<string> = []
      const gateway = yield* makeGateway(controller(), (_access, frame) =>
        Effect.sync(() => persisted.push(`${frame.cursor}:${frame._tag}`)).pipe(
          Effect.as({ _tag: "Appended" as const }),
        ),
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
            capabilities: { cells: true, checkpoints: false, pty: false },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* workspaceReady(gateway, target)
      const running = yield* Effect.forkChild(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-lifecycle",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "private-cell-input-secret",
        }),
      )
      yield* Effect.yieldNow
      const identity = attribution("operation-lifecycle")
      const lifecycle = [
        { _tag: "Accepted" as const, attribution: identity, cursor: 1 },
        { _tag: "Started" as const, attribution: identity, cursor: 2 },
        ...Array.from({ length: 16 }, (_, index) => ({
          _tag: "Output" as const,
          attribution: identity,
          cursor: index + 3,
          stream: "stdout" as const,
          text: `output-${index}`,
          redacted: true as const,
          truncated: false,
        })),
      ]
      for (const frame of lifecycle)
        yield* observed(gateway.receive(target, encode({ _tag: "CellLifecycle", access, frame })))
      const response = { _tag: "Success" as const, result: "private-cell-output-secret" }
      const terminalFrame = {
        _tag: "Terminal" as const,
        attribution: identity,
        cursor: 19,
        outcome: "completed" as const,
        response,
      }
      yield* observed(gateway.receive(target, encode({ _tag: "CellLifecycle", access, frame: terminalFrame })))
      yield* observed(gateway.receive(target, encode({ _tag: "CellLifecycle", access, frame: terminalFrame })))
      expect(persisted).toEqual(lifecycle.map((frame) => `${frame.cursor}:${frame._tag}`).concat("19:Terminal"))
      expect(
        target.sent.map((message) => decode(message)).filter((message) => message._tag === "CellTerminalReceipt"),
      ).toHaveLength(2)
      const renderedObservability = encodeUnknown(observability)
      const cellCorrelation = {
        "rika.thread.id": "thread-1",
        "rika.turn.id": "turn-1",
        "rika.run.id": "run-1",
        "rika.operation.id": "operation-lifecycle",
        "rika.cell.id": "call-1",
      }
      expect(milestone(observability, "hosted.cell_admission.success").map((record) => record.annotations)).toEqual([
        { ...cellCorrelation, "rika.hosted.stage": "cell_admission", "rika.hosted.outcome": "success" },
      ])
      expect(milestone(observability, "hosted.terminal.success").map((record) => record.annotations)).toEqual([
        { ...cellCorrelation, "rika.hosted.stage": "terminal", "rika.hosted.outcome": "success" },
      ])
      expect(renderedObservability).not.toContain("private-cell-input-secret")
      expect(renderedObservability).not.toContain("private-cell-output-secret")
      expect(renderedObservability).not.toContain(access.sessionToken)
      yield* gateway.receive(
        target,
        encode({ _tag: "CellResult", access, operationKey: "operation-lifecycle", attempt: 0, response }),
      )
      expect((yield* Fiber.join(running)).response).toEqual(response)
    }),
  )

  it.effect("rejects an out-of-order lifecycle frame before persisting it", () =>
    Effect.gen(function* () {
      const target = socket()
      const persisted: Array<string> = []
      const gateway = yield* makeGateway(controller(), (_access, frame) =>
        Effect.sync(() => persisted.push(`${frame.cursor}:${frame._tag}`)).pipe(
          Effect.as({ _tag: "Appended" as const }),
        ),
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
            capabilities: { cells: true, checkpoints: false, pty: false },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      const running = yield* Effect.forkChild(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-out-of-order",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "42",
        }),
      )
      yield* Effect.yieldNow
      yield* gateway.receive(
        target,
        encode({
          _tag: "CellLifecycle",
          access,
          frame: {
            _tag: "Started",
            attribution: attribution("operation-out-of-order"),
            cursor: 2,
          },
        }),
      )
      expect(persisted).toEqual([])
      expect(target.closed).toEqual([[1008, "fenced"]])
      yield* Fiber.interrupt(running)
    }),
  )

  it.effect("hydrates a durable terminal after API replacement", () =>
    Effect.gen(function* () {
      const target = socket()
      const response = { _tag: "Success" as const, result: 42 }
      const identity = attribution("operation-restored")
      const retained = [
        { _tag: "Accepted" as const, attribution: identity, cursor: 1 },
        { _tag: "Started" as const, attribution: identity, cursor: 2 },
        {
          _tag: "Output" as const,
          attribution: identity,
          cursor: 3,
          stream: "stdout" as const,
          text: "restored",
          redacted: true as const,
          truncated: false,
        },
        { _tag: "Terminal" as const, attribution: identity, cursor: 4, outcome: "completed" as const, response },
      ]
      const gateway = yield* makeGateway(
        controller(),
        () => Effect.succeed({ _tag: "Appended" }),
        () => Effect.succeed(retained),
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
            capabilities: { cells: true, checkpoints: false, pty: false },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* workspaceReady(gateway, target)
      const running = yield* Effect.forkChild(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-restored",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "42",
        }),
      )
      yield* Effect.yieldNow
      expect(target.sent.map((message) => decode(message)).filter((message) => message._tag === "CellExecute")).toEqual(
        [],
      )
      expect(yield* Fiber.join(running)).toEqual({ response, outcome: "completed" })
    }),
  )

  it.effect("returns durable cancelled and unknown terminals without an executor session", () =>
    Effect.gen(function* () {
      const cancelled = {
        _tag: "DomainFailure" as const,
        failure: { kind: "cancelled", message: "Cell operation was cancelled" },
      }
      const unknown = {
        _tag: "DomainFailure" as const,
        failure: { kind: "unknown", message: "Executor operation outcome is unknown after executor loss" },
      }
      const gateway = yield* makeGateway(controller(), undefined, (_assignmentId, operationKey) => {
        if (operationKey === "operation-expired-before-dispatch") return Effect.succeed([])
        const response = operationKey === "operation-cancelled-replay" ? cancelled : unknown
        const outcome = operationKey === "operation-cancelled-replay" ? ("cancelled" as const) : ("unknown" as const)
        return Effect.succeed([
          { _tag: "Accepted" as const, attribution: attribution(operationKey), cursor: 1 },
          { _tag: "Started" as const, attribution: attribution(operationKey), cursor: 2 },
          { _tag: "Terminal" as const, attribution: attribution(operationKey), cursor: 3, outcome, response },
        ])
      })
      expect(
        yield* gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-cancelled-replay",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "cancelled",
        }),
      ).toEqual({ response: cancelled, outcome: "cancelled" })
      expect(
        yield* gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-unknown-replay",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "unknown",
        }),
      ).toEqual({ response: unknown, outcome: "unknown" })
      expect(
        yield* gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-expired-before-dispatch",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          deadlineAt: "1970-01-01T00:00:00.000Z",
          code: "expired",
        }),
      ).toEqual({
        response: {
          _tag: "DomainFailure",
          failure: { kind: "timeout", message: "Cell operation deadline exceeded" },
        },
        outcome: "failed",
      })
    }),
  )

  it.effect("rejects excess output without acknowledging a terminal result", () =>
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
            capabilities: { cells: true, checkpoints: false, pty: false },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* workspaceReady(gateway, target)
      const running = yield* Effect.forkChild(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-overflow",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "42",
        }),
      )
      yield* Effect.yieldNow
      const identity = attribution("operation-overflow")
      for (const frame of [
        { _tag: "Accepted" as const, attribution: identity, cursor: 1 },
        { _tag: "Started" as const, attribution: identity, cursor: 2 },
      ])
        yield* gateway.receive(target, encode({ _tag: "CellLifecycle", access, frame }))
      for (let index = 0; index < 17; index += 1)
        yield* gateway.receive(
          target,
          encode({
            _tag: "CellLifecycle",
            access,
            frame: {
              _tag: "Output",
              attribution: identity,
              cursor: index + 3,
              stream: "stdout",
              text: "bounded",
              redacted: true,
              truncated: false,
            },
          }),
        )
      expect(target.closed.at(-1)).toEqual([1008, "fenced"])
      expect(
        target.sent.map((message) => decode(message)).some((message) => message._tag === "CellTerminalReceipt"),
      ).toBe(false)
      yield* Fiber.interrupt(running)
    }),
  )

  it.effect("sends an attributed cancellation for a running operation", () =>
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
            capabilities: { cells: true, checkpoints: false, pty: false },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* workspaceReady(gateway, target)
      const running = yield* Effect.forkChild(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-cancel",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "await never",
        }),
      )
      yield* Effect.yieldNow
      yield* gateway.cancel("assignment-1", "operation-cancel")
      expect(decode(target.sent.at(-1)!)).toEqual({
        _tag: "CellCancel",
        access,
        operationKey: "operation-cancel",
        attempt: 0,
      })
      yield* Fiber.interrupt(running)
    }),
  )

  it.effect("fences admission while quiescing and accepts only a matching operation barrier", () =>
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
            capabilities: { cells: true, checkpoints: true, pty: false },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* workspaceReady(gateway, target)
      const running = yield* Effect.forkChild(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-quiesced",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "await never",
        }),
      )
      yield* Effect.yieldNow
      const barrier = yield* Effect.forkChild(gateway.quiesce("assignment-1"))
      yield* Effect.yieldNow
      const request = decode(target.sent.at(-1)!)
      expect(request).toMatchObject({ _tag: "Quiesce", fence })
      const rejected = yield* Effect.flip(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-after-quiesce",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "echo forbidden",
        }),
      )
      expect(rejected).toMatchObject({ kind: "fenced" })
      if (request._tag !== "Quiesce") return yield* Effect.die("quiesce request missing")
      yield* gateway.receive(
        target,
        encode({
          _tag: "ExecutorQuiesced",
          access,
          requestId: request.requestId,
          operations: [{ operationKey: "operation-quiesced", outcome: "unknown" }],
          checkpoint: {
            version: 1,
            checkpointId: "checkpoint-quiesced",
            archive: { content: "eA==", contentDigest: `sha256:${"c".repeat(64)}`, sizeBytes: 1 },
            cursor: { sequence: 0, value: "" },
          },
        }),
      )
      expect(yield* Fiber.join(barrier)).toMatchObject({
        operations: [{ operationKey: "operation-quiesced", outcome: "unknown" }],
      })
      yield* Fiber.interrupt(running)
    }),
  )

  it.effect("rejects a quiesce barrier that omits active work and fails it when the socket disconnects", () =>
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
            capabilities: { cells: true, checkpoints: true, pty: false },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* workspaceReady(gateway, target)
      const running = yield* Effect.forkChild(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-omitted",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "await never",
        }),
      )
      yield* Effect.yieldNow
      const barrier = yield* Effect.forkChild(gateway.quiesce("assignment-1"))
      yield* Effect.yieldNow
      const request = decode(target.sent.at(-1)!)
      if (request._tag !== "Quiesce") return yield* Effect.die("quiesce request missing")
      yield* gateway.receive(
        target,
        encode({
          _tag: "ExecutorQuiesced",
          access,
          requestId: request.requestId,
          operations: [],
          checkpoint: {
            version: 1,
            checkpointId: "checkpoint-omitted",
            archive: { content: "eA==", contentDigest: `sha256:${"c".repeat(64)}`, sizeBytes: 1 },
            cursor: { sequence: 0, value: "" },
          },
        }),
      )
      expect(target.closed).toEqual([[1008, "fenced"]])
      yield* gateway.disconnected(target)
      expect(yield* Effect.flip(Fiber.join(barrier))).toMatchObject({ kind: "disconnected" })
      yield* Fiber.interrupt(running)
    }),
  )

  it.effect("treats setup cache storage faults as a safe miss without fencing the executor", () =>
    Effect.gen(function* () {
      const target = socket()
      const cacheFailure = ControllerError.make({ kind: "checkpoint", message: "cache unavailable" })
      const gateway = yield* makeGateway(
        controller({
          loadSetupCache: () => Effect.fail(cacheFailure),
          storeSetupCache: () => Effect.fail(cacheFailure),
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
            capabilities: { cells: true, checkpoints: true, pty: false },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      const key = {
        ownerId: "owner-1",
        repository: {
          repositoryId: "repository-1",
          owner: "In-Time-Tec",
          name: "rika",
          commitSha: "a".repeat(40),
        },
        setupHookDigest: `sha256:${"b".repeat(64)}`,
        templateBuildId: "build-1",
        environmentDigest,
      }
      yield* gateway.receive(target, encode({ _tag: "SetupCacheLookup", access, requestId: "cache-lookup", key }))
      yield* gateway.receive(
        target,
        encode({
          _tag: "SetupCacheProposed",
          access,
          requestId: "cache-store",
          key,
          archive: { content: "eA==", contentDigest: `sha256:${"c".repeat(64)}`, sizeBytes: 1 },
        }),
      )
      expect(decode(target.sent.at(-2)!)).toEqual({
        _tag: "SetupCacheResult",
        requestId: "cache-lookup",
        archive: null,
      })
      expect(decode(target.sent.at(-1)!)).toEqual({ _tag: "SetupCacheAccepted", requestId: "cache-store" })
      expect(target.closed).toEqual([])
    }),
  )

  it.effect("closes malformed frames", () =>
    Effect.gen(function* () {
      const target = socket()
      const gateway = yield* makeGateway(controller())
      yield* gateway.receive(target, "not json")
      expect(target.sent).toEqual([])
      expect(target.closed).toEqual([[1007, "malformed"]])
    }),
  )

  it.effect("fences and closes unauthorized heartbeats", () =>
    Effect.gen(function* () {
      const target = socket()
      const gateway = yield* makeGateway(
        controller({
          heartbeat: () => Effect.fail(ControllerError.make({ kind: "authentication", message: "invalid session" })),
        }),
      )
      yield* gateway.receive(
        target,
        encode({
          _tag: "ExecutorHeartbeat",
          heartbeat: { version: 1, access, cursor: { sequence: 1, value: "cursor-1" } },
        }),
      )
      expect(decode(target.sent[0]!)).toEqual({ _tag: "Fenced", fence, message: "invalid session" })
      expect(target.closed).toEqual([[1008, "authentication"]])
    }),
  )

  it.effect("fences and closes stale reconnects", () =>
    Effect.gen(function* () {
      const target = socket()
      const gateway = yield* makeGateway(
        controller({ reconnect: () => Effect.fail(ControllerError.make({ kind: "fenced", message: "stale lease" })) }),
      )
      yield* gateway.receive(target, encode({ _tag: "ExecutorReconnect", access }))
      expect(decode(target.sent[0]!)).toEqual({ _tag: "Fenced", fence, message: "stale lease" })
      expect(target.closed).toEqual([[1008, "fenced"]])
    }),
  )

  it.effect("does not send a cell after the gateway observes an expired lease", () =>
    Effect.gen(function* () {
      const target = socket()
      const gateway = yield* makeGateway(
        controller({
          hello: () =>
            Effect.succeed({
              version: 1,
              fence,
              sessionToken: Redacted.make("session-token"),
              leaseEpoch: 1,
              leaseExpiresAt: 0,
              heartbeatIntervalMillis: 20,
              cursor: { sequence: 0, value: "" },
            }),
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
            capabilities: { cells: true, checkpoints: false, pty: false },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* workspaceReady(gateway, target)
      const error = yield* Effect.flip(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "expired-operation",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "echo should-not-run",
        }),
      )
      expect(error.kind).toBe("fenced")
      expect(target.sent.map((message) => decode(message)).some((message) => message._tag === "CellExecute")).toBe(
        false,
      )
    }),
  )

  it.effect("moves pending cells to a replacement connection for the same executor", () =>
    Effect.gen(function* () {
      const firstSocket = socket()
      const replacementSocket = socket()
      const gateway = yield* makeGateway(
        controller({
          reconnect: () =>
            Effect.succeed({
              version: 1,
              fence,
              leaseEpoch: 2,
              leaseExpiresAt: 4_102_444_800_000,
              heartbeatIntervalMillis: 20,
              cursor: { sequence: 0, value: "" },
            }),
        }),
      )
      yield* gateway.receive(
        firstSocket,
        encode({
          _tag: "ExecutorHello",
          lifecycle: "fresh",
          environmentDigest,
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence,
            templateBuildId: "build-1",
            capabilities: { cells: true, checkpoints: false, pty: false },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* workspaceReady(gateway, firstSocket)
      const running = yield* Effect.forkChild(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "replacement-operation",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "echo hosted-mvp",
        }),
      )
      yield* Effect.yieldNow
      yield* gateway.receive(replacementSocket, encode({ _tag: "ExecutorReconnect", access }))
      expect(firstSocket.closed).toEqual([[1008, "fenced"]])
      const replacementAccess = { ...access, leaseEpoch: 2 }
      yield* workspaceReady(gateway, replacementSocket, replacementAccess)
      expect(
        replacementSocket.sent.map((message) => decode(message)).find((message) => message._tag === "CellReplay"),
      ).toEqual({
        _tag: "CellReplay",
        access: replacementAccess,
        operationKey: "replacement-operation",
        attempt: 0,
        afterCursor: 0,
      })
      yield* gateway.receive(
        firstSocket,
        encode({
          _tag: "CellResult",
          access,
          operationKey: "replacement-operation",
          attempt: 0,
          response: { _tag: "Success", result: { stdout: "stale\n", stderr: "", exitCode: 0 } },
        }),
      )
      const response = { _tag: "Success" as const, result: { stdout: "fresh\n", stderr: "", exitCode: 0 } }
      for (const frame of [
        { _tag: "Accepted" as const, attribution: attribution("replacement-operation"), cursor: 1 },
        { _tag: "Started" as const, attribution: attribution("replacement-operation"), cursor: 2 },
      ])
        yield* gateway.receive(replacementSocket, encode({ _tag: "CellLifecycle", access: replacementAccess, frame }))
      yield* gateway.receive(
        replacementSocket,
        encode({
          _tag: "CellLifecycle",
          access: replacementAccess,
          frame: {
            _tag: "Terminal",
            attribution: attribution("replacement-operation"),
            cursor: 3,
            outcome: "completed",
            response,
          },
        }),
      )
      yield* gateway.receive(
        replacementSocket,
        encode({
          _tag: "CellResult",
          access: replacementAccess,
          operationKey: "replacement-operation",
          attempt: 0,
          response,
        }),
      )
      expect(yield* Fiber.join(running)).toEqual({ access: replacementAccess, response, outcome: "completed" })
    }),
  )

  it.effect("fences old-generation frames and dispatches cells only to the replacement sandbox", () =>
    Effect.gen(function* () {
      const firstSocket = socket()
      const replacementSocket = socket()
      const persisted: Array<unknown> = []
      let approvedGeneration = 1
      const replacementFence = {
        ...fence,
        assignmentGeneration: 2,
        instanceId: "sandbox-2",
        executorId: "executor-2",
        processIncarnation: "process-2",
      }
      const replacementAccess = {
        version: 1 as const,
        fence: replacementFence,
        leaseEpoch: 1,
        sessionToken: "replacement-session-token",
      }
      const gateway = yield* makeGateway(
        controller({
          hello: (input) =>
            Effect.succeed({
              version: 1,
              fence: input.fence,
              sessionToken: Redacted.make(
                input.fence.assignmentGeneration === 1 ? access.sessionToken : replacementAccess.sessionToken,
              ),
              leaseEpoch: 1,
              leaseExpiresAt: 4_102_444_800_000,
              heartbeatIntervalMillis: 20,
              cursor: { sequence: 0, value: "" },
            }),
          validateAccess: (input) =>
            input.fence.assignmentGeneration === approvedGeneration
              ? Effect.void
              : Effect.fail(ControllerError.make({ kind: "fenced", message: "assignment generation is stale" })),
        }),
        (_access, frame) => Effect.sync(() => persisted.push(frame)).pipe(Effect.as({ _tag: "Appended" as const })),
      )
      yield* gateway.receive(
        firstSocket,
        encode({
          _tag: "ExecutorHello",
          lifecycle: "fresh",
          environmentDigest,
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence,
            templateBuildId: "build-1",
            capabilities: { cells: true, checkpoints: false, pty: false },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      yield* workspaceReady(gateway, firstSocket)

      approvedGeneration = 2
      yield* gateway.receive(
        replacementSocket,
        encode({
          _tag: "ExecutorHello",
          lifecycle: "replacement",
          environmentDigest,
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence: replacementFence,
            templateBuildId: "build-1",
            capabilities: { cells: true, checkpoints: true, pty: true },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: "checkpoint-1",
            bootstrapToken: "replacement-bootstrap-token",
          },
        }),
      )
      expect(firstSocket.closed).toEqual([[1008, "fenced"]])
      yield* workspaceReady(gateway, replacementSocket, replacementAccess)

      const operationKey = "generation-replacement-operation"
      const running = yield* Effect.forkChild(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey,
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "echo replacement",
        }),
      )
      yield* Effect.yieldNow
      expect(firstSocket.sent.map((message) => decode(message)).some((message) => message._tag === "CellExecute")).toBe(
        false,
      )
      expect(
        replacementSocket.sent.map((message) => decode(message)).find((message) => message._tag === "CellExecute"),
      ).toMatchObject({ _tag: "CellExecute", request: { access: replacementAccess, operationKey } })

      yield* gateway.receive(
        firstSocket,
        encode({
          _tag: "CellLifecycle",
          access,
          frame: { _tag: "Accepted", attribution: attribution(operationKey), cursor: 1 },
        }),
      )
      expect(persisted).toEqual([])

      const response = { _tag: "Success" as const, result: { stdout: "replacement\n", stderr: "", exitCode: 0 } }
      for (const frame of [
        { _tag: "Accepted" as const, attribution: attribution(operationKey), cursor: 1 },
        { _tag: "Started" as const, attribution: attribution(operationKey), cursor: 2 },
        {
          _tag: "Terminal" as const,
          attribution: attribution(operationKey),
          cursor: 3,
          outcome: "completed" as const,
          response,
        },
      ])
        yield* gateway.receive(replacementSocket, encode({ _tag: "CellLifecycle", access: replacementAccess, frame }))
      yield* gateway.receive(
        replacementSocket,
        encode({ _tag: "CellResult", access: replacementAccess, operationKey, attempt: 0, response }),
      )
      expect(yield* Fiber.join(running)).toEqual({ access: replacementAccess, response, outcome: "completed" })
      expect(persisted).toHaveLength(3)
    }),
  )
})
