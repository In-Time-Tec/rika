import { describe, expect, it } from "@effect/vitest"
import * as ServerService from "@rika/product/server-service"
import { Schema } from "effect"
import {
  clientMessageFrames,
  makeClientMessageFrameDecoder,
  makeServerMessageFrameDecoder,
  maxClientMessageBytes,
  outputFrames,
  serverMessageFrames,
} from "../src/transport/protocol/server-message-codec"
import { maxFrameBytes, parse } from "../src/transport/protocol/server-protocol"

const decode = Schema.decodeUnknownSync(ServerService.ServerMessage)
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

describe("server output frames", () => {
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

describe("server client message frames", () => {
  const submitMessage = (dataBytes: number) =>
    Schema.decodeUnknownSync(ServerService.ClientMessage)({
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

  it("round-trips typed authorization decisions without raw Baton identities", () => {
    for (const command of [
      { _tag: "ApproveAuthorization" as const, turnId: "turn", authorizationId: "authorization" },
      { _tag: "DenyAuthorization" as const, turnId: "turn", authorizationId: "authorization" },
    ]) {
      const message = Schema.decodeUnknownSync(ServerService.ClientMessage)({
        _tag: "interactive-command",
        connectionId: "connection",
        requestId: "request",
        sessionId: "session",
        feedGeneration: "generation",
        commandSequence: 1,
        command,
      })
      const frames = clientMessageFrames("message", message)
      expect(frames).toHaveLength(1)
      expect(makeClientMessageFrameDecoder()(frames[0]!)).toEqual(message)
      expect(frames[0]).not.toContain("runId")
      expect(frames[0]).not.toContain("approvalId")
    }
  })

  it("fails a message beyond the chunk ceiling with a typed message-too-large error", () => {
    expect(maxClientMessageBytes).toBe(16 * maxFrameBytes)
    try {
      clientMessageFrames("message", submitMessage(maxClientMessageBytes + 1_000_000))
      expect.unreachable("clientMessageFrames must throw for an over-ceiling message")
    } catch (error) {
      expect(Schema.is(ServerService.ServerServiceError)(error)).toBe(true)
      expect(error).toMatchObject({ reason: "message-too-large" })
    }
  })

  it("rejects malformed, oversized, and excessive-fragment frames", () => {
    const decodeFrame = makeClientMessageFrameDecoder()
    expect(() => decodeFrame("{")).toThrow()
    expect(() => decodeFrame("x".repeat(maxFrameBytes + 1))).toThrow("Server frame exceeds maximum size")
    expect(() =>
      decodeFrame(
        JSON.stringify({
          _tag: "server-client-message-chunk",
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

describe("server message frames", () => {
  it("rejects malformed, oversized, and excessive-fragment frames", () => {
    const decodeFrame = makeServerMessageFrameDecoder()
    expect(() => decodeFrame("{")).toThrow()
    expect(() => decodeFrame("x".repeat(maxFrameBytes + 1))).toThrow("Server frame exceeds maximum size")
    expect(() =>
      decodeFrame(
        JSON.stringify({
          _tag: "server-server-message-chunk",
          messageId: "message",
          index: 0,
          count: 17,
          text: "{}",
        }),
      ),
    ).toThrow("maximum chunk count")
  })

  it("discards out-of-order fragments and accepts a fresh ordered replay", () => {
    const message = Schema.decodeUnknownSync(ServerService.ServerMessage)({
      _tag: "interactive-feed-event",
      connectionId: "connection",
      requestId: "request",
      sessionId: "session",
      feedGeneration: "generation",
      sequence: 1,
      event: {
        _tag: "ExecutionFailed",
        selectionEpoch: 1,
        failure: {
          tag: "TestFailure",
          message: "x".repeat(1_100_000),
          category: "operation",
          retryable: false,
          retry: "none",
          actor: "environment",
        },
      },
    })
    const frames = serverMessageFrames("message", message)
    const decodeFrame = makeServerMessageFrameDecoder()

    expect(decodeFrame(frames.at(-1)!)).toBeUndefined()
    expect(frames.map(decodeFrame).filter(Boolean)).toEqual([message])
  })

  it("splits and reassembles an oversized interactive event", () => {
    const message = Schema.decodeUnknownSync(ServerService.ServerMessage)({
      _tag: "interactive-feed-event",
      connectionId: "connection",
      requestId: "request",
      sessionId: "session",
      feedGeneration: "generation",
      sequence: 1,
      event: {
        _tag: "ExecutionFailed",
        selectionEpoch: 1,
        failure: {
          tag: "TestFailure",
          message: "x".repeat(1_100_000),
          category: "operation",
          retryable: false,
          retry: "none",
          actor: "environment",
        },
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
        Schema.decodeUnknownSync(ServerService.ServerMessage)({
          _tag: "interactive-feed-event",
          connectionId: "connection",
          requestId: "request",
          sessionId: "session",
          feedGeneration: "generation",
          sequence: index + 1,
          event: {
            _tag: "ExecutionFailed",
            selectionEpoch: 1,
            failure: {
              tag: "TestFailure",
              message: "x".repeat(1_100_000),
              category: "operation",
              retryable: false,
              retry: "none",
              actor: "environment",
            },
          },
        }),
      ),
    )
    for (const frames of abandoned) expect(decodeFrame(frames[0]!)).toBeUndefined()
    now = 101

    const message = Schema.decodeUnknownSync(ServerService.ServerMessage)({
      _tag: "interactive-feed-event",
      connectionId: "connection",
      requestId: "request",
      sessionId: "session",
      feedGeneration: "generation",
      sequence: 17,
      event: {
        _tag: "ExecutionFailed",
        selectionEpoch: 1,
        failure: {
          tag: "TestFailure",
          message: "y".repeat(1_100_000),
          category: "operation",
          retryable: false,
          retry: "none",
          actor: "environment",
        },
      },
    })
    expect(serverMessageFrames("reused", message).map(decodeFrame).filter(Boolean)).toEqual([message])
    for (const frame of abandoned[0]!.slice(1)) expect(() => decodeFrame(frame)).not.toThrow()
  }, 30_000)

  it("bounds total incomplete reassembly bytes across message ids", () => {
    const makeMessage = (sequence: number, text: string) =>
      Schema.decodeUnknownSync(ServerService.ServerMessage)({
        _tag: "interactive-feed-event",
        connectionId: "connection",
        requestId: "request",
        sessionId: "session",
        feedGeneration: "generation",
        sequence,
        event: {
          _tag: "ExecutionFailed",
          selectionEpoch: 1,
          failure: {
            tag: "TestFailure",
            message: text,
            category: "operation",
            retryable: false,
            retry: "none",
            actor: "environment",
          },
        },
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
    const message = Schema.decodeUnknownSync(ServerService.ServerMessage)({
      _tag: "interactive-feed-event",
      connectionId: "connection",
      requestId: "request",
      sessionId: "session",
      feedGeneration: "generation",
      sequence: 1,
      event: {
        _tag: "ExecutionFailed",
        selectionEpoch: 1,
        failure: {
          tag: "TestFailure",
          message: "x".repeat(20_000_000),
          category: "operation",
          retryable: false,
          retry: "none",
          actor: "environment",
        },
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
        failure: expect.objectContaining({
          message: expect.stringContaining("omitted an event larger than 16 MiB"),
          tag: "TransportDegraded",
        }),
      },
    })
  })

  it("keeps a ThreadView resync target when an oversized patch is omitted", () => {
    const hugeKey = "answer"
    const message = Schema.decodeUnknownSync(ServerService.ServerMessage)({
      _tag: "interactive-feed-event",
      connectionId: "connection",
      requestId: "request",
      sessionId: "session",
      feedGeneration: "generation",
      sequence: 1,
      event: {
        _tag: "ThreadViewPatch",
        patch: {
          threadId: "thread",
          baseRevision: 0,
          revision: 1,
          upsert: [
            {
              key: hugeKey,
              turnId: "turn",
              order: [{ sequence: 1, part: 0, key: hugeKey }],
              revision: 1,
              content: { _tag: "Entry", role: "assistant", text: "x".repeat(20_000_000) },
            },
          ],
          remove: [],
          turnChanges: [],
        },
      },
    })
    const decodeFrame = makeServerMessageFrameDecoder()
    const decoded = serverMessageFrames("oversized-patch", message)
      .map(decodeFrame)
      .filter((value) => value !== undefined)

    expect(decoded).toHaveLength(1)
    expect(decoded[0]).toMatchObject({
      _tag: "interactive-feed-event",
      connectionId: "connection",
      requestId: "request",
      sessionId: "session",
      feedGeneration: "generation",
      sequence: 1,
      event: {
        _tag: "ResyncRequired",
        threadId: "thread",
        expectedRevision: 1,
        receivedBaseRevision: 0,
        currentRevision: 0,
      },
    })
  })
})
