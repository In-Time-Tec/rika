import * as ResidentService from "@rika/app/resident-service"
import { Cause, Function, Schema } from "effect"

const decodeClientImpl = Schema.decodeUnknownSync(ResidentService.ClientMessage)
export const decodeClient: {
  (): (input: unknown) => ResidentService.ClientMessage
  (input: unknown): ResidentService.ClientMessage
} = Function.dual((args) => args.length >= 1, decodeClientImpl)
const decodeServerImpl = Schema.decodeUnknownSync(ResidentService.ServerMessage)
export const decodeServer: {
  (): (input: unknown) => ResidentService.ServerMessage
  (input: unknown): ResidentService.ServerMessage
} = Function.dual((args) => args.length >= 1, decodeServerImpl)
const jsonImpl = Schema.encodeSync(Schema.UnknownFromJsonString)
export const json: {
  (): (input: unknown) => string
  (input: unknown): string
} = Function.dual((args) => args.length >= 1, jsonImpl)
const parseImpl = Schema.decodeSync(Schema.UnknownFromJsonString)
export const parse: {
  (): (input: string) => unknown
  (input: string): unknown
} = Function.dual((args) => args.length >= 1, parseImpl)
export const maxFrameBytes = 1_048_576
export const defaultOutboundCapacity = 1_024
export const maxServerMessageChunks = 16
export const maxClientMessageChunks = 16
const encoder = new TextEncoder()
const maxServerMessageBytes = maxFrameBytes * maxServerMessageChunks
export const maxClientMessageBytes = maxFrameBytes * maxClientMessageChunks
const defaultFragmentTtlMilliseconds = 30_000
const degradedReason =
  "Resident live delivery omitted an event larger than 16 MiB; reload the durable transcript for the full content"

const serverMessageTooLarge = { _tag: "ServerMessageTooLarge" } as const

const resyncTarget = (event: object) =>
  "threadId" in event && event.threadId !== undefined
    ? event.threadId
    : "_tag" in event &&
        event._tag === "SelectionLoaded" &&
        "thread" in event &&
        event.thread !== null &&
        typeof event.thread === "object" &&
        "id" in event.thread
      ? event.thread.id
      : undefined

const messageChunkFields = {
  messageId: Schema.String,
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  count: Schema.Int.check(Schema.isGreaterThan(0)),
  text: Schema.String,
}
const ServerMessageChunk = Schema.Struct({
  _tag: Schema.tag("resident-server-message-chunk"),
  ...messageChunkFields,
})
type ServerMessageChunk = typeof ServerMessageChunk.Type
const ClientMessageChunk = Schema.Struct({
  _tag: Schema.tag("resident-client-message-chunk"),
  ...messageChunkFields,
})
type ClientMessageChunk = typeof ClientMessageChunk.Type
type ChunkTag = ServerMessageChunk["_tag"] | ClientMessageChunk["_tag"]
const decodeServerWire = Schema.decodeUnknownSync(Schema.Union([ResidentService.ServerMessage, ServerMessageChunk]))
const decodeClientWire = Schema.decodeUnknownSync(Schema.Union([ResidentService.ClientMessage, ClientMessageChunk]))
const chunkFrame = (tag: ChunkTag, messageId: string, index: number, count: number, text: string) =>
  json({ _tag: tag, messageId, index, count, text })

const splitMessage = (tag: ChunkTag, maxChunks: number, onOverflow: () => never, messageId: string, text: string) => {
  const parts = new Array<string>()
  let start = 0
  while (start < text.length) {
    let low = start + 1
    let high = text.length
    let best = start
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const frame = chunkFrame(tag, messageId, maxChunks - 1, maxChunks, text.slice(start, middle))
      if (encoder.encode(frame).byteLength <= maxFrameBytes) {
        best = middle
        low = middle + 1
      } else high = middle - 1
    }
    if (
      best < text.length &&
      best > start &&
      text.charCodeAt(best - 1) >= 0xd800 &&
      text.charCodeAt(best - 1) <= 0xdbff &&
      text.charCodeAt(best) >= 0xdc00 &&
      text.charCodeAt(best) <= 0xdfff
    )
      best -= 1
    if (best === start) throw new Error("Resident message chunk metadata exceeds the maximum frame size")
    parts.push(text.slice(start, best))
    if (parts.length > maxChunks) onOverflow()
    start = best
  }
  return parts.map((part, index) => chunkFrame(tag, messageId, index, parts.length, part))
}

const splitServerMessage = (messageId: string, text: string) =>
  splitMessage(
    "resident-server-message-chunk",
    maxServerMessageChunks,
    () => {
      throw serverMessageTooLarge
    },
    messageId,
    text,
  )

const serverMessageFramesImpl = (
  messageId: string,
  message: ResidentService.ServerMessage,
  allowTargetedDegradation = true,
): ReadonlyArray<string> => {
  const complete = json(message)
  if (encoder.encode(complete).byteLength <= maxFrameBytes) return [complete]
  try {
    return splitServerMessage(messageId, complete)
  } catch (error) {
    if (error !== serverMessageTooLarge) throw error
    if (message._tag === "interactive-feed-event") {
      const selectionEpoch = "selectionEpoch" in message.event ? message.event.selectionEpoch : 0
      const threadId = resyncTarget(message.event)
      const degraded = decodeServer({
        ...message,
        event:
          threadId !== undefined
            ? {
                _tag: "TranscriptResyncRequired",
                selectionEpoch,
                threadId,
                reason: degradedReason,
              }
            : { _tag: "ExecutionFailed", selectionEpoch, message: degradedReason },
      })
      return serverMessageFramesImpl(messageId, degraded, false)
    }
    if (message._tag === "interactive-feed-resync" && allowTargetedDegradation) {
      const selectionEpoch = message.events.find((event) => "selectionEpoch" in event)?.selectionEpoch ?? 0
      const threadIds = new Map<string, unknown>()
      for (const event of message.events) {
        const threadId = resyncTarget(event)
        if (threadId !== undefined) threadIds.set(String(threadId), threadId)
      }
      const degraded = decodeServer({
        ...message,
        events:
          threadIds.size === 0
            ? [{ _tag: "ExecutionFailed", selectionEpoch, message: degradedReason }]
            : [...threadIds.values()].map((threadId) => ({
                _tag: "TranscriptResyncRequired",
                selectionEpoch,
                threadId,
                reason: degradedReason,
              })),
      })
      return serverMessageFramesImpl(messageId, degraded, false)
    }
    if (message._tag === "interactive-feed-resync") {
      const selectionEpoch = message.events.find((event) => "selectionEpoch" in event)?.selectionEpoch ?? 0
      return serverMessageFramesImpl(
        messageId,
        decodeServer({
          ...message,
          events: [{ _tag: "ExecutionFailed", selectionEpoch, message: degradedReason }],
        }),
        false,
      )
    }
    throw error
  }
}
export const serverMessageFrames: {
  (message: ResidentService.ServerMessage): (messageId: string) => ReadonlyArray<string>
  (messageId: string, message: ResidentService.ServerMessage): ReadonlyArray<string>
} = Function.dual(2, serverMessageFramesImpl)

type MessageChunk = {
  readonly messageId: string
  readonly index: number
  readonly count: number
  readonly text: string
}

type FrameDecoderOptions = {
  readonly now?: () => number
  readonly fragmentTtlMilliseconds?: number
  readonly maxPendingBytes?: number
}

const makeMessageFrameDecoder = <Message>(config: {
  readonly chunkTag: ChunkTag
  readonly maxChunks: number
  readonly maxMessageBytes: number
  readonly tooManyChunksMessage: string
  readonly decodeWire: (input: unknown) => Message | (MessageChunk & { readonly _tag: ChunkTag })
  readonly decodeComplete: (input: unknown) => Message
  readonly options?: FrameDecoderOptions | undefined
}) => {
  const options = config.options
  const now = options?.now ?? Date.now
  const ttl = Math.max(1, options?.fragmentTtlMilliseconds ?? defaultFragmentTtlMilliseconds)
  const pendingByteLimit = Math.max(maxFrameBytes, options?.maxPendingBytes ?? config.maxMessageBytes)
  const pending = new Map<
    string,
    { readonly count: number; readonly parts: Array<string>; nextIndex: number; bytes: number; updatedAt: number }
  >()
  let pendingBytes = 0
  const remove = (messageId: string) => {
    const state = pending.get(messageId)
    if (state === undefined) return
    pending.delete(messageId)
    pendingBytes -= state.bytes
  }
  const evictOldest = (except?: string) => {
    let oldest: { readonly messageId: string; readonly updatedAt: number } | undefined
    for (const [messageId, state] of pending) {
      if (messageId === except) continue
      if (oldest === undefined || state.updatedAt < oldest.updatedAt) oldest = { messageId, updatedAt: state.updatedAt }
    }
    if (oldest === undefined) return false
    remove(oldest.messageId)
    return true
  }
  const expire = (currentTime: number) => {
    for (const [messageId, state] of pending) if (currentTime - state.updatedAt >= ttl) remove(messageId)
  }
  return (frame: string): Message | undefined => {
    if (encoder.encode(frame).byteLength > maxFrameBytes) throw new Error("Resident frame exceeds maximum size")
    const wire = config.decodeWire(parse(frame))
    const isChunk =
      typeof wire === "object" &&
      wire !== null &&
      "_tag" in wire &&
      (wire as { readonly _tag: unknown })._tag === config.chunkTag
    if (!isChunk) return wire as Message
    const decoded = wire as unknown as MessageChunk
    if (decoded.count > config.maxChunks) throw new Error(config.tooManyChunksMessage)
    const currentTime = now()
    expire(currentTime)
    let state = pending.get(decoded.messageId)
    if (state !== undefined && decoded.index === 0) {
      remove(decoded.messageId)
      state = undefined
    }
    if (state === undefined) {
      if (decoded.index !== 0) return undefined
      while (pending.size >= config.maxChunks) evictOldest()
      state = { count: decoded.count, parts: [], nextIndex: 0, bytes: 0, updatedAt: currentTime }
      pending.set(decoded.messageId, state)
    }
    if (decoded.count !== state.count || decoded.index !== state.nextIndex) {
      remove(decoded.messageId)
      return undefined
    }
    const chunkBytes = encoder.encode(decoded.text).byteLength
    for (;;) {
      if (pendingBytes + chunkBytes <= pendingByteLimit || !evictOldest(decoded.messageId)) break
    }
    if (pendingBytes + chunkBytes > pendingByteLimit) {
      remove(decoded.messageId)
      return undefined
    }
    state.parts.push(decoded.text)
    state.nextIndex += 1
    state.bytes += chunkBytes
    state.updatedAt = currentTime
    pendingBytes += chunkBytes
    if (state.nextIndex < state.count) return undefined
    remove(decoded.messageId)
    return config.decodeComplete(parse(state.parts.join("")))
  }
}

export const makeServerMessageFrameDecoder = (options?: FrameDecoderOptions) =>
  makeMessageFrameDecoder<ResidentService.ServerMessage>({
    chunkTag: "resident-server-message-chunk",
    maxChunks: maxServerMessageChunks,
    maxMessageBytes: maxServerMessageBytes,
    tooManyChunksMessage: "Resident server message exceeds the maximum chunk count",
    decodeWire: decodeServerWire,
    decodeComplete: decodeServer,
    options,
  })

export const makeClientMessageFrameDecoder = (options?: FrameDecoderOptions) =>
  makeMessageFrameDecoder<ResidentService.ClientMessage>({
    chunkTag: "resident-client-message-chunk",
    maxChunks: maxClientMessageChunks,
    maxMessageBytes: maxClientMessageBytes,
    tooManyChunksMessage: "Resident client message exceeds the maximum chunk count",
    decodeWire: decodeClientWire,
    decodeComplete: decodeClient,
    options,
  })

const clientMessageFramesImpl = (messageId: string, message: ResidentService.ClientMessage): ReadonlyArray<string> => {
  const complete = json(message)
  if (encoder.encode(complete).byteLength <= maxFrameBytes) return [complete]
  return splitMessage(
    "resident-client-message-chunk",
    maxClientMessageChunks,
    () => {
      throw ResidentService.ResidentServiceError.make({
        reason: "message-too-large",
        message: "Resident client message exceeds the 16 MiB limit",
      })
    },
    messageId,
    complete,
  )
}
export const clientMessageFrames: {
  (message: ResidentService.ClientMessage): (messageId: string) => ReadonlyArray<string>
  (messageId: string, message: ResidentService.ClientMessage): ReadonlyArray<string>
} = Function.dual(2, clientMessageFramesImpl)

const outputFrame = (requestId: string, channel: "stdout" | "stderr", text: string) =>
  json({ _tag: "output", requestId, channel, text } satisfies ResidentService.ServerMessage)

const outputFramesImpl = (requestId: string, channel: "stdout" | "stderr", text: string): ReadonlyArray<string> => {
  const complete = outputFrame(requestId, channel, text)
  if (encoder.encode(complete).byteLength <= maxFrameBytes) return [complete]
  const frames = new Array<string>()
  let start = 0
  while (start < text.length) {
    let low = start + 1
    let high = text.length
    let best = start
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const frame = outputFrame(requestId, channel, text.slice(start, middle))
      if (encoder.encode(frame).byteLength <= maxFrameBytes) {
        best = middle
        low = middle + 1
      } else high = middle - 1
    }
    if (
      best < text.length &&
      best > start &&
      text.charCodeAt(best - 1) >= 0xd800 &&
      text.charCodeAt(best - 1) <= 0xdbff &&
      text.charCodeAt(best) >= 0xdc00 &&
      text.charCodeAt(best) <= 0xdfff
    )
      best -= 1
    if (best === start) best = start + (text.codePointAt(start)! > 0xffff ? 2 : 1)
    const frame = outputFrame(requestId, channel, text.slice(start, best))
    if (encoder.encode(frame).byteLength > maxFrameBytes)
      throw new Error("Resident output frame metadata exceeds the maximum frame size")
    frames.push(frame)
    start = best
  }
  return frames
}
export const outputFrames: {
  (channel: "stdout" | "stderr", text: string): (requestId: string) => ReadonlyArray<string>
  (requestId: string, channel: "stdout" | "stderr", text: string): ReadonlyArray<string>
} = Function.dual(3, outputFramesImpl)

const transportErrorImpl = (
  message: string,
  reason: ResidentService.ResidentServiceError["reason"] = "transport-failed",
) => ResidentService.ResidentServiceError.make({ reason, message })
export const transportError: {
  (): (message: string) => ResidentService.ResidentServiceError
  (message: string, reason?: ResidentService.ResidentServiceError["reason"]): ResidentService.ResidentServiceError
} = Function.dual((args) => args.length >= 1, transportErrorImpl)

export const failureKind = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause)
  if (failure !== null && typeof failure === "object" && "_tag" in failure && typeof failure._tag === "string")
    return failure._tag
  if (failure instanceof Error) return failure.name
  return typeof failure
}
