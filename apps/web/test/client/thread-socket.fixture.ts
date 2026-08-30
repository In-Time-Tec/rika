import { afterEach, beforeEach, vi } from "vitest"
import { Effect, Schema } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import * as ExecutionProjection from "@rika/product/execution-projection"
import { ClientMessage, protocolVersion, ServerFrame } from "@rika/product/client-protocol"
import { connectThread as connectThreadEffect } from "../../src/client/thread-socket"

export type ClientFrame = {
  readonly protocolVersion: typeof protocolVersion
  readonly payload:
    | { readonly _tag: "ClientDecodeFailed"; readonly message: string }
    | { readonly _tag: "ClientReconnecting"; readonly threadId: string | undefined }
    | { readonly _tag: "ClientReconnectFailed"; readonly threadId: string; readonly message: string }
}
export type ObservedFrame = ServerFrame | ClientFrame

declare global {
  interface WindowEventMap {
    readonly "rika:thread-frame": CustomEvent<ObservedFrame>
  }
}

interface ServerFrameInput {
  readonly protocolVersion: number
  readonly payload: object
}

export class TestWebSocket extends EventTarget implements WebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: Array<TestWebSocket> = []
  readonly sent: Array<ClientMessage> = []
  readonly binaryType: BinaryType = "blob"
  readonly bufferedAmount = 0
  readonly extensions = ""
  readonly protocol = ""
  readonly CONNECTING = TestWebSocket.CONNECTING
  readonly OPEN = TestWebSocket.OPEN
  readonly CLOSING = TestWebSocket.CLOSING
  readonly CLOSED = TestWebSocket.CLOSED
  onclose: WebSocket["onclose"] = null
  onerror: WebSocket["onerror"] = null
  onmessage: WebSocket["onmessage"] = null
  onopen: WebSocket["onopen"] = null
  readyState: WebSocket["readyState"] = TestWebSocket.CONNECTING
  closeCode: number | undefined
  closeReason: string | undefined

  constructor(
    readonly url: string,
    readonly protocols: string | ReadonlyArray<string>,
  ) {
    super()
    TestWebSocket.instances.push(this)
  }

  send(value: string | ArrayBufferLike | Blob | ArrayBufferView) {
    const json = Schema.decodeUnknownSync(Schema.String)(value)
    this.sent.push(Schema.decodeSync(Schema.fromJsonString(ClientMessage))(json))
  }

  close(code?: number, reason?: string) {
    if (this.readyState === TestWebSocket.CLOSED) return
    this.closeCode = code
    this.closeReason = reason
    this.readyState = TestWebSocket.CLOSED
    this.dispatchEvent(new Event("close"))
  }

  receive(frame: ServerFrameInput) {
    const validated = Schema.decodeUnknownSync(ServerFrame)(frame)
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(validated) }))
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
  const request = Schema.decodeUnknownSync(ClientMessage)(connection.sent[0])
  connection.receive({
    protocolVersion,
    payload: {
      _tag: "ThreadAttached",
      requestId: request.requestId,
      threadId: requestedThreadId,
      baseCursor: cursor,
      threadVersion,
      cursor,
      checkpoint: { threadVersion, cursor, snapshot: snapshot(snapshotThreadId) },
      events: [],
      participants: [],
    },
  })
}

const threadEvent = (threadId: string, cursor: string, threadVersion: string) => ({
  protocolVersion,
  payload: {
    _tag: "ThreadEvent" as const,
    event: {
      threadId,
      sequence: cursor,
      cursor,
      threadVersion,
      createdAt: "2026-08-21T00:00:00.000Z",
      event: { _tag: "ThreadViewSnapshot" as const, snapshot: snapshot(threadId).view },
    },
  },
})

const nextConnection = (index: number) =>
  Effect.gen(function* () {
    while (TestWebSocket.instances[index] === undefined) yield* Effect.yieldNow
    const connection = TestWebSocket.instances[index]
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
        new TestWebSocket(
          url,
          Schema.decodeSync(Schema.Union([Schema.String, Schema.Array(Schema.String)]))(protocols ?? []),
        ),
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
            JSON.stringify({ ticket: "ticket", websocketUrl: "ws://thread.test", protocol: "rika.thread.v1" }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
      ),
    ),
  )
})

afterEach(() => vi.unstubAllGlobals())

export const socketFixture = { attach, connectThread, nextConnection, snapshot, threadEvent }
