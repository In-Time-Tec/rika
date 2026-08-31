import type { Interface as Controller } from "@rika/e2b-executor/controller"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import {
  ApiMessage,
  BindingRequest,
  ExecutorMessage,
  type CellLifecycleFrame,
  type CellResponse,
} from "@rika/remote-execution/protocol"
import { HostModules } from "tenetkit/repl"
import { Context, Crypto, Effect, Layer, Logger, Redacted, Schema } from "effect"
import * as GatewayModule from "../../../src/executor/gateway"
import {
  cancelledResponse,
  GatewayError,
  type BindingAuthority,
  type Gateway,
  type LifecycleStore,
  type PreparationStore,
  type Socket,
} from "../../../src/executor/gateway"
import { testToolPolicy } from "../../hosted/execution/tool-policy.fixture"
import * as CellAuthority from "@rika/kernel/test-cell-authority"

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
              operations.set(operationId, {
                state: "accepted",
                started: frames.some((frame) => frame._tag === "Started"),
              })
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
    cancel: (input) =>
      Effect.sync(() => {
        const operationId = operation(input)
        const current = operations.get(operationId) ?? { state: "accepted" as const, started: false }
        if (
          (current.state === "completed" || current.state === "unknown") &&
          current.response !== undefined &&
          current.outcome !== undefined
        )
          return {
            _tag: "AlreadyTerminal" as const,
            result: { response: current.response, outcome: current.outcome },
          }
        if (current.state === "dispatched") return { _tag: "Dispatched" as const }
        operations.set(operationId, {
          ...current,
          state: "completed",
          response: cancelledResponse,
          outcome: "cancelled",
        })
        return {
          _tag: "Cancelled" as const,
          result: { response: cancelledResponse, outcome: "cancelled" as const },
        }
      }),
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
  GatewayModule.makeGateway(
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

const bindings: BindingAuthority = {
  registry: HostModules.HostModules.of({
    descriptors: [],
    resolve: (request) => Effect.fail(HostModules.HostModuleNotFound.make({ module: request.module })),
    invoke: (request) => Effect.fail(HostModules.HostModuleNotFound.make({ module: request.module })),
  }),
  context: Effect.runSync(CellAuthority.capture()),
  manifest: { digest: "a".repeat(64), descriptors: [] },
}

const bindingAuthority = (
  registry: HostModules.Service,
  context: Context.Context<never>,
  digest: string,
): BindingAuthority => ({
  registry,
  context: Effect.runSync(CellAuthority.capture(context)),
  manifest: { digest, descriptors: registry.descriptors },
})

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

const socket = (): Socket & {
  readonly sent: Array<string>
  readonly closed: Array<readonly [number | undefined, string | undefined]>
} => {
  const sent: Array<string> = []
  const closed: Array<readonly [number | undefined, string | undefined]> = []
  return {
    sent,
    closed,
    send: (message: string) => sent.push(message),
    close: (code?: number, reason?: string) => closed.push([code, reason]),
  }
}

const controller = (overrides: Partial<Controller> = {}): Controller => ({
  provision: () => Effect.die("unused"),
  replace: () => Effect.die("unused"),
  resume: () => Effect.die("unused"),
  pause: () => Effect.die("unused"),
  kill: () => Effect.die("unused"),
  portal: () => Effect.die("unused"),
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
})

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

export const GatewayTestHarness = {
  encode,
  decode,
  encodeBindingRequest,
  encodeUnknown,
  bindingRequestDigest,
  milestone,
  ready,
  workspaceCapabilities,
  lifecycleStore,
  readyPreparation,
  environmentDigest,
  makeGateway,
  bindings,
  bindingAuthority,
  fence,
  access,
  cellIdentity,
  attribution,
  socket,
  controller,
  workspaceReady,
}
