import { Effect, Ref, Semaphore, Stream } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import { Manager as PtyManager, type Connection as PtyConnection } from "./terminal/pty"
import { Runtime } from "./runtime"
import { RepositoryServices } from "../workspace/repositories"
import { WorkspaceFiles } from "../workspace/files"
import { HostError } from "./error"
import type { ApiMessage as IncomingMessage, ExecutorMessage } from "../protocol/messages"

type Writer = (chunk: string) => Effect.Effect<void, Socket.SocketError>
type Encoder = (message: ExecutorMessage) => string
type SameFence = (
  left: Extract<IncomingMessage, { readonly _tag: "PtyCreate" }>["fence"],
  right: Extract<IncomingMessage, { readonly _tag: "PtyCreate" }>["fence"],
) => boolean

export type PhaseGrant = Extract<IncomingMessage, { readonly _tag: "PhaseEnvironmentGranted" }>

const rejectionReason = (kind: string): "conflict" | "invalid" | "missing" | "unavailable" => {
  if (kind === "conflict" || kind === "invalid" || kind === "missing") return kind
  return "unavailable"
}

const ptyCreate = (connection: PtyConnection) => ({
  ptyId: connection.ptyId,
  command: connection.command,
  cwd: connection.cwd,
  cols: connection.cols,
  rows: connection.rows,
})

const isPtyMessage = (message: IncomingMessage) =>
  message._tag === "PtyCreate" ||
  message._tag === "PtyInput" ||
  message._tag === "PtyResize" ||
  message._tag === "PtyDisconnect" ||
  message._tag === "PtyReconnect" ||
  message._tag === "PtyTerminate"

const makePtyDispatch = (encode: Encoder, sameFence: SameFence) =>
  Effect.fn("Host.dispatchPty")(function* (message: IncomingMessage, writer: Writer, delivery: Semaphore.Semaphore) {
    if (!isPtyMessage(message)) return false
    const runtime = yield* Runtime
    const pty = yield* PtyManager
    const access = yield* runtime.access.pipe(Effect.mapError((cause) => HostError.make({ message: cause.message })))
    if (!sameFence(access.fence, message.fence))
      return yield* HostError.make({ message: "PTY request has a stale executor fence" })
    const write = (outgoing: ExecutorMessage) =>
      writer(encode(outgoing)).pipe(Effect.mapError(() => HostError.make({ message: "Could not write PTY frame" })))
    yield* delivery.withPermits(1)(
      Effect.gen(function* () {
        if (message._tag === "PtyCreate") {
          const opened = yield* pty.create(message.request)
          yield* write(
            opened.terminated
              ? { _tag: "PtyTerminated", access, ptyId: opened.ptyId, cursor: opened.cursor }
              : { _tag: "PtyOpened", access, pty: ptyCreate(opened) },
          )
          return
        }
        if (message._tag === "PtyInput") return yield* pty.input(message.request)
        if (message._tag === "PtyResize") {
          const resized = yield* pty.resize(message.request)
          return yield* write({ _tag: "PtyOpened", access, pty: ptyCreate(resized) })
        }
        if (message._tag === "PtyDisconnect") {
          const disconnected = yield* pty.disconnect(message.ptyId)
          return yield* write({
            _tag: "PtyDisconnected",
            access,
            ptyId: disconnected.ptyId,
            cursor: disconnected.cursor,
          })
        }
        if (message._tag === "PtyReconnect") {
          const reconnected = yield* pty.reconnect(message.request)
          yield* write({ _tag: "PtyOpened", access, pty: ptyCreate(reconnected) })
          if (reconnected.gap !== null)
            yield* write({ _tag: "PtyReplayGap", access, ptyId: reconnected.ptyId, gap: reconnected.gap })
          return yield* Effect.forEach(
            reconnected.transcript,
            (chunk) => write({ _tag: "PtyOutput", access, ptyId: reconnected.ptyId, chunk }),
            { discard: true },
          )
        }
        const terminated = yield* pty.terminate(message.ptyId)
        yield* write({ _tag: "PtyTerminated", access, ptyId: terminated.ptyId, cursor: terminated.cursor })
      }).pipe(Effect.mapError((cause) => HostError.make({ message: cause.message }))),
    )
    return true
  })

const makeConsumePtyEvents = (encode: Encoder) => (writer: Writer, delivery: Semaphore.Semaphore) =>
  Effect.gen(function* () {
    const runtime = yield* Runtime
    const pty = yield* PtyManager
    yield* pty.events.pipe(
      Stream.runForEach((event) =>
        delivery.withPermits(1)(
          Effect.gen(function* () {
            const access = yield* runtime.access
            const outgoing: ExecutorMessage =
              event._tag === "Output"
                ? { _tag: "PtyOutput", access, ptyId: event.ptyId, chunk: event.chunk }
                : { _tag: "PtyTerminated", access, ptyId: event.ptyId, cursor: event.cursor }
            yield* writer(encode(outgoing))
          }),
        ),
      ),
      Effect.mapError((cause) => HostError.make({ message: cause.message })),
    )
  })

export const applyPhaseGrant = Effect.fn("Host.applyPhaseGrant")(function* (
  message: PhaseGrant,
  grants: Ref.Ref<Map<string, PhaseGrant>>,
  environmentAccess: Semaphore.Semaphore,
  replaceEnvironment: (values: Record<string, string>) => void,
  redactedValues: Set<string> = new Set(),
) {
  for (const name of message.redactedNames) {
    const value = message.values[name]
    if (value !== undefined) redactedValues.add(value)
  }
  if (message.operationKey !== null) {
    if (message.phase !== "runtime") return yield* HostError.make({ message: "Operation environment phase is invalid" })
    yield* Ref.update(grants, (current) => new Map(current).set(message.operationKey!, message))
    return
  }
  yield* environmentAccess.withPermits(1)(Effect.sync(() => replaceEnvironment(message.values)))
})

const makeWorkspaceDispatch = (encode: Encoder, sameFence: SameFence) =>
  Effect.fn("Host.dispatchWorkspace")(function* (message: IncomingMessage, writer: Writer) {
    if (message._tag !== "WorkspaceRequest") return false
    const runtime = yield* Runtime
    const access = yield* runtime.access.pipe(Effect.mapError((cause) => HostError.make({ message: cause.message })))
    if (!sameFence(access.fence, message.fence))
      return yield* HostError.make({ message: "Workspace request has a stale executor fence" })
    const files = yield* WorkspaceFiles
    const services = yield* RepositoryServices
    const request = message.request
    const rejection = (error: { readonly kind: string; readonly message: string }, serviceId: string) => ({
      _tag: "RepositoryServiceRejected" as const,
      requestId: request.requestId,
      serviceId,
      reason: rejectionReason(error.kind),
      message: error.message,
    })
    const response = yield* (() => {
      if (request._tag === "WorkspaceFileInspect") return files.inspect(request)
      if (request._tag === "RepositoryServiceEnsure")
        return services.ensure(request.service).pipe(
          Effect.match({
            onFailure: (error) => rejection(error, request.service.serviceId),
            onSuccess: () => ({
              _tag: "RepositoryServiceRunning" as const,
              requestId: request.requestId,
              serviceId: request.service.serviceId,
            }),
          }),
        )
      return services.stop(request.serviceId).pipe(
        Effect.match({
          onFailure: (error) => rejection(error, request.serviceId),
          onSuccess: () => ({
            _tag: "RepositoryServiceStopped" as const,
            requestId: request.requestId,
            serviceId: request.serviceId,
          }),
        }),
      )
    })()
    yield* writer(encode({ _tag: "WorkspaceResponse", access, response })).pipe(
      Effect.mapError(() => HostError.make({ message: "Could not write Workspace response" })),
    )
    return true
  })

export const dispatch = {
  pty: makePtyDispatch,
  ptyEvents: makeConsumePtyEvents,
  workspace: makeWorkspaceDispatch,
} as const
