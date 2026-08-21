import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { describe, expect, it } from "@effect/vitest"
import { ControllerError, type Interface as Controller } from "@rika/e2b-executor/controller"
import * as WorkspaceBinding from "@rika/kernel/workspace-binding"
import { ApiMessage, BindingRequest, ExecutorMessage, type CellResponse } from "@rika/remote-execution/protocol"
import { NestedOperation, ToolContext } from "tenetkit"
import { HostBindingRegistry } from "tenetkit/repl"
import { Context, Crypto, Effect, Fiber, Layer, Option, Redacted, Schema, Stream } from "effect"
import {
  GatewayError,
  makeGateway as makeGatewayService,
  type BindingAuthority,
  type LifecycleStore,
  type PreparationStore,
  type Socket,
} from "../src/executor-gateway"

const encode = Schema.encodeSync(Schema.fromJsonString(ExecutorMessage))
const decode = Schema.decodeSync(Schema.fromJsonString(ApiMessage))
const encodeBindingRequest = Schema.encodeSync(Schema.fromJsonString(BindingRequest))
const bindingRequestDigest = (request: BindingRequest) =>
  new Bun.CryptoHasher("sha256").update(encodeBindingRequest(request)).digest("hex")
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
  workspaceLifecycle: ready("workspace lifecycle ready"),
}

const lifecycleStore = (
  append: LifecycleStore["append"] = () => Effect.void,
  load: LifecycleStore["load"] = () => Effect.succeed([]),
): LifecycleStore => {
  const operations = new Map<
    string,
    {
      state: "accepted" | "dispatched" | "completed" | "unknown"
      started: boolean
      response?: CellResponse
      dispatchedGeneration?: number
      dispatchedExecutorInstanceId?: string
      dispatchedProcessIncarnation?: string
    }
  >()
  const operation = (input: {
    readonly assignmentId: string
    readonly operationKey: string
    readonly attempt: number
  }) => `${input.assignmentId}\u0000${input.operationKey}\u0000${input.attempt}`
  return {
    append: (assignmentId, frame) =>
      append(assignmentId, frame).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const operationKey = `${assignmentId}\u0000${frame.attribution.operationKey}\u0000${frame.attribution.attempt}`
            const current = operations.get(operationKey)
            if (current === undefined) return
            if (frame._tag === "Started") operations.set(operationKey, { ...current, started: true })
            if (frame._tag === "Terminal")
              operations.set(operationKey, {
                ...current,
                state: "completed",
                response: frame.response,
              })
          }),
        ),
      ),
    load,
    prepare: (input) =>
      load(input.assignmentId, input.operationKey, input.attempt).pipe(
        Effect.tap((frames) =>
          Effect.sync(() => {
            const terminal = frames.find((frame) => frame._tag === "Terminal")
            operations.set(
              operation(input),
              terminal?._tag === "Terminal"
                ? { state: "completed", started: true, response: terminal.response }
                : { state: "accepted", started: frames.some((frame) => frame._tag === "Started") },
            )
          }),
        ),
        Effect.asVoid,
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
    reassign: (input) =>
      Effect.sync(() => void operations.set(operation(input), { state: "accepted", started: false })),
    markUnknown: (input) =>
      Effect.sync(() => void operations.set(operation(input), { state: "unknown", started: true })),
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
const makeGateway = (
  service: Controller,
  append: LifecycleStore["append"] = () => Effect.void,
  load: LifecycleStore["load"] = () => Effect.succeed([]),
  preparation: PreparationStore = readyPreparation,
) =>
  makeGatewayService(
    service,
    lifecycleStore(append, load),
    {
      activate: (_access, _phase, use) => use({ digest: `sha256:${"0".repeat(64)}`, values: {}, redactedNames: [] }),
      replace: (key) =>
        service.replace(key, { phase: "runtime", allow: ["api.example.test"] }).pipe(
          Effect.asVoid,
          Effect.mapError((error) => GatewayError.make({ kind: "fenced", message: error.message })),
        ),
    },
    preparation,
    () => Effect.succeed("a".repeat(64)),
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
  replayPolicy: "pure",
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
    credential: () => Effect.die("unused"),
    revokeCredential: () => Effect.die("unused"),
    workspace: () => Effect.die("unused"),
    activatePhase: () => Effect.die("unused"),
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

  it.effect("routes assignment-fenced PTY requests and events through the live executor session", () =>
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
            capabilities: { cells: true, checkpoints: false, pty: true },
            workspaceCapabilities,
            cursors: { command: 0, event: 0, pty: 0 },
            latestCheckpointId: null,
            bootstrapToken: "bootstrap-token",
          },
        }),
      )
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
          operationKey: "operation-1",
          workspaceId: "workspace-1",
          sessionId: "thread-1",
          ...cellIdentity,
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
        manifest: { digest: "b".repeat(64), descriptors: registry.descriptors },
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

  it.effect("rejects an out-of-order lifecycle frame before persisting it", () =>
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
      expect(yield* Fiber.join(running)).toEqual({ access, response, outcome: "completed" })
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
            workspaceCapabilities,
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
})
