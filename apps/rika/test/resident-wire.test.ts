import { describe, expect, it } from "@effect/vitest"
import * as ResidentService from "@rika/app/resident-service"
import { Schema } from "effect"
import {
  clientMessageFrames,
  makeClientMessageFrameDecoder,
  makeServerMessageFrameDecoder,
  maxClientMessageBytes,
  maxFrameBytes,
  outputFrames,
  parse,
  serverMessageFrames,
} from "../src/resident-wire"

const decode = Schema.decodeUnknownSync(ResidentService.ServerMessage)
const encoder = new TextEncoder()

const expectRoundTrip = (text: string) => {
  const frames = outputFrames("request", "stdout", text)
  expect(frames.length).toBeGreaterThan(1)
  expect(Math.max(...frames.map((frame) => encoder.encode(frame).byteLength))).toBeLessThanOrEqual(maxFrameBytes)
  expect(
    frames
      .map((frame) => decode(parse(frame)))
      .map((frame) => (frame._tag === "output" ? frame.text : ""))
      .join(""),
  ).toBe(text)
}

describe("resident output frames", () => {
  it("splits large ASCII output", () => {
    expectRoundTrip("x".repeat(maxFrameBytes * 2))
  })

  it("splits multibyte output without breaking surrogate pairs", () => {
    expectRoundTrip("🙂".repeat(maxFrameBytes))
  })

  it("accounts for JSON escaping and control characters", () => {
    expectRoundTrip('\\"\n\r\t\u0000'.repeat(maxFrameBytes / 4))
  })

  it("keeps a small frame whole", () => {
    const frames = outputFrames("request", "stderr", "small")
    expect(frames).toHaveLength(1)
    expect(encoder.encode(frames[0]!).byteLength).toBeLessThanOrEqual(maxFrameBytes)
  })
})

describe("resident client message frames", () => {
  const submitMessage = (dataBytes: number) =>
    Schema.decodeUnknownSync(ResidentService.ClientMessage)({
      _tag: "interactive-command",
      connectionId: "connection",
      requestId: "request",
      sessionId: "session",
      feedGeneration: "generation",
      commandSequence: 1,
      command: {
        _tag: "Submit",
        prompt: "look at this",
        promptParts: [
          { type: "text", text: "look at this" },
          { type: "image", mediaType: "image/png", data: "x".repeat(dataBytes), filename: "shot.png" },
        ],
      },
    })

  it("splits and reassembles an oversized interactive submit", () => {
    const message = submitMessage(2_000_000)
    const frames = clientMessageFrames("message", message)
    const decodeFrame = makeClientMessageFrameDecoder()
    const decoded = frames.map(decodeFrame).filter((value) => value !== undefined)

    expect(frames.length).toBeGreaterThan(1)
    expect(Math.max(...frames.map((frame) => encoder.encode(frame).byteLength))).toBeLessThanOrEqual(maxFrameBytes)
    expect(decoded).toEqual([message])
  })

  it("keeps a small client message whole", () => {
    const message = submitMessage(16)
    const frames = clientMessageFrames("message", message)
    expect(frames).toHaveLength(1)
    expect(makeClientMessageFrameDecoder()(frames[0]!)).toEqual(message)
  })

  it("fails a message beyond the chunk ceiling with a typed message-too-large error", () => {
    expect(maxClientMessageBytes).toBe(16 * maxFrameBytes)
    try {
      clientMessageFrames("message", submitMessage(maxClientMessageBytes + 1_000_000))
      expect.unreachable("clientMessageFrames must throw for an over-ceiling message")
    } catch (error) {
      expect(Schema.is(ResidentService.ResidentServiceError)(error)).toBe(true)
      expect(error).toMatchObject({ reason: "message-too-large" })
    }
  })

  it("rejects malformed, oversized, and excessive-fragment frames", () => {
    const decodeFrame = makeClientMessageFrameDecoder()
    expect(() => decodeFrame("{")).toThrow()
    expect(() => decodeFrame("x".repeat(maxFrameBytes + 1))).toThrow("Resident frame exceeds maximum size")
    expect(() =>
      decodeFrame(
        JSON.stringify({
          _tag: "resident-client-message-chunk",
          messageId: "message",
          index: 0,
          count: 17,
          text: "{}",
        }),
      ),
    ).toThrow("maximum chunk count")
  })

  it("discards out-of-order fragments and accepts a fresh ordered replay", () => {
    const message = submitMessage(2_000_000)
    const frames = clientMessageFrames("message", message)
    const decodeFrame = makeClientMessageFrameDecoder()

    expect(decodeFrame(frames.at(-1)!)).toBeUndefined()
    expect(frames.map(decodeFrame).filter(Boolean)).toEqual([message])
  })
})

describe("resident server message frames", () => {
  it("rejects malformed, oversized, and excessive-fragment frames", () => {
    const decodeFrame = makeServerMessageFrameDecoder()
    expect(() => decodeFrame("{")).toThrow()
    expect(() => decodeFrame("x".repeat(maxFrameBytes + 1))).toThrow("Resident frame exceeds maximum size")
    expect(() =>
      decodeFrame(
        JSON.stringify({
          _tag: "resident-server-message-chunk",
          messageId: "message",
          index: 0,
          count: 17,
          text: "{}",
        }),
      ),
    ).toThrow("maximum chunk count")
  })

  it("discards out-of-order fragments and accepts a fresh ordered replay", () => {
    const message = Schema.decodeUnknownSync(ResidentService.ServerMessage)({
      _tag: "interactive-feed-event",
      connectionId: "connection",
      requestId: "request",
      sessionId: "session",
      feedGeneration: "generation",
      sequence: 1,
      event: { _tag: "ExecutionFailed", selectionEpoch: 1, message: "x".repeat(1_100_000) },
    })
    const frames = serverMessageFrames("message", message)
    const decodeFrame = makeServerMessageFrameDecoder()

    expect(decodeFrame(frames.at(-1)!)).toBeUndefined()
    expect(frames.map(decodeFrame).filter(Boolean)).toEqual([message])
  })

  it("splits and reassembles an oversized interactive event", () => {
    const message = Schema.decodeUnknownSync(ResidentService.ServerMessage)({
      _tag: "interactive-feed-event",
      connectionId: "connection",
      requestId: "request",
      sessionId: "session",
      feedGeneration: "generation",
      sequence: 1,
      event: {
        _tag: "ExecutionFailed",
        selectionEpoch: 1,
        message: "x".repeat(1_100_000),
      },
    })
    const frames = serverMessageFrames("message", message)
    const decodeFrame = makeServerMessageFrameDecoder()
    const decoded = frames.map(decodeFrame).filter((value) => value !== undefined)

    expect(frames.length).toBeGreaterThan(1)
    expect(Math.max(...frames.map((frame) => encoder.encode(frame).byteLength))).toBeLessThanOrEqual(maxFrameBytes)
    expect(decoded).toEqual([message])
  })

  it("expires abandoned fragment sequences and reuses their bounded storage", () => {
    let now = 0
    const decodeFrame = makeServerMessageFrameDecoder({
      now: () => now,
      fragmentTtlMilliseconds: 100,
    })
    const abandoned = Array.from({ length: 16 }, (_, index) =>
      serverMessageFrames(
        `abandoned-${index}`,
        Schema.decodeUnknownSync(ResidentService.ServerMessage)({
          _tag: "interactive-feed-event",
          connectionId: "connection",
          requestId: "request",
          sessionId: "session",
          feedGeneration: "generation",
          sequence: index + 1,
          event: {
            _tag: "ExecutionFailed",
            selectionEpoch: 1,
            message: "x".repeat(1_100_000),
          },
        }),
      ),
    )
    for (const frames of abandoned) expect(decodeFrame(frames[0]!)).toBeUndefined()
    now = 101

    const message = Schema.decodeUnknownSync(ResidentService.ServerMessage)({
      _tag: "interactive-feed-event",
      connectionId: "connection",
      requestId: "request",
      sessionId: "session",
      feedGeneration: "generation",
      sequence: 17,
      event: {
        _tag: "ExecutionFailed",
        selectionEpoch: 1,
        message: "y".repeat(1_100_000),
      },
    })
    expect(serverMessageFrames("reused", message).map(decodeFrame).filter(Boolean)).toEqual([message])
    for (const frame of abandoned[0]!.slice(1)) expect(() => decodeFrame(frame)).not.toThrow()
  }, 15_000)

  it("bounds total incomplete reassembly bytes across message ids", () => {
    const makeMessage = (sequence: number, text: string) =>
      Schema.decodeUnknownSync(ResidentService.ServerMessage)({
        _tag: "interactive-feed-event",
        connectionId: "connection",
        requestId: "request",
        sessionId: "session",
        feedGeneration: "generation",
        sequence,
        event: { _tag: "ExecutionFailed", selectionEpoch: 1, message: text },
      })
    const first = serverMessageFrames("first", makeMessage(1, "x".repeat(1_100_000)))
    const secondMessage = makeMessage(2, "y".repeat(1_100_000))
    const second = serverMessageFrames("second", secondMessage)
    const decodeFrame = makeServerMessageFrameDecoder({ maxPendingBytes: 1_500_000 })

    expect(decodeFrame(first[0]!)).toBeUndefined()
    expect(decodeFrame(second[0]!)).toBeUndefined()
    expect(second.slice(1).map(decodeFrame).filter(Boolean)).toEqual([secondMessage])
    for (const frame of first.slice(1)) expect(() => decodeFrame(frame)).not.toThrow()
  })

  it("degrades a single event larger than the wire limit into an explicit marker", () => {
    const message = Schema.decodeUnknownSync(ResidentService.ServerMessage)({
      _tag: "interactive-feed-event",
      connectionId: "connection",
      requestId: "request",
      sessionId: "session",
      feedGeneration: "generation",
      sequence: 1,
      event: {
        _tag: "ExecutionFailed",
        selectionEpoch: 1,
        message: "x".repeat(20_000_000),
      },
    })
    const decodeFrame = makeServerMessageFrameDecoder()
    const decoded = serverMessageFrames("oversized", message)
      .map(decodeFrame)
      .filter((value) => value !== undefined)

    expect(decoded).toHaveLength(1)
    expect(decoded[0]).toMatchObject({
      _tag: "interactive-feed-event",
      sequence: 1,
      event: {
        _tag: "ExecutionFailed",
        message: expect.stringContaining("omitted an event larger than 16 MiB"),
      },
    })
  })

  it("keeps a transcript resync target when an oversized patch is omitted", () => {
    const message = Schema.decodeUnknownSync(ResidentService.ServerMessage)({
      _tag: "interactive-feed-event",
      connectionId: "connection",
      requestId: "request",
      sessionId: "session",
      feedGeneration: "generation",
      sequence: 1,
      event: {
        _tag: "TranscriptPatched",
        selectionEpoch: 3,
        threadId: "thread",
        turnId: "turn",
        event: {
          cursor: "cursor",
          sequence: 1,
          type: "model.output.delta",
          createdAt: 1,
          text: "x".repeat(20_000_000),
        },
        revision: 1,
      },
    })
    const decodeFrame = makeServerMessageFrameDecoder()
    const decoded = serverMessageFrames("oversized-patch", message)
      .map(decodeFrame)
      .filter((value) => value !== undefined)

    expect(decoded).toEqual([
      {
        _tag: "interactive-feed-event",
        connectionId: "connection",
        requestId: "request",
        sessionId: "session",
        feedGeneration: "generation",
        sequence: 1,
        event: {
          _tag: "TranscriptResyncRequired",
          selectionEpoch: 3,
          threadId: "thread",
          reason:
            "Resident live delivery omitted an event larger than 16 MiB; reload the durable transcript for the full content",
        },
      },
    ])
  })

  it("terminates oversized resync degradation with a bounded decodable marker", () => {
    const events = Array.from({ length: 18 }, (_, index) => ({
      _tag: "TranscriptResyncRequired",
      selectionEpoch: 1,
      threadId: `thread-${index}-${"x".repeat(950_000)}`,
      reason: "reload",
    }))
    const message = Schema.decodeUnknownSync(ResidentService.ServerMessage)({
      _tag: "interactive-feed-resync",
      connectionId: "connection",
      requestId: "request",
      sessionId: "session",
      feedGeneration: "generation",
      sequence: 1,
      events,
    })
    const frames = serverMessageFrames("oversized-resync", message)
    const decodeFrame = makeServerMessageFrameDecoder()
    const decoded = frames.map(decodeFrame).filter((value) => value !== undefined)

    expect(frames.length).toBeLessThanOrEqual(16)
    expect(decoded).toHaveLength(1)
    expect(decoded[0]).toMatchObject({
      _tag: "interactive-feed-resync",
      events: [{ _tag: "ExecutionFailed", message: expect.stringContaining("omitted an event larger than 16 MiB") }],
    })
  }, 30_000)
})
