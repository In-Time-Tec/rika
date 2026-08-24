import { Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { hostedThreadSnapshotMatches, interactiveEventThreadId, ServerFrame } from "@rika/product/client-protocol"
import * as ThreadView from "@rika/product/thread-view"

export const frameEventName = "rika:thread-frame"

export class ThreadConnectionFailed extends Schema.TaggedError<ThreadConnectionFailed>()("ThreadConnectionFailed", {
  message: Schema.String,
}) {}

const Ticket = Schema.Struct({
  ticket: Schema.String,
  websocketUrl: Schema.String,
  protocol: Schema.String,
})
type Ticket = typeof Ticket.Type

const Json = Schema.fromJsonString(Schema.Unknown)
const encodeJson = Schema.encodeSync(Json)
const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(ServerFrame))
type Payload = typeof ServerFrame.Type.payload
type Attachment = Extract<Payload, { readonly _tag: "ThreadAttached" }>

let socket: WebSocket | undefined
let candidate: WebSocket | undefined
let attachedThreadId: string | undefined
let attachedCursor = 0n
let attachedVersion = 0n
let attachedView: ThreadView.ThreadViewAccumulator | undefined
let sequence = 0
let generation = 0

const failed = (message: string) => ThreadConnectionFailed.make({ message })
const requestId = (kind: string) => `${kind}:${(sequence += 1)}`
const emit = (detail: unknown) => window.dispatchEvent(new CustomEvent(frameEventName, { detail }))
const validateAttachment = (payload: Attachment, threadId: string): ThreadView.ThreadViewAccumulator | undefined => {
  if (
    String(payload.threadId) !== threadId ||
    !hostedThreadSnapshotMatches(payload.snapshot, threadId) ||
    payload.events.some((event) => {
      const eventThreadId = interactiveEventThreadId(event.event)
      return String(event.threadId) !== threadId || (eventThreadId !== undefined && eventThreadId !== threadId)
    })
  )
    return undefined
  let expectedCursor = BigInt(payload.snapshotCursor) + 1n
  let representedVersion = BigInt(payload.snapshotThreadVersion)
  let view = ThreadView.fromSnapshot(payload.snapshot.view)
  if (view._tag === "Failure") return undefined
  for (const event of payload.events) {
    if (BigInt(event.cursor) !== expectedCursor || BigInt(event.threadVersion) < representedVersion) return undefined
    representedVersion = BigInt(event.threadVersion)
    expectedCursor += 1n
    if (event.event._tag === "ThreadViewSnapshot") {
      view = ThreadView.fromSnapshot(event.event.snapshot)
      if (view._tag === "Failure") return undefined
    } else if (event.event._tag === "ThreadViewPatch") {
      const applied = view.success.apply(event.event.patch)
      if (applied._tag === "Failure") return undefined
    }
  }
  return expectedCursor - 1n === BigInt(payload.cursor) && representedVersion === BigInt(payload.threadVersion)
    ? view.success
    : undefined
}
const payloadThreadId = (payload: Payload): string | undefined => {
  if (payload._tag === "ThreadEvent") return String(payload.event.threadId)
  if (
    payload._tag === "ThreadAttached" ||
    payload._tag === "ThreadSnapshot" ||
    payload._tag === "ExecutorStatus" ||
    payload._tag === "WorkspaceStatus" ||
    payload._tag === "WorkspaceFileInspected" ||
    payload._tag === "PortalOpened" ||
    payload._tag === "PresenceSnapshot" ||
    payload._tag === "CommandAccepted" ||
    payload._tag === "CommandRejected"
  )
    return payload.threadId === undefined ? undefined : String(payload.threadId)
  return undefined
}

const supersedeCandidate = () => {
  const pending = candidate
  candidate = undefined
  pending?.close(1000, "superseded")
}

const quarantine = (current: WebSocket, reason: string) => {
  current.close(1002, reason)
}

const open = (ticket: Ticket) =>
  Socket.WebSocketConstructor.use((makeWebSocket) =>
    Effect.callback<WebSocket, ThreadConnectionFailed>((resume) => {
      const current = makeWebSocket(ticket.websocketUrl, [ticket.protocol, `rika.ticket.${ticket.ticket}`])
      const opened = () => resume(Effect.succeed(current))
      const rejected = () => resume(Effect.fail(failed("The Thread connection could not be opened")))
      current.addEventListener("open", opened, { once: true })
      current.addEventListener("error", rejected, { once: true })
      return Effect.sync(() => {
        current.removeEventListener("open", opened)
        current.removeEventListener("error", rejected)
        if (current.readyState === WebSocket.CONNECTING) current.close()
      })
    }),
  )

export const connectThread = Effect.fn("ThreadSocket.connect")(function* (threadId: string) {
  const context = yield* Effect.context<Socket.WebSocketConstructor>()
  const selectedGeneration = ++generation
  supersedeCandidate()
  const afterCursor = attachedThreadId === threadId ? attachedCursor : 0n
  const httpClient = yield* Effect.scoped(Layer.build(FetchHttpClient.layer))
  const response = yield* HttpClient.post("/api/v1/thread-sessions").pipe(
    Effect.provideContext(httpClient),
    Effect.mapError(() => failed("A Thread ticket could not be requested")),
  )
  if (response.status < 200 || response.status >= 300)
    return yield* failed(`Thread ticket request failed with HTTP ${response.status}`)
  const ticket = yield* response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Ticket)),
    Effect.mapError(() => failed("The Thread ticket response was invalid")),
  )
  const current = yield* open(ticket)
  if (selectedGeneration !== generation) {
    current.close(1000, "superseded")
    return yield* failed("The Thread connection was superseded")
  }
  candidate = current
  const attachRequestId = requestId("attach")
  const attachedFrame = yield* Effect.callback<ServerFrame, ThreadConnectionFailed>((resume) => {
    let settled = false
    let active = false
    const reject = (message: string) => {
      if (settled) return
      settled = true
      if (candidate === current) candidate = undefined
      current.close(1000, "attachment rejected")
      resume(Effect.fail(failed(message)))
    }
    const receive = (event: MessageEvent) => {
      if (active ? socket !== current : selectedGeneration !== generation || candidate !== current) return
      let frame: ServerFrame
      try {
        frame = decodeFrame(String(event.data))
      } catch {
        if (!active) {
          reject("The Thread attachment response was invalid")
          return
        }
        emit({ protocolVersion: 1, payload: { _tag: "ClientDecodeFailed", message: "Server frame was invalid" } })
        quarantine(current, "invalid Server frame")
        return
      }
      const payload = frame.payload
      if (!active) {
        if (payload._tag === "CommandRejected" && String(payload.requestId) === attachRequestId) {
          reject(payload.message)
          return
        }
        if (payload._tag !== "ThreadAttached" || String(payload.requestId) !== attachRequestId) return
        const view = validateAttachment(payload, threadId)
        if (view === undefined) {
          reject("The Thread attachment response identity did not match its request")
          return
        }
        if (selectedGeneration !== generation) {
          reject("The Thread connection was superseded")
          return
        }
        if (attachedThreadId === threadId && BigInt(payload.cursor) < attachedCursor) {
          reject("The Thread attachment response was behind the committed cursor")
          return
        }
        const previous = socket
        socket = current
        candidate = undefined
        attachedThreadId = threadId
        attachedCursor = BigInt(payload.cursor)
        attachedVersion = BigInt(payload.threadVersion)
        attachedView = view
        active = true
        settled = true
        previous?.close(1000, "replaced")
        resume(Effect.succeed(frame))
        return
      }
      const scopedThreadId = payloadThreadId(payload)
      if (scopedThreadId !== undefined && scopedThreadId !== attachedThreadId) {
        if (
          payload._tag === "CommandAccepted" ||
          payload._tag === "CommandRejected" ||
          payload._tag === "ThreadSnapshot" ||
          payload._tag === "ThreadEvent"
        )
          quarantine(current, "foreign Thread frame")
        return
      }
      if (payload._tag === "ThreadEvent") {
        const cursor = BigInt(payload.event.cursor)
        const version = BigInt(payload.event.threadVersion)
        if (cursor <= attachedCursor) return
        if (cursor !== attachedCursor + 1n || version < attachedVersion || attachedView === undefined) {
          quarantine(current, "non-contiguous Thread event")
          return
        }
        const eventThreadId = interactiveEventThreadId(payload.event.event)
        if (eventThreadId !== undefined && eventThreadId !== attachedThreadId) {
          quarantine(current, "foreign Thread event")
          return
        }
        const candidateView = ThreadView.fromSnapshot(attachedView.snapshot())
        if (candidateView._tag === "Failure") {
          quarantine(current, "invalid Thread view")
          return
        }
        if (payload.event.event._tag === "ThreadViewSnapshot") {
          const view = ThreadView.fromSnapshot(payload.event.event.snapshot)
          if (view._tag === "Failure") {
            quarantine(current, "invalid Thread view snapshot")
            return
          }
          attachedView = view.success
        } else if (payload.event.event._tag === "ThreadViewPatch") {
          const applied = candidateView.success.apply(payload.event.event.patch)
          if (applied._tag === "Failure") {
            quarantine(current, "invalid Thread view patch")
            return
          }
          attachedView = candidateView.success
        }
        attachedCursor = cursor
        attachedVersion = version
      } else if (payload._tag === "ThreadSnapshot") {
        const cursor = BigInt(payload.cursor)
        const version = BigInt(payload.threadVersion)
        const view = ThreadView.fromSnapshot(payload.snapshot.view)
        if (
          cursor < attachedCursor ||
          version < attachedVersion ||
          !hostedThreadSnapshotMatches(payload.snapshot, attachedThreadId!) ||
          view._tag === "Failure"
        ) {
          quarantine(current, "invalid Thread snapshot")
          return
        }
        attachedCursor = cursor
        attachedVersion = version
        attachedView = view.success
      }
      emit(frame)
    }
    const closed = () => {
      if (!active) {
        reject("The Thread connection closed before attachment completed")
        return
      }
      if (socket === current) {
        socket = undefined
        const recoveryThreadId = attachedThreadId
        const recoveryGeneration = generation
        emit({ protocolVersion: 1, payload: { _tag: "ClientReconnecting", threadId: recoveryThreadId } })
        if (recoveryThreadId !== undefined)
          Effect.runForkWith(context)(
            connectThread(recoveryThreadId).pipe(
              Effect.matchEffect({
                onFailure: (error) =>
                  Effect.sync(() => {
                    if (
                      generation === recoveryGeneration + 1 &&
                      socket === undefined &&
                      attachedThreadId === recoveryThreadId
                    )
                      emit({
                        protocolVersion: 1,
                        payload: { _tag: "ClientReconnectFailed", threadId: recoveryThreadId, message: error.message },
                      })
                  }),
                onSuccess: () => Effect.void,
              }),
            ),
          )
      }
    }
    current.addEventListener("message", receive)
    current.addEventListener("close", closed)
    current.send(
      encodeJson({
        protocolVersion: 1,
        requestId: attachRequestId,
        command: { _tag: "AttachThread", threadId, afterCursor: String(afterCursor) },
      }),
    )
    return Effect.sync(() => {
      if (active) return
      if (candidate === current) candidate = undefined
      current.removeEventListener("message", receive)
      current.removeEventListener("close", closed)
      current.close(1000, "attachment interrupted")
    })
  })
  return { threadId, frame: attachedFrame }
})

export const sendPrompt = Effect.fn("ThreadSocket.sendPrompt")(function* (input: {
  readonly threadId: string
  readonly threadVersion: string
  readonly text: string
}) {
  const current = socket
  if (current === undefined || current.readyState !== WebSocket.OPEN || attachedThreadId !== input.threadId)
    return yield* failed("Connect to the Thread before sending a prompt")
  const id = requestId("prompt")
  yield* Effect.try({
    try: () =>
      current.send(
        encodeJson({
          protocolVersion: 1,
          requestId: `${id}:request`,
          command: {
            _tag: "SubmitPrompt",
            threadId: input.threadId,
            commandId: id,
            idempotencyKey: id,
            expectedThreadVersion: input.threadVersion,
            text: input.text,
          },
        }),
      ),
    catch: () => failed("The prompt could not be sent"),
  })
})

export const openPortal = Effect.fn("ThreadSocket.openPortal")(function* (port: number) {
  const current = socket
  const threadId = attachedThreadId
  if (current === undefined || current.readyState !== WebSocket.OPEN || threadId === undefined)
    return yield* failed("Connect to the Thread before opening a portal")
  yield* Effect.try({
    try: () =>
      current.send(
        encodeJson({
          protocolVersion: 1,
          requestId: requestId("portal"),
          command: { _tag: "OpenPortal", threadId, port },
        }),
      ),
    catch: () => failed("The portal request could not be sent"),
  })
})
