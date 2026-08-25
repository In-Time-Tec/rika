// @vitest-environment happy-dom

import { afterEach, beforeEach, vi } from "vitest"
import { expect, it } from "@effect/vitest"
import { Effect, Fiber, Result, Schema } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import * as ExecutionProjection from "@rika/product/execution-projection"
import { connectThread as connectThreadEffect, frameEventName, sendPrompt } from "../src/client/thread-socket"

class TestWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: Array<TestWebSocket> = []

  readonly sent: Array<unknown> = []
  readyState = TestWebSocket.CONNECTING
  closeCode: number | undefined
  closeReason: string | undefined

  constructor(
    readonly url: string,
    readonly protocols: ReadonlyArray<string>,
  ) {
    super()
    TestWebSocket.instances.push(this)
  }

  send(value: string) {
    this.sent.push(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(value))
  }

  close(code?: number, reason?: string) {
    if (this.readyState === TestWebSocket.CLOSED) return
    this.closeCode = code
    this.closeReason = reason
    this.readyState = TestWebSocket.CLOSED
    this.dispatchEvent(new Event("close"))
  }

  receive(frame: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }))
  }

  receiveRaw(data: string) {
    this.dispatchEvent(new MessageEvent("message", { data }))
  }
}

const snapshot = (threadId: string) => ({
  executorKind: "runner",
  view: {
    thread: {
      id: threadId,
      workspace: "workspace-1",
      title: "Thread",
      labels: [],
      pinned: false,
      archived: false,
      lineage: { _tag: "Original" },
      createdAt: 1,
      updatedAt: 1,
    },
    revision: 0,
    source: { projectionVersion: ExecutionProjection.projectionVersion },
    turns: [],
    pending: [],
    hasOlder: false,
    hasNewer: false,
    usage: { state: ExecutionProjection.emptyUsageState() },
  },
  pendingAuthorizations: [],
})

const attach = (
  connection: TestWebSocket,
  requestedThreadId: string,
  snapshotThreadId = requestedThreadId,
  cursor = "0",
  threadVersion = "1",
) => {
  const request = connection.sent[0] as { readonly requestId: string }
  connection.receive({
    protocolVersion: 1,
    payload: {
      _tag: "ThreadAttached",
      requestId: request.requestId,
      threadId: requestedThreadId,
      snapshotThreadVersion: threadVersion,
      snapshotCursor: cursor,
      threadVersion,
      cursor,
      snapshot: snapshot(snapshotThreadId),
      events: [],
      participants: [],
    },
  })
}

const threadEvent = (threadId: string, cursor: string, threadVersion: string) => ({
  protocolVersion: 1,
  payload: {
    _tag: "ThreadEvent",
    event: {
      threadId,
      sequence: cursor,
      cursor,
      threadVersion,
      createdAt: "2026-08-21T00:00:00.000Z",
      event: { _tag: "ThreadViewSnapshot", snapshot: snapshot(threadId).view },
    },
  },
})

const nextConnection = (index: number) =>
  Effect.gen(function* () {
    while (TestWebSocket.instances[index] === undefined) yield* Effect.yieldNow
    const connection = TestWebSocket.instances[index]!
    if (connection.readyState === TestWebSocket.CONNECTING) {
      connection.readyState = TestWebSocket.OPEN
      connection.dispatchEvent(new Event("open"))
    }
    while (connection.sent.length === 0) yield* Effect.yieldNow
    return connection
  })

const connectThread = (threadId: string) =>
  connectThreadEffect(threadId).pipe(
    Effect.provideService(
      Socket.WebSocketConstructor,
      (url, protocols) =>
        new TestWebSocket(url, typeof protocols === "string" ? [protocols] : (protocols ?? [])) as unknown as WebSocket,
    ),
  )

beforeEach(() => {
  TestWebSocket.instances = []
  vi.stubGlobal("WebSocket", TestWebSocket)
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Effect.runPromise(
        Effect.succeed(
          new Response(
            JSON.stringify({
              ticket: "ticket",
              websocketUrl: "ws://thread.test",
              protocol: "rika.thread.v1",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
      ),
    ),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

it.effect("acknowledges every committed attachment, event, and snapshot cursor", () =>
  Effect.gen(function* () {
    const connecting = yield* Effect.forkChild(Effect.result(connectThread("thread-ack")))
    const connection = yield* nextConnection(0)
    attach(connection, "thread-ack", "thread-ack", "3", "3")
    yield* Fiber.join(connecting)
    expect(connection.sent.at(-1)).toMatchObject({
      command: { _tag: "AcknowledgeCursor", threadId: "thread-ack", cursor: "3" },
    })

    connection.receive(threadEvent("thread-ack", "4", "4"))
    expect(connection.sent.at(-1)).toMatchObject({
      command: { _tag: "AcknowledgeCursor", threadId: "thread-ack", cursor: "4" },
    })
    connection.receive({
      protocolVersion: 1,
      payload: {
        _tag: "ThreadSnapshot",
        threadId: "thread-ack",
        threadVersion: "5",
        cursor: "5",
        snapshot: snapshot("thread-ack"),
      },
    })
    expect(connection.sent.at(-1)).toMatchObject({
      command: { _tag: "AcknowledgeCursor", threadId: "thread-ack", cursor: "5" },
    })
  }),
)

it.effect("keeps A active while B attaches, then makes late A frames and close inert after the atomic swap", () =>
  Effect.gen(function* () {
    const frames: Array<unknown> = []
    const receive = (event: Event) => frames.push((event as CustomEvent).detail)
    window.addEventListener(frameEventName, receive)
    try {
      const connectingA = yield* Effect.forkChild(Effect.result(connectThread("thread-a")))
      const first = yield* nextConnection(0)
      attach(first, "thread-a")
      expect(Result.getOrThrow(yield* Fiber.join(connectingA))).toMatchObject({ threadId: "thread-a" })
      frames.length = 0

      const connectingB = yield* Effect.forkChild(Effect.result(connectThread("thread-b")))
      const second = yield* nextConnection(1)
      first.receive({
        protocolVersion: 1,
        payload: {
          _tag: "ThreadSnapshot",
          threadId: "thread-a",
          threadVersion: "9",
          cursor: "9",
          snapshot: snapshot("thread-a"),
        },
      })
      expect(frames).toHaveLength(1)

      attach(second, "thread-b")
      expect(Result.getOrThrow(yield* Fiber.join(connectingB))).toMatchObject({ threadId: "thread-b" })
      yield* Effect.yieldNow
      expect(first.readyState).toBe(TestWebSocket.CLOSED)
      expect(TestWebSocket.instances).toHaveLength(2)
      expect(frames).toHaveLength(1)

      first.receive({
        protocolVersion: 1,
        payload: { _tag: "PresenceSnapshot", threadId: "thread-a", participants: [] },
      })
      second.receive({
        protocolVersion: 1,
        payload: { _tag: "PresenceSnapshot", threadId: "thread-a", participants: [] },
      })
      expect(frames).toHaveLength(1)
    } finally {
      window.removeEventListener(frameEventName, receive)
    }
  }),
)

it.effect("leaves committed A and its prompt route usable when B is mismatched or rejected", () =>
  Effect.gen(function* () {
    const connectingA = yield* Effect.forkChild(Effect.result(connectThread("thread-a")))
    const committed = yield* nextConnection(0)
    attach(committed, "thread-a")
    yield* Fiber.join(connectingA)

    const mismatched = yield* Effect.forkChild(Effect.result(connectThread("thread-mismatch")))
    const mismatchSocket = yield* nextConnection(1)
    attach(mismatchSocket, "thread-mismatch", "thread-wrong")
    expect(yield* Fiber.join(mismatched)).toMatchObject({ _tag: "Failure" })
    expect(mismatchSocket.readyState).toBe(TestWebSocket.CLOSED)
    yield* sendPrompt({ threadId: "thread-a", threadVersion: "1", text: "still routed to A" })
    expect(committed.sent.at(-1)).toMatchObject({ command: { _tag: "SubmitPrompt", threadId: "thread-a" } })

    const rejected = yield* Effect.forkChild(Effect.result(connectThread("thread-rejected")))
    const rejectedSocket = yield* nextConnection(2)
    const request = rejectedSocket.sent[0] as { readonly requestId: string }
    rejectedSocket.receive({
      protocolVersion: 1,
      payload: {
        _tag: "CommandRejected",
        requestId: request.requestId,
        threadId: "thread-rejected",
        reason: "unavailable",
        message: "attachment unavailable",
        details: {},
      },
    })
    expect(yield* Fiber.join(rejected)).toMatchObject({ _tag: "Failure" })
    expect(rejectedSocket.readyState).toBe(TestWebSocket.CLOSED)
    expect(committed.readyState).toBe(TestWebSocket.OPEN)
  }),
)

it.effect("lets C supersede pending B without disturbing committed A", () =>
  Effect.gen(function* () {
    const connectingA = yield* Effect.forkChild(Effect.result(connectThread("thread-a")))
    const first = yield* nextConnection(0)
    attach(first, "thread-a")
    yield* Fiber.join(connectingA)
    const connectingB = yield* Effect.forkChild(Effect.result(connectThread("thread-b")))
    const second = yield* nextConnection(1)
    const connectingC = yield* Effect.forkChild(Effect.result(connectThread("thread-c")))
    const third = yield* nextConnection(2)
    expect(yield* Fiber.join(connectingB)).toMatchObject({ _tag: "Failure" })
    expect(second.readyState).toBe(TestWebSocket.CLOSED)
    expect(first.readyState).toBe(TestWebSocket.OPEN)

    attach(second, "thread-b")
    attach(third, "thread-c")
    expect(Result.getOrThrow(yield* Fiber.join(connectingC))).toMatchObject({ threadId: "thread-c" })
    expect(first.readyState).toBe(TestWebSocket.CLOSED)
    expect(
      yield* Effect.result(sendPrompt({ threadId: "thread-b", threadVersion: "1", text: "stale candidate" })),
    ).toMatchObject({ _tag: "Failure" })
  }),
)

it.effect(
  "reconnects the same Thread after the captured cursor and rejects a candidate that falls behind advancing A",
  () =>
    Effect.gen(function* () {
      const connectingA = yield* Effect.forkChild(Effect.result(connectThread("thread-cursor")))
      const first = yield* nextConnection(0)
      attach(first, "thread-cursor")
      yield* Fiber.join(connectingA)
      first.receive({
        protocolVersion: 1,
        payload: {
          _tag: "ThreadSnapshot",
          threadId: "thread-cursor",
          threadVersion: "2",
          cursor: "1",
          snapshot: snapshot("thread-cursor"),
        },
      })

      const reconnecting = yield* Effect.forkChild(Effect.result(connectThread("thread-cursor")))
      const second = yield* nextConnection(1)
      expect(second.sent[0]).toMatchObject({ command: { _tag: "AttachThread", afterCursor: "1" } })
      first.receive({
        protocolVersion: 1,
        payload: {
          _tag: "ThreadSnapshot",
          threadId: "thread-cursor",
          threadVersion: "2",
          cursor: "2",
          snapshot: snapshot("thread-cursor"),
        },
      })
      attach(second, "thread-cursor", "thread-cursor", "1", "2")
      expect(yield* Fiber.join(reconnecting)).toMatchObject({ _tag: "Failure" })
      expect(first.readyState).toBe(TestWebSocket.OPEN)
      yield* sendPrompt({ threadId: "thread-cursor", threadVersion: "2", text: "A advanced" })
    }),
)

it.effect(
  "recovers an unexpectedly closed selected Thread from its committed cursor and applies contiguous replay once",
  () =>
    Effect.gen(function* () {
      const frames: Array<any> = []
      const receive = (event: Event) => frames.push((event as CustomEvent).detail)
      window.addEventListener(frameEventName, receive)
      try {
        const connecting = yield* Effect.forkChild(Effect.result(connectThread("thread-recovery")))
        const first = yield* nextConnection(0)
        attach(first, "thread-recovery", "thread-recovery", "4", "4")
        yield* Fiber.join(connecting)
        first.receive(threadEvent("thread-recovery", "5", "5"))
        first.close()

        const replacement = yield* nextConnection(1)
        expect(replacement.sent[0]).toMatchObject({ command: { _tag: "AttachThread", afterCursor: "5" } })
        const request = replacement.sent[0] as { readonly requestId: string }
        replacement.receive({
          protocolVersion: 1,
          payload: {
            _tag: "ThreadAttached",
            requestId: request.requestId,
            threadId: "thread-recovery",
            snapshotThreadVersion: "5",
            snapshotCursor: "5",
            threadVersion: "7",
            cursor: "7",
            snapshot: snapshot("thread-recovery"),
            events: [
              threadEvent("thread-recovery", "6", "6").payload.event,
              threadEvent("thread-recovery", "7", "7").payload.event,
            ],
            participants: [],
          },
        })
        yield* Effect.tryPromise(() => vi.waitFor(() => expect(replacement.readyState).toBe(TestWebSocket.OPEN)))
        replacement.receive(threadEvent("thread-recovery", "7", "7"))
        replacement.receive(threadEvent("thread-recovery", "8", "8"))
        expect(
          frames.filter((frame) => frame.payload?._tag === "ThreadEvent").map((frame) => frame.payload.event.cursor),
        ).toEqual(["5", "8"])
      } finally {
        window.removeEventListener(frameEventName, receive)
      }
    }),
)

it.effect(
  "recovers a semantically quarantined selected Thread from its committed cursor without changing its identity",
  () =>
    Effect.gen(function* () {
      const frames: Array<any> = []
      const receive = (event: Event) => frames.push((event as CustomEvent).detail)
      window.addEventListener(frameEventName, receive)
      try {
        const connecting = yield* Effect.forkChild(Effect.result(connectThread("thread-a")))
        const first = yield* nextConnection(0)
        attach(first, "thread-a", "thread-a", "5", "5")
        yield* Fiber.join(connecting)
        frames.length = 0

        first.receive(threadEvent("thread-foreign", "6", "6"))
        expect(first.closeCode).toBe(1002)
        expect(first.closeReason).toBe("foreign Thread frame")
        expect(frames.filter((frame) => frame.payload?._tag === "ThreadEvent")).toEqual([])

        const replacement = yield* nextConnection(1)
        expect(replacement.sent[0]).toMatchObject({
          command: { _tag: "AttachThread", threadId: "thread-a", afterCursor: "5" },
        })
        const request = replacement.sent[0] as { readonly requestId: string }
        replacement.receive({
          protocolVersion: 1,
          payload: {
            _tag: "ThreadAttached",
            requestId: request.requestId,
            threadId: "thread-a",
            snapshotThreadVersion: "5",
            snapshotCursor: "5",
            threadVersion: "6",
            cursor: "6",
            snapshot: snapshot("thread-a"),
            events: [threadEvent("thread-a", "6", "6").payload.event],
            participants: [],
          },
        })
        yield* Effect.tryPromise(() => vi.waitFor(() => expect(replacement.readyState).toBe(TestWebSocket.OPEN)))

        replacement.receive(threadEvent("thread-a", "6", "6"))
        replacement.receive(threadEvent("thread-a", "7", "7"))
        expect(
          frames.filter((frame) => frame.payload?._tag === "ThreadEvent").map((frame) => frame.payload.event.cursor),
        ).toEqual(["7"])
        yield* sendPrompt({ threadId: "thread-a", threadVersion: "7", text: "still A" })
        expect(replacement.sent.at(-1)).toMatchObject({ command: { _tag: "SubmitPrompt", threadId: "thread-a" } })
      } finally {
        window.removeEventListener(frameEventName, receive)
      }
    }),
)

it.effect(
  "recovers selected A after malformed bytes while rejecting a malformed candidate B without disturbing A",
  () =>
    Effect.gen(function* () {
      const frames: Array<any> = []
      const receive = (event: Event) => frames.push((event as CustomEvent).detail)
      window.addEventListener(frameEventName, receive)
      try {
        const connecting = yield* Effect.forkChild(Effect.result(connectThread("thread-a")))
        const first = yield* nextConnection(0)
        attach(first, "thread-a", "thread-a", "9", "9")
        yield* Fiber.join(connecting)
        frames.length = 0

        first.receiveRaw("malformed bytes")
        expect(first.closeCode).toBe(1002)
        expect(first.closeReason).toBe("invalid Server frame")
        expect(frames.map((frame) => frame.payload?._tag)).toEqual(["ClientDecodeFailed", "ClientReconnecting"])

        const replacement = yield* nextConnection(1)
        expect(replacement.sent[0]).toMatchObject({
          command: { _tag: "AttachThread", threadId: "thread-a", afterCursor: "9" },
        })
        attach(replacement, "thread-a", "thread-a", "9", "9")
        yield* Effect.tryPromise(() => vi.waitFor(() => expect(replacement.readyState).toBe(TestWebSocket.OPEN)))
        yield* sendPrompt({ threadId: "thread-a", threadVersion: "9", text: "still selected A" })
        expect(replacement.sent.at(-1)).toMatchObject({ command: { _tag: "SubmitPrompt", threadId: "thread-a" } })

        const connectingB = yield* Effect.forkChild(Effect.result(connectThread("thread-b")))
        const malformedCandidate = yield* nextConnection(2)
        malformedCandidate.receiveRaw("malformed candidate bytes")
        expect(yield* Fiber.join(connectingB)).toMatchObject({ _tag: "Failure" })
        expect(malformedCandidate.readyState).toBe(TestWebSocket.CLOSED)
        expect(TestWebSocket.instances).toHaveLength(3)
        expect(replacement.readyState).toBe(TestWebSocket.OPEN)
        yield* sendPrompt({ threadId: "thread-a", threadVersion: "9", text: "candidate left A live" })
      } finally {
        window.removeEventListener(frameEventName, receive)
      }
    }),
)

it.effect("preserves selected identity after failed automatic recovery and allows an explicit retry", () =>
  Effect.gen(function* () {
    const connecting = yield* Effect.forkChild(Effect.result(connectThread("thread-retry")))
    const first = yield* nextConnection(0)
    attach(first, "thread-retry", "thread-retry", "3", "3")
    yield* Fiber.join(connecting)
    first.close()
    const failed = yield* nextConnection(1)
    const failedRequest = failed.sent[0] as { readonly requestId: string }
    failed.receive({
      protocolVersion: 1,
      payload: {
        _tag: "CommandRejected",
        requestId: failedRequest.requestId,
        threadId: "thread-retry",
        reason: "unavailable",
        message: "no",
        details: {},
      },
    })
    yield* Effect.tryPromise(() => vi.waitFor(() => expect(failed.readyState).toBe(TestWebSocket.CLOSED)))

    const retrying = yield* Effect.forkChild(Effect.result(connectThread("thread-retry")))
    const retry = yield* nextConnection(2)
    expect(retry.sent[0]).toMatchObject({ command: { afterCursor: "3" } })
    attach(retry, "thread-retry", "thread-retry", "3", "3")
    expect(Result.getOrThrow(yield* Fiber.join(retrying))).toMatchObject({ threadId: "thread-retry" })
  }),
)

it.effect("quarantines semantic view gaps and nested foreign snapshot identities before emitting them", () =>
  Effect.gen(function* () {
    const frames: Array<unknown> = []
    const receive = (event: Event) => frames.push((event as CustomEvent).detail)
    window.addEventListener(frameEventName, receive)
    try {
      const connectingView = yield* Effect.forkChild(Effect.result(connectThread("thread-view")))
      const viewSocket = yield* nextConnection(0)
      attach(viewSocket, "thread-view")
      yield* Fiber.join(connectingView)
      frames.length = 0
      viewSocket.receive({
        protocolVersion: 1,
        payload: {
          _tag: "ThreadEvent",
          event: {
            threadId: "thread-view",
            sequence: "1",
            cursor: "1",
            threadVersion: "1",
            createdAt: "2026-08-21T00:00:00.000Z",
            event: {
              _tag: "ThreadViewPatch",
              patch: {
                threadId: "thread-view",
                baseRevision: 9,
                revision: 10,
                upsert: [],
                remove: [],
                turnChanges: [],
              },
            },
          },
        },
      })
      expect(viewSocket.readyState).toBe(TestWebSocket.CLOSED)
      expect(frames.filter((frame: any) => frame.payload?._tag === "ThreadEvent")).toEqual([])
      const viewReplacement = yield* nextConnection(1)
      attach(viewReplacement, "thread-view")
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(viewReplacement.readyState).toBe(TestWebSocket.OPEN)))

      const connectingSnapshot = yield* Effect.forkChild(Effect.result(connectThread("thread-snapshot")))
      const snapshotSocket = yield* nextConnection(2)
      attach(snapshotSocket, "thread-snapshot")
      yield* Fiber.join(connectingSnapshot)
      frames.length = 0
      snapshotSocket.receive({
        protocolVersion: 1,
        payload: {
          _tag: "ThreadSnapshot",
          threadId: "thread-snapshot",
          threadVersion: "2",
          cursor: "0",
          snapshot: snapshot("thread-foreign"),
        },
      })
      expect(snapshotSocket.readyState).toBe(TestWebSocket.CLOSED)
      expect(frames.filter((frame: any) => frame.payload?._tag === "ThreadSnapshot")).toEqual([])
    } finally {
      window.removeEventListener(frameEventName, receive)
    }
  }),
)
