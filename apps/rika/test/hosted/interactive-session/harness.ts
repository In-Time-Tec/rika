import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import {
  ClientMessage,
  protocolVersion,
  ServerFrame,
  type HostedThreadSnapshot,
  type ThreadProtocolEvent,
} from "@rika/product/client-protocol"
import * as ExecutionProjection from "@rika/product/execution-projection"
import {
  Sequence,
  ThreadEventCursor,
  ThreadId as HostedThreadId,
  ThreadVersion,
  Timestamp,
} from "@rika/product/hosted-model"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import { Crypto, Effect, Inspectable, Layer, Option, Redacted, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as Socket from "effect/unstable/socket/Socket"
import {
  CredentialStore,
  HostedError,
  Http,
  ProfileStore,
  type HttpInterface,
  type PrivateJwk,
  type Profile,
} from "../../../src/hosted/contract"
import { makeHostedInteractiveSession } from "../../../src/hosted/interactive-session"

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(ClientMessage))

const encode = Schema.encodeSync(Schema.fromJsonString(ServerFrame))

export type Message = ClientMessage

export type Frame = ServerFrame

export type Attached = Extract<Frame["payload"], { readonly _tag: "ThreadAttached" }>

const profile: Profile = {
  origin: "https://hosted.example.test",
  deviceId: "device-1",
  clientId: "client-1",
  owner: { kind: "personal" },
}

const key: PrivateJwk = { kty: "EC", crv: "P-256", x: "x", y: "y", d: "d" }

const snapshot = (
  threadId: string,
  updatedAt: number,
  executorKind: "runner" | "orb" = "runner",
  workspace?: HostedThreadSnapshot["workspace"],
): HostedThreadSnapshot => {
  const value: HostedThreadSnapshot = {
    executorKind,
    view: {
      thread: {
        id: Thread.ThreadId.make(threadId),
        workspace: "workspace-1",
        title: `Thread ${threadId}`,
        labels: [],
        pinned: false,
        archived: false,
        lineage: { _tag: "Original" },
        createdAt: 1,
        updatedAt,
      },
      revision: updatedAt,
      source: { projectionVersion: ExecutionProjection.projectionVersion },
      turns: [],
      pending: [],
      hasOlder: false,
      hasNewer: false,
      usage: { state: ExecutionProjection.emptyUsageState() },
    },
    pendingAuthorizations: [],
  }
  return workspace === undefined ? value : { ...value, workspace }
}

const waitingSnapshot = (
  executorKind: "runner" | "orb" = "runner",
  workspace?: HostedThreadSnapshot["workspace"],
): HostedThreadSnapshot => {
  const value = snapshot("thread-1", 2, executorKind, workspace)
  return {
    ...value,
    view: {
      ...value.view,
      turns: [
        {
          turn: {
            kind: "agent",
            id: Turn.TurnId.make("turn-1"),
            threadId: Thread.ThreadId.make("thread-1"),
            prompt: "wait",
            status: "waiting",
            author: { _tag: "Human" },
            lineage: { _tag: "Original" },
            createdAt: 1,
            updatedAt: 2,
          },
          units: [],
          projectionRevision: 0,
          usage: ExecutionProjection.emptyUsageState(),
          pendingSteering: [],
          settledSteering: [],
        },
      ],
    },
  }
}

const attached = (message: Message, value: HostedThreadSnapshot, cursor = "0"): Attached => ({
  _tag: "ThreadAttached",
  requestId: message.requestId,
  threadId: message.command._tag === "AttachThread" ? message.command.threadId : HostedThreadId.make("invalid"),
  baseCursor: ThreadEventCursor.make(cursor),
  threadVersion: ThreadVersion.make(cursor),
  cursor: ThreadEventCursor.make(cursor),
  checkpoint: {
    threadVersion: ThreadVersion.make(cursor),
    cursor: ThreadEventCursor.make(cursor),
    snapshot: value,
  },
  events: [],
  participants: [],
})

const event = (threadId: string, cursor: string): ThreadProtocolEvent => ({
  threadId: HostedThreadId.make(threadId),
  sequence: Sequence.make(cursor),
  cursor: ThreadEventCursor.make(cursor),
  threadVersion: ThreadVersion.make(cursor),
  event: { _tag: "ThreadViewSnapshot", snapshot: snapshot(threadId, Number(cursor)).view },
  createdAt: Timestamp.make("2026-08-25T00:00:00.000Z"),
})

export class FakeWebSocket extends EventTarget {
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  readonly URL = "ws://fake"
  readonly protocol = "rika.thread.v1"
  readonly url = "ws://fake"
  readonly extensions = ""
  readonly bufferedAmount = 0
  binaryType: WebSocket["binaryType"] = "arraybuffer"
  readyState: WebSocket["readyState"] = 0
  onopen = null
  onerror = null
  onclose = null
  onmessage = null
  ping: WebSocket["ping"] = () => undefined
  pong: WebSocket["pong"] = () => undefined
  terminate: WebSocket["terminate"] = () => undefined

  constructor(readonly receive: (socket: FakeWebSocket, message: Message) => void) {
    super()
    Effect.runFork(
      Effect.yieldNow.pipe(
        Effect.andThen(
          Effect.sync(() => {
            this.readyState = 1
            this.dispatchEvent(new Event("open"))
          }),
        ),
      ),
    )
  }

  send(value: string | ArrayBufferLike | Blob | ArrayBufferView) {
    this.receive(this, decode(Inspectable.toStringUnknown(value, 0)))
  }

  frame(payload: Frame["payload"]) {
    if (this.readyState === 1)
      this.dispatchEvent(new MessageEvent("message", { data: encode({ protocolVersion, payload }) }))
  }

  invalidFrame() {
    if (this.readyState === 1) this.dispatchEvent(new MessageEvent("message", { data: "not-json" }))
  }

  close(code = 1006, reason = "closed") {
    if (this.readyState >= 2) return
    this.readyState = 3
    this.dispatchEvent(new FakeCloseEvent(code, reason))
  }
}

class FakeCloseEvent extends Event {
  constructor(
    readonly code: number,
    readonly reason: string,
  ) {
    super("close")
  }
}

export interface Harness {
  readonly sockets: Array<FakeWebSocket>
  readonly messages: Array<Message>
  readonly layer: Layer.Layer<Socket.WebSocketConstructor | Http | CredentialStore | ProfileStore | Crypto.Crypto>
}

interface HarnessRef {
  current: Harness | undefined
}

const unusedHttp: HttpInterface = {
  register: () => Effect.die("unused"),
  startDeviceAuthorization: () => Effect.die("unused"),
  pollDeviceAuthorization: () => Effect.die("unused"),
  refresh: () => Effect.die("a valid access token must not be refreshed"),
  context: () => Effect.die("unused"),
  invite: () => Effect.die("unused"),
  devices: () => Effect.die("unused"),
  revokeDevice: () => Effect.die("unused"),
  revokeAllDevices: () => Effect.die("unused"),
  issueThreadTicket: () => Effect.die("unused"),
  listThreads: () => Effect.die("unused"),
  previewThread: () => Effect.die("unused"),
  inspectRecovery: () => Effect.die("unused"),
  resolveRecovery: () => Effect.die("unused"),
  uploadWorkspaceSeed: () => Effect.die("unused"),
  registerRunner: () => Effect.die("unused"),
  setRemoteThreadCreation: () => Effect.die("unused"),
  pollRunner: () => Effect.die("unused"),
  putProviderCredential: () => Effect.die("unused"),
  listProviderCredentials: () => Effect.die("unused"),
  revokeProviderCredential: () => Effect.die("unused"),
  putOpenAiAccount: () => Effect.die("unused"),
  getOpenAiAccount: () => Effect.die("unused"),
  revokeOpenAiAccount: () => Effect.die("unused"),
  createProject: () => Effect.die("unused"),
  putEnvironment: () => Effect.die("unused"),
  revokeEnvironment: () => Effect.die("unused"),
  publishRepository: () => Effect.die("unused"),
}

export const makeHarness = (
  receive: (socket: FakeWebSocket, message: Message, harness: Harness) => void,
  http: Partial<HttpInterface> = {},
): Harness => {
  const sockets: Array<FakeWebSocket> = []
  const messages: Array<Message> = []
  const harnessRef: HarnessRef = { current: undefined }
  const layer = Layer.mergeAll(
    BunCrypto.layer,
    Layer.succeed(Socket.WebSocketConstructor, () => {
      const currentHarness = harnessRef.current
      if (currentHarness === undefined) throw new Error("Harness is not initialized")
      const socket = new FakeWebSocket((current, message) => {
        messages.push(message)
        receive(current, message, currentHarness)
      })
      sockets.push(socket)
      return socket
    }),
    Layer.succeed(
      ProfileStore,
      ProfileStore.of({ load: Effect.succeed(Option.some(profile)), save: () => Effect.void }),
    ),
    Layer.succeed(
      CredentialStore,
      CredentialStore.of({
        load: () =>
          Effect.succeed(
            Option.some({
              refreshToken: Redacted.make("refresh"),
              privateJwk: key,
              accessToken: Redacted.make("access"),
              accessTokenExpiresAt: 2_000_000_000_000,
            }),
          ),
        save: () => Effect.void,
        remove: () => Effect.succeed(true),
        serialized: (effect) => effect,
      }),
    ),
    Layer.succeed(
      Http,
      Http.of({
        ...unusedHttp,
        issueThreadTicket: () =>
          Effect.succeed({
            ticket: "ticket",
            expiresAt: Timestamp.make("2026-08-25T01:00:00.000Z"),
            websocketUrl: "ws://fake",
            protocol: "rika.thread.v1",
          }),
        ...http,
      }),
    ),
  )
  const harness: Harness = {
    sockets,
    messages,
    layer,
  }
  harnessRef.current = harness
  return harness
}

export const eventually = (predicate: () => boolean): Effect.Effect<void> =>
  predicate() ? Effect.void : Effect.yieldNow.pipe(Effect.andThen(Effect.suspend(() => eventually(predicate))))

export const reconnect = (harness: Harness) =>
  Effect.gen(function* () {
    yield* TestClock.adjust("1 second")
    yield* eventually(() => harness.sockets.length === 2)
  })

export const runSession = Effect.fn("test.runSession")(function* (
  harness: Harness,
  onEvent: (event: InteractiveEvent) => void = () => undefined,
  createThread: (executorKind: "runner" | "orb", archiveThreadId?: string) => Effect.Effect<string, HostedError> = () =>
    Effect.die("unused"),
  listThreads: Parameters<typeof makeHostedInteractiveSession>[0]["listThreads"] = Effect.succeed([]),
  previewThread: Parameters<typeof makeHostedInteractiveSession>[0]["previewThread"] = () => Effect.die("unused"),
) {
  const context = yield* Layer.build(harness.layer)
  const hosted = yield* makeHostedInteractiveSession({
    profile,
    threadId: "thread-1",
    createThread,
    listThreads,
    previewThread,
  }).pipe(Effect.provide(context))
  const states: Array<{ target: string; activity?: string; connectivity: string }> = []
  const stateFiber = yield* Stream.runForEach(hosted.connection.stateChanges, (state) =>
    Effect.sync(() => states.push(state)),
  ).pipe(Effect.forkScoped)
  const eventFiber = yield* hosted.session.events(onEvent).pipe(Effect.forkScoped)
  yield* eventually(() => hosted.connection.initialState !== undefined && hosted.session.currentView() !== undefined)
  return {
    ...hosted,
    states,
    stateFiber,
    eventFiber,
  }
})

const defaultReceive = (socket: FakeWebSocket, message: Message) => {
  if (message.command._tag === "AttachThread")
    socket.frame(attached(message, snapshot(String(message.command.threadId), 0)))
}

export const fixtures = { snapshot, waitingSnapshot, attached, event, defaultReceive }
