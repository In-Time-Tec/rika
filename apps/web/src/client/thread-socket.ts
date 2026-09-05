import { Effect, Schema } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import {
  type ClientCommand,
  hostedThreadSnapshotMatches,
  interactiveEventThreadId,
  protocolVersion,
  ServerFrame,
} from "@rika/product/client-protocol"
import { ThreadEventCursor, ThreadId } from "@rika/product/hosted-model"
import * as ThreadView from "@rika/product/thread-view"

export const frameEventName = "rika:thread-frame"

export class ThreadConnectionFailed extends Schema.TaggedError<ThreadConnectionFailed>()("ThreadConnectionFailed", {
  message: Schema.String,
}) {}

const Json = Schema.fromJsonString(Schema.Unknown)
const encodeJson = Schema.encodeSync(Json)
const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(ServerFrame))
type Payload = typeof ServerFrame.Type.payload
type Attachment = Extract<Payload, { readonly _tag: "ThreadAttached" }>
type ClientFrame = {
  readonly protocolVersion: typeof protocolVersion
  readonly payload:
    | { readonly _tag: "ClientDecodeFailed"; readonly message: string }
    | { readonly _tag: "ClientReconnecting"; readonly threadId: string | undefined }
    | { readonly _tag: "ClientReconnectFailed"; readonly threadId: string; readonly message: string }
}
export type ThreadFrameDetail = (ServerFrame | ClientFrame) & { readonly view?: ThreadView.ThreadViewSnapshot }

let socket: WebSocket | undefined
let candidate: WebSocket | undefined
let attachedThreadId: string | undefined
let attachedCursor = 0n
let attachedCheckpointCursor = 0n
let attachedVersion = 0n
let attachedView: ThreadView.ThreadViewAccumulator | undefined
let sequence = 0
let generation = 0

const failed = (message: string) => ThreadConnectionFailed.make({ message })
const requestId = (kind: string) => `${kind}:${(sequence += 1)}`
const semanticFrame = (frame: ServerFrame): ServerFrame & { readonly view?: ThreadView.ThreadViewSnapshot } =>
  attachedView === undefined ? frame : { ...frame, view: attachedView.snapshot() }
const emit = (detail: ThreadFrameDetail) => window.dispatchEvent(new CustomEvent(frameEventName, { detail }))
const attachmentHasForeignIdentity = (payload: Attachment, threadId: string) =>
  String(payload.threadId) !== threadId ||
  (payload.checkpoint !== undefined && !hostedThreadSnapshotMatches(payload.checkpoint.snapshot, threadId)) ||
  payload.events.some((event) => {
    const eventThreadId = interactiveEventThreadId(event.event)
    return String(event.threadId) !== threadId || (eventThreadId !== undefined && eventThreadId !== threadId)
  })

const attachmentBaseView = (
  payload: Attachment,
  threadId: string,
  baseCursor: bigint,
): ThreadView.ThreadViewAccumulator | undefined => {
  const checkpoint = payload.checkpoint
  if (checkpoint !== undefined && BigInt(checkpoint.cursor) !== baseCursor) return undefined
  if (
    checkpoint === undefined &&
    (attachedThreadId !== threadId || attachedView === undefined || attachedCursor !== baseCursor)
  )
    return undefined
  const view = ThreadView.fromSnapshot(checkpoint?.snapshot.view ?? attachedView!.snapshot())
  return view._tag === "Failure" ? undefined : view.success
}

const replayAttachment = (
  payload: Attachment,
  initialView: ThreadView.ThreadViewAccumulator,
): ThreadView.ThreadViewAccumulator | undefined => {
  const checkpoint = payload.checkpoint
  const baseCursor = BigInt(payload.baseCursor)
  let expectedCursor = baseCursor + 1n
  let representedVersion = BigInt(checkpoint?.threadVersion ?? attachedVersion)
  let view = initialView
  for (const event of payload.events) {
    if (BigInt(event.cursor) !== expectedCursor || BigInt(event.threadVersion) < representedVersion) return undefined
    representedVersion = BigInt(event.threadVersion)
    expectedCursor += 1n
    if (event.event._tag === "ThreadViewSnapshot") {
      const replacement = ThreadView.fromSnapshot(event.event.snapshot)
      if (replacement._tag === "Failure") return undefined
      view = replacement.success
    } else if (event.event._tag === "ThreadViewPatch") {
      const applied = view.apply(event.event.patch)
      if (applied._tag === "Failure") return undefined
    }
  }
  return expectedCursor - 1n === BigInt(payload.cursor) && representedVersion === BigInt(payload.threadVersion)
    ? view
    : undefined
}

const validateAttachment = (payload: Attachment, threadId: string): ThreadView.ThreadViewAccumulator | undefined => {
  if (attachmentHasForeignIdentity(payload, threadId)) return undefined
  const baseCursor = BigInt(payload.baseCursor)
  const view = attachmentBaseView(payload, threadId, baseCursor)
  return view === undefined ? undefined : replayAttachment(payload, view)
}
const payloadThreadId = (payload: Payload): string | undefined => {
  if (payload._tag === "ThreadEvent") return String(payload.event.threadId)
  if (
    payload._tag === "ThreadAttached" ||
    payload._tag === "ThreadSnapshot" ||
    payload._tag === "ThreadPreview" ||
    payload._tag === "ThreadPreviewReset" ||
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

const quarantinesForeignFrame = (payload: Payload) =>
  payload._tag === "CommandAccepted" ||
  payload._tag === "CommandRejected" ||
  payload._tag === "ThreadSnapshot" ||
  payload._tag === "ThreadEvent" ||
  payload._tag === "ThreadPreview" ||
  payload._tag === "ThreadPreviewReset"

const applyThreadEvent = (current: WebSocket, payload: Extract<Payload, { readonly _tag: "ThreadEvent" }>) => {
  const cursor = BigInt(payload.event.cursor)
  const version = BigInt(payload.event.threadVersion)
  if (cursor <= attachedCursor) return false
  if (cursor !== attachedCursor + 1n || version < attachedVersion || attachedView === undefined) {
    quarantine(current, "non-contiguous Thread event")
    return false
  }
  const eventThreadId = interactiveEventThreadId(payload.event.event)
  if (eventThreadId !== undefined && eventThreadId !== attachedThreadId) {
    quarantine(current, "foreign Thread event")
    return false
  }
  const candidateView = ThreadView.fromSnapshot(attachedView.snapshot())
  if (candidateView._tag === "Failure") {
    quarantine(current, "invalid Thread view")
    return false
  }
  if (payload.event.event._tag === "ThreadViewSnapshot") {
    const view = ThreadView.fromSnapshot(payload.event.event.snapshot)
    if (view._tag === "Failure") {
      quarantine(current, "invalid Thread view snapshot")
      return false
    }
    attachedView = view.success
  } else if (payload.event.event._tag === "ThreadViewPatch") {
    const applied = candidateView.success.apply(payload.event.event.patch)
    if (applied._tag === "Failure") {
      quarantine(current, "invalid Thread view patch")
      return false
    }
    attachedView = candidateView.success
  }
  attachedCursor = cursor
  attachedVersion = version
  return true
}

const applyThreadSnapshot = (current: WebSocket, payload: Extract<Payload, { readonly _tag: "ThreadSnapshot" }>) => {
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
    return false
  }
  attachedCursor = cursor
  attachedCheckpointCursor = cursor
  attachedVersion = version
  attachedView = view.success
  return true
}

const applyActiveFrame = (current: WebSocket, frame: ServerFrame) => {
  const payload = frame.payload
  const scopedThreadId = payloadThreadId(payload)
  if (scopedThreadId !== undefined && scopedThreadId !== attachedThreadId) {
    if (quarantinesForeignFrame(payload)) quarantine(current, "foreign Thread frame")
    return
  }
  if (payload._tag === "ThreadEvent" && !applyThreadEvent(current, payload)) return
  if (payload._tag === "ThreadSnapshot" && !applyThreadSnapshot(current, payload)) return
  emit(semanticFrame(frame))
}

const open = () =>
  Socket.WebSocketConstructor.use((makeWebSocket) =>
    Effect.callback<WebSocket, ThreadConnectionFailed>((resume) => {
      const url = new URL("/api/v1/threads/browser-socket", window.location.href)
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
      const current = makeWebSocket(url.href, ["rika.thread.v1"])
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
  const afterCheckpointCursor = attachedThreadId === threadId ? attachedCheckpointCursor : undefined
  const current = yield* open()
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
    const receiveAttachment = (frame: ServerFrame) => {
      const payload = frame.payload
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
      attachedCheckpointCursor =
        payload.checkpoint === undefined ? (afterCheckpointCursor ?? 0n) : BigInt(payload.checkpoint.cursor)
      attachedVersion = BigInt(payload.threadVersion)
      attachedView = view
      active = true
      settled = true
      previous?.close(1000, "replaced")
      resume(Effect.succeed(frame))
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
        emit({ protocolVersion, payload: { _tag: "ClientDecodeFailed", message: "Server frame was invalid" } })
        quarantine(current, "invalid Server frame")
        return
      }
      if (!active) {
        receiveAttachment(frame)
        return
      }
      applyActiveFrame(current, frame)
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
        emit({ protocolVersion, payload: { _tag: "ClientReconnecting", threadId: recoveryThreadId } })
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
                        protocolVersion,
                        payload: { _tag: "ClientReconnectFailed", threadId: recoveryThreadId, message: error.message },
                      })
                  }),
                onSuccess: (connected) => Effect.sync(() => emit(connected.frame)),
              }),
            ),
          )
      }
    }
    current.addEventListener("message", receive)
    current.addEventListener("close", closed)
    const command = {
      _tag: "AttachThread",
      threadId: ThreadId.make(threadId),
      afterCursor: ThreadEventCursor.make(String(afterCursor)),
    } satisfies Extract<ClientCommand, { readonly _tag: "AttachThread" }>
    if (afterCheckpointCursor !== undefined)
      Object.assign(command, { afterCheckpointCursor: ThreadEventCursor.make(String(afterCheckpointCursor)) })
    current.send(encodeJson({ protocolVersion, requestId: attachRequestId, command }))
    return Effect.sync(() => {
      if (active) return
      if (candidate === current) candidate = undefined
      current.removeEventListener("message", receive)
      current.removeEventListener("close", closed)
      current.close(1000, "attachment interrupted")
    })
  })
  return { threadId, frame: semanticFrame(attachedFrame) }
})
