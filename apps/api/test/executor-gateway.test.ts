import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { describe, expect, it } from "@effect/vitest"
import { ControllerError, type Interface as Controller } from "@rika/e2b-executor/controller"
import * as WorkspaceBinding from "@rika/kernel/workspace-binding"
import { ApiMessage, BindingRequest, ExecutorMessage } from "@rika/remote-execution/protocol"
import { NestedOperation, ToolContext } from "tenetkit"
import { HostBindingRegistry } from "tenetkit/repl"
import { Context, Crypto, Effect, Fiber, Layer, Redacted, Schema } from "effect"
import {
  makeGateway as makeGatewayService,
  type BindingAuthority,
  type LifecycleStore,
  type Socket,
} from "../src/executor-gateway"

const encode = Schema.encodeSync(Schema.fromJsonString(ExecutorMessage))
const decode = Schema.decodeSync(Schema.fromJsonString(ApiMessage))
const encodeBindingRequest = Schema.encodeSync(Schema.fromJsonString(BindingRequest))
const bindingRequestDigest = (request: BindingRequest) =>
  new Bun.CryptoHasher("sha256").update(encodeBindingRequest(request)).digest("hex")
const makeGateway = (
  service: Controller,
  append: LifecycleStore["append"] = () => Effect.void,
  load: LifecycleStore["load"] = () => Effect.succeed([]),
) =>
  makeGatewayService(service, { append, load, prepare: () => Effect.void }).pipe(
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
  manifest: { digest: "bindings", descriptors: [] },
} as unknown as BindingAuthority

const fence = {
  target: "e2b" as const,
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
  admittedAt: null,
  deadline: null,
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
    checkout: () => Effect.die("unused"),
    cleanupOrphans: Effect.die("unused"),
    ...overrides,
  }) as Controller

describe("executor gateway", () => {
  it.effect("decodes hello and writes the controller welcome", () =>
    Effect.gen(function* () {
      const target = socket()
      const gateway = yield* makeGateway(controller())
      yield* gateway.receive(
        target,
        encode({
          _tag: "ExecutorHello",
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence,
            templateBuildId: "build-1",
            capabilities: { cells: true, checkpoints: true, pty: true },
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

  it.effect("rejects an acknowledged Hello replay without displacing the live socket", () =>
    Effect.gen(function* () {
      const first = socket()
      const replay = socket()
      const gateway = yield* makeGateway(controller())
      const hello = encode({
        _tag: "ExecutorHello",
        hello: {
          minimumVersion: 1,
          maximumVersion: 1,
          fence,
          templateBuildId: "build-1",
          capabilities: { cells: true, checkpoints: false, pty: false },
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

  it.effect("dispatches a cell and correlates its result", () =>
    Effect.gen(function* () {
      const target = socket()
      const gateway = yield* makeGateway(controller())
      yield* gateway.receive(
        target,
        encode({
          _tag: "ExecutorHello",
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence,
            templateBuildId: "build-1",
            capabilities: { cells: true, checkpoints: false, pty: false },
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
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
      expect(decode(target.sent[1]!)).toMatchObject({
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
      expect(decode(target.sent[2]!)).toEqual({
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
      })
    }),
  )

  it.effect("runs canonical nested bindings under captured API authority and deduplicates replays", () =>
    Effect.gen(function* () {
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
        manifest: { digest: "workspace-bindings", descriptors: registry.descriptors },
      } as unknown as BindingAuthority
      const target = socket()
      const gateway = yield* makeGateway(controller())
      yield* gateway.receive(
        target,
        encode({
          _tag: "ExecutorHello",
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence,
            templateBuildId: "build-1",
            capabilities: { cells: true, checkpoints: false, pty: false },
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
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
        input: { path: "a", content: "b" },
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
      yield* gateway.receive(target, encode(invoke))
      yield* gateway.receive(target, encode(invoke))
      const results = target.sent.map((value) => decode(value)).filter((message) => message._tag === "BindingResult")
      expect(results).toHaveLength(2)
      expect(results[0]?.outcome).toEqual({ _tag: "Suspend", token: "approval-token" })
      expect(nestedRequests).toEqual([
        {
          kind: "workspace.write",
          payload: { path: "a", content: "b" },
          replayPolicy: "never",
          approval: { capability: "workspace.write", request: { path: "a" } },
        },
      ])

      const missing = { ...request, operation: "missing" }
      yield* gateway.receive(
        target,
        encode({
          ...invoke,
          callId: "operation-bindings:binding:1",
          requestDigest: bindingRequestDigest(missing),
          request: missing,
        }),
      )
      const rejected = target.sent.map((value) => decode(value)).findLast((message) => message._tag === "BindingResult")
      expect(rejected?._tag === "BindingResult" && rejected.outcome).toMatchObject({
        _tag: "Rejected",
        failure: { _tag: "tenetkit/repl/HostBindingNotFound", module: "workspace", operation: "missing" },
      })

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

  it.effect("persists one bounded lifecycle before acknowledging terminal replay", () =>
    Effect.gen(function* () {
      const target = socket()
      const persisted: Array<string> = []
      const gateway = yield* makeGateway(controller(), (_assignmentId, frame) =>
        Effect.sync(() => persisted.push(`${frame.cursor}:${frame._tag}`)).pipe(Effect.asVoid),
      )
      yield* gateway.receive(
        target,
        encode({
          _tag: "ExecutorHello",
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence,
            templateBuildId: "build-1",
            capabilities: { cells: true, checkpoints: false, pty: false },
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
      const running = yield* Effect.forkChild(
        gateway.execute({
          assignmentId: "assignment-1",
          operationKey: "operation-lifecycle",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
          code: "42",
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
      for (const frame of lifecycle) yield* gateway.receive(target, encode({ _tag: "CellLifecycle", access, frame }))
      const response = { _tag: "Success" as const, result: 42 }
      const terminalFrame = {
        _tag: "Terminal" as const,
        attribution: identity,
        cursor: 19,
        outcome: "completed" as const,
        response,
      }
      yield* gateway.receive(target, encode({ _tag: "CellLifecycle", access, frame: terminalFrame }))
      yield* gateway.receive(target, encode({ _tag: "CellLifecycle", access, frame: terminalFrame }))
      expect(persisted).toEqual(lifecycle.map((frame) => `${frame.cursor}:${frame._tag}`).concat("19:Terminal"))
      expect(
        target.sent.map((message) => decode(message)).filter((message) => message._tag === "CellTerminalReceipt"),
      ).toHaveLength(2)
      yield* gateway.receive(
        target,
        encode({ _tag: "CellResult", access, operationKey: "operation-lifecycle", attempt: 0, response }),
      )
      expect((yield* Fiber.join(running)).response).toEqual(response)
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
        () => Effect.void,
        () => Effect.succeed(retained),
      )
      yield* gateway.receive(
        target,
        encode({
          _tag: "ExecutorHello",
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence,
            templateBuildId: "build-1",
            capabilities: { cells: true, checkpoints: false, pty: false },
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
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
      yield* gateway.receive(target, encode({ _tag: "CellLifecycle", access, frame: retained[3]! }))
      expect(decode(target.sent.at(-1)!)).toEqual({
        _tag: "CellTerminalReceipt",
        access,
        operationKey: "operation-restored",
        attempt: 0,
        cursor: 4,
      })
      yield* gateway.receive(
        target,
        encode({ _tag: "CellResult", access, operationKey: "operation-restored", attempt: 0, response }),
      )
      expect(yield* Fiber.join(running)).toEqual({ access, response })
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
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence,
            templateBuildId: "build-1",
            capabilities: { cells: true, checkpoints: false, pty: false },
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
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
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence,
            templateBuildId: "build-1",
            capabilities: { cells: true, checkpoints: false, pty: false },
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
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
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence,
            templateBuildId: "build-1",
            capabilities: { cells: true, checkpoints: false, pty: false },
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
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
      expect(target.sent).toHaveLength(1)
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
          hello: {
            minimumVersion: 1,
            maximumVersion: 1,
            fence,
            templateBuildId: "build-1",
            capabilities: { cells: true, checkpoints: false, pty: false },
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
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
      expect(decode(replacementSocket.sent[1]!)).toEqual({
        _tag: "CellReplay",
        access: replacementAccess,
        operationKey: "replacement-operation",
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
      expect(yield* Fiber.join(running)).toEqual({ access: replacementAccess, response })
    }),
  )
})
