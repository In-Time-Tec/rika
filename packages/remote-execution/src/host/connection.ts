import type { WorkspaceCapabilitySnapshot } from "@rika/product/executor-assignment"
import * as HostedObservability from "@rika/product/hosted-observability"
import { Effect, Fiber, Queue, Ref, Schema, Semaphore } from "effect"
import type { Crypto, FileSystem } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import * as Operations from "../protocol/operations"
import {
  ApiMessage,
  CheckpointRestore,
  ExecutorMessage,
  type ApiMessage as IncomingMessage,
  WorkspaceSeedRestore,
} from "../protocol/messages"
import * as HostedKernel from "./kernel"
import type { Config, Identity } from "./identity"
import type { SessionStore } from "./persistence"
import { HostError } from "./error"
import { Manager as PtyManager } from "./terminal/pty"
import { RepositoryServices } from "../workspace/repositories"
import { Runtime } from "./runtime"
import { preparation } from "./preparation"
import { apiDispatch } from "./dispatch-api"
import { applyPhaseGrant, dispatch, type PhaseGrant } from "./dispatch-pty-workspace"
import { replaceExecutionEnvironment } from "./execution-environment"
import { hostIdentity } from "./identity"

type Writer = (chunk: string) => Effect.Effect<void, Socket.SocketError>

const decodeApiMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(ApiMessage))
const encodeExecutorMessage = Schema.encodeSync(Schema.fromJsonString(ExecutorMessage))
const { persistSession, prepare, sameAccess, sameFence, waitForWelcome } = preparation
const dispatchPty = dispatch.pty(encodeExecutorMessage, sameFence)
const dispatchWorkspace = dispatch.workspace(encodeExecutorMessage, sameFence)
const consumePtyEvents = dispatch.ptyEvents(encodeExecutorMessage)
const applyGrant = (
  message: PhaseGrant,
  grants: Ref.Ref<Map<string, PhaseGrant>>,
  executionEnvironment: Record<string, string>,
  appliedEnvironment: Ref.Ref<Map<string, string>>,
  cells: HostedKernel.Interface,
  environmentAccess: Semaphore.Semaphore,
  redactedValues: Set<string> = new Set(),
) =>
  applyPhaseGrant(
    message,
    grants,
    executionEnvironment,
    appliedEnvironment,
    cells,
    environmentAccess,
    (values) => {
      replaceExecutionEnvironment(executionEnvironment)(values)
      Object.assign(executionEnvironment, values)
    },
    redactedValues,
  )
const consumeApi = apiDispatch.consume({
  encode: encodeExecutorMessage,
  persistSession,
  sameAccess,
  dispatchPty,
  dispatchWorkspace,
  applyPhaseGrant: applyGrant,
  workspaceRoot: hostIdentity.workspaceRoot,
})

export interface ConnectionOptions {
  readonly config: Config
  readonly kernelProfileDigest: string
  readonly bindingContractDigest: Ref.Ref<string | undefined>
  readonly identity: Identity
  readonly seed: WorkspaceSeedRestore | null
  readonly restore: CheckpointRestore | null
  readonly store: SessionStore
  readonly quiesced: Ref.Ref<boolean>
  readonly cells: HostedKernel.Interface
  readonly operationLifecycle: Operations.Interface
  readonly inspectCapabilities: Effect.Effect<WorkspaceCapabilitySnapshot, never, Crypto.Crypto | FileSystem.FileSystem>
  readonly ptyDelivery: Semaphore.Semaphore
  readonly activeWriter: Ref.Ref<Writer | undefined>
  readonly grants: Ref.Ref<Map<string, PhaseGrant>>
  readonly executionEnvironment: Record<string, string>
  readonly appliedEnvironment: Ref.Ref<Map<string, string>>
  readonly environmentAccess: Semaphore.Semaphore
  readonly redactedValues: Set<string>
  readonly connected?: Effect.Effect<void>
}

const connect = Effect.fn("Host.connect")(function* (options: ConnectionOptions) {
  const { config } = options
  const runtime = yield* Runtime
  const socket = yield* Socket.makeWebSocket(config.apiUrl)
  const writer = yield* socket.writer
  yield* Ref.set(options.activeWriter, writer)
  const incoming = yield* Queue.make<IncomingMessage>()
  const credentials = yield* Queue.make<Extract<IncomingMessage, { readonly _tag: "RepositoryCredential" }>>()
  const reader = yield* socket
    .runString((frame) =>
      decodeApiMessage(frame).pipe(
        Effect.mapError(() => HostError.make({ message: "Controller sent an invalid executor frame" })),
        Effect.flatMap((message) =>
          message._tag === "RepositoryCredential" ? Queue.offer(credentials, message) : Queue.offer(incoming, message),
        ),
      ),
    )
    .pipe(Effect.forkScoped)
  const opening = !(yield* runtime.hasSession)
    ? {
        _tag: "ExecutorHello" as const,
        hello: yield* runtime.hello,
        lifecycle: options.identity.lifecycle,
        environmentDigest: options.identity.environmentDigest,
      }
    : { _tag: "ExecutorReconnect" as const, access: yield* runtime.reconnect }
  yield* writer(encodeExecutorMessage(opening))
  yield* waitForWelcome(incoming, options.store)
  const session = yield* runtime.persistedSession
  yield* Effect.sleep(session.heartbeatIntervalMillis).pipe(
    Effect.andThen(
      Effect.gen(function* () {
        const cursor = yield* runtime.cursor
        const frame = yield* runtime.heartbeat(cursor)
        yield* writer(encodeExecutorMessage({ _tag: "ExecutorHeartbeat", heartbeat: frame }))
      }),
    ),
    Effect.forever,
    Effect.forkScoped,
  )
  const correlation =
    config.templateBuildId === null
      ? { assignmentId: config.fence.assignmentId, sandboxId: config.fence.instanceId }
      : { assignmentId: config.fence.assignmentId, sandboxId: config.fence.instanceId, buildId: config.templateBuildId }
  const checkout = yield* HostedObservability.observe(
    "attach",
    correlation,
    prepare(
      config,
      options.kernelProfileDigest,
      options.bindingContractDigest,
      options.identity,
      options.seed,
      options.restore,
      incoming,
      credentials,
      writer,
      options.store,
      options.grants,
      options.executionEnvironment,
      options.appliedEnvironment,
      options.cells,
      options.inspectCapabilities,
      options.environmentAccess,
      options.redactedValues,
      applyGrant,
    ),
  )
  yield* RepositoryServices.pipe(
    Effect.flatMap((services) => services.resume),
    Effect.mapError((error) => HostError.make({ message: error.message })),
  )
  yield* runtime.access.pipe(
    Effect.flatMap(options.cells.replayBindings),
    Effect.mapError((error) => HostError.make({ message: error.message })),
  )
  yield* options.connected ?? Effect.void
  const reportFailure = (stage: "controller" | "api" | "pty", error: { readonly message: string }) =>
    runtime.access.pipe(
      Effect.flatMap((access) =>
        writer(
          encodeExecutorMessage({
            _tag: "ExecutorConnectionFailed",
            access,
            stage,
            message: error.message.slice(0, 512) || "Executor connection failed",
          }),
        ),
      ),
      Effect.timeout("250 millis"),
      Effect.ignore,
    )
  const connectedSession = Effect.raceFirst(
    Effect.raceFirst(
      Fiber.join(reader).pipe(
        Effect.mapError(() => HostError.make({ message: "Executor controller connection closed" })),
        Effect.flatMap(() => HostError.make({ message: "Executor controller connection ended" })),
        Effect.tapError((error) => reportFailure("controller", error)),
      ),
      consumeApi({ ...options, incoming, credentials, checkout, writer }).pipe(
        Effect.tapError((error: { readonly message: string }) => reportFailure("api", error)),
      ),
    ),
    consumePtyEvents(writer, options.ptyDelivery).pipe(
      Effect.flatMap(() => HostError.make({ message: "Executor PTY event stream ended" })),
      Effect.tapError((error: { readonly message: string }) => reportFailure("pty", error)),
    ),
  )
  const pty = yield* PtyManager
  return yield* connectedSession.pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        yield* pty.disconnectAll.pipe(Effect.ignore)
        yield* Ref.set(options.activeWriter, undefined)
      }),
    ),
  )
})

export const connection = { applyGrant, connect, dispatchPty, dispatchWorkspace } as const
