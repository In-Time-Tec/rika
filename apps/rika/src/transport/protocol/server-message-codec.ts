import * as ServerService from "@rika/product/server-service"
import { Cause, Function, Schema } from "effect"
import {
  decodeClient,
  decodeServer,
  json,
  maxClientMessageChunks,
  maxFrameBytes,
  maxServerMessageChunks,
  parse,
} from "./server-protocol"

const encoder = new TextEncoder()
const maxServerMessageBytes = maxFrameBytes * maxServerMessageChunks
const defaultFragmentTtlMilliseconds = 30_000
const degradedReason =
  "Server live delivery omitted an event larger than 16 MiB; reload the durable transcript for the full content"

const serverMessageTooLarge = { _tag: "ServerMessageTooLarge" } as const

const degradedEvent = (event: ServerService.ServerMessage extends infer _ ? object : never) => {
  if ("_tag" in event && event._tag === "ThreadViewSnapshot" && "snapshot" in event) {
    const snapshot = event.snapshot as { readonly thread: { readonly id: string }; readonly revision: number }
    return {
      _tag: "ResyncRequired" as const,
      threadId: snapshot.thread.id,
      expectedRevision: snapshot.revision,
      receivedBaseRevision: snapshot.revision,
      currentRevision: snapshot.revision,
    }
  }
  if ("_tag" in event && event._tag === "ThreadViewPatch" && "patch" in event) {
    const patch = event.patch as { readonly threadId: string; readonly baseRevision: number; readonly revision: number }
    return {
      _tag: "ResyncRequired" as const,
      threadId: patch.threadId,
      expectedRevision: patch.revision,
      receivedBaseRevision: patch.baseRevision,
      currentRevision: patch.baseRevision,
    }
  }
  if ("threadId" in event && typeof event.threadId === "string")
    return { _tag: "ExecutionFailed" as const, threadId: event.threadId, message: degradedReason }
  return { _tag: "ExecutionFailed" as const, message: degradedReason }
}

const messageChunkFields = {
  messageId: Schema.String,
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  count: Schema.Int.check(Schema.isGreaterThan(0)),
  text: Schema.String,
}
const ServerMessageChunk = Schema.Struct({
  _tag: Schema.tag("server-server-message-chunk"),
  ...messageChunkFields,
})
type ServerMessageChunk = typeof ServerMessageChunk.Type
const ClientMessageChunk = Schema.Struct({
  _tag: Schema.tag("server-client-message-chunk"),
  ...messageChunkFields,
})
type ClientMessageChunk = typeof ClientMessageChunk.Type
type ChunkTag = ServerMessageChunk["_tag"] | ClientMessageChunk["_tag"]
const decodeServerWire = Schema.decodeUnknownSync(Schema.Union([ServerService.ServerMessage, ServerMessageChunk]))
const decodeClientWire = Schema.decodeUnknownSync(Schema.Union([ServerService.ClientMessage, ClientMessageChunk]))
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
    if (best === start) throw new Error("Server message chunk metadata exceeds the maximum frame size")
    parts.push(text.slice(start, best))
    if (parts.length > maxChunks) onOverflow()
    start = best
  }
  return parts.map((part, index) => chunkFrame(tag, messageId, index, parts.length, part))
}

const splitServerMessage = (messageId: string, text: string) =>
  splitMessage(
    "server-server-message-chunk",
    maxServerMessageChunks,
    () => {
      throw serverMessageTooLarge
    },
    messageId,
    text,
  )

const serverMessageFramesImpl = (messageId: string, message: ServerService.ServerMessage): ReadonlyArray<string> => {
  const complete = json(message)
  if (encoder.encode(complete).byteLength <= maxFrameBytes) return [complete]
  try {
    return splitServerMessage(messageId, complete)
  } catch (error) {
    if (error !== serverMessageTooLarge) throw error
    if (message._tag !== "interactive-feed-event") throw error
    return serverMessageFramesImpl(messageId, decodeServer({ ...message, event: degradedEvent(message.event) }))
  }
}
export const serverMessageFrames: {
  (message: ServerService.ServerMessage): (messageId: string) => ReadonlyArray<string>
  (messageId: string, message: ServerService.ServerMessage): ReadonlyArray<string>
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
    if (encoder.encode(frame).byteLength > maxFrameBytes) throw new Error("Server frame exceeds maximum size")
    const wire = config.decodeWire(parse(frame))
    const isChunk = (
      value: Message | (MessageChunk & { readonly _tag: ChunkTag }),
    ): value is MessageChunk & { readonly _tag: ChunkTag } =>
      typeof value === "object" && value !== null && "_tag" in value && value._tag === config.chunkTag
    if (!isChunk(wire)) return wire
    const decoded = wire
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
  makeMessageFrameDecoder<ServerService.ServerMessage>({
    chunkTag: "server-server-message-chunk",
    maxChunks: maxServerMessageChunks,
    maxMessageBytes: maxServerMessageBytes,
    tooManyChunksMessage: "Server message exceeds the maximum chunk count",
    decodeWire: decodeServerWire,
    decodeComplete: decodeServer,
    options,
  })

export const makeClientMessageFrameDecoder = (options?: FrameDecoderOptions) =>
  makeMessageFrameDecoder<ServerService.ClientMessage>({
    chunkTag: "server-client-message-chunk",
    maxChunks: maxClientMessageChunks,
    maxMessageBytes: maxClientMessageBytes,
    tooManyChunksMessage: "Server client message exceeds the maximum chunk count",
    decodeWire: decodeClientWire,
    decodeComplete: decodeClient,
    options,
  })

const clientMessageFramesImpl = (messageId: string, message: ServerService.ClientMessage): ReadonlyArray<string> => {
  const complete = json(message)
  if (encoder.encode(complete).byteLength <= maxFrameBytes) return [complete]
  return splitMessage(
    "server-client-message-chunk",
    maxClientMessageChunks,
    () => {
      throw ServerService.ServerServiceError.make({
        reason: "message-too-large",
        message: "Server client message exceeds the 16 MiB limit",
      })
    },
    messageId,
    complete,
  )
}
export const clientMessageFrames: {
  (message: ServerService.ClientMessage): (messageId: string) => ReadonlyArray<string>
  (messageId: string, message: ServerService.ClientMessage): ReadonlyArray<string>
} = Function.dual(2, clientMessageFramesImpl)

const outputFrame = (requestId: string, channel: "stdout" | "stderr", text: string) =>
  json({ _tag: "output", requestId, channel, text } satisfies ServerService.ServerMessage)

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
      throw new Error("Server output frame metadata exceeds the maximum frame size")
    frames.push(frame)
    start = best
  }
  return frames
}
export const outputFrames: {
  (channel: "stdout" | "stderr", text: string): (requestId: string) => ReadonlyArray<string>
  (requestId: string, channel: "stdout" | "stderr", text: string): ReadonlyArray<string>
} = Function.dual(3, outputFramesImpl)

export const maxClientMessageBytes = maxFrameBytes * maxClientMessageChunks

const transportErrorImpl = (message: string, reason: ServerService.ServerServiceError["reason"] = "transport-failed") =>
  ServerService.ServerServiceError.make({ reason, message })
export const transportError: {
  (
    reason?: ServerService.ServerServiceError["reason"],
  ): (message: string) => ServerService.ServerServiceError
  (message: string, reason?: ServerService.ServerServiceError["reason"]): ServerService.ServerServiceError
} = Function.dual((args) => typeof args[0] === "string" && args.length >= 1, transportErrorImpl)

export const failureKind = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause)
  if (failure !== null && typeof failure === "object" && "_tag" in failure && typeof failure._tag === "string")
    return failure._tag
  if (failure instanceof Error) return failure.name
  return typeof failure
}
