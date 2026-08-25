import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import {
  ClientMessage,
  ServerFrame,
  type HostedThreadSnapshot,
  type ThreadProtocolEvent,
} from "@rika/product/client-protocol"
import * as ExecutionProjection from "@rika/product/execution-projection"
import {
  CommandId,
  Sequence,
  ThreadEventCursor,
  ThreadId as HostedThreadId,
  ThreadVersion,
  Timestamp,
} from "@rika/product/hosted-model"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import { Crypto, Effect, Fiber, Layer, Option, Redacted, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as Socket from "effect/unstable/socket/Socket"
import {
  CredentialStore,
  Http,
  ProfileStore,
  type HttpInterface,
  type PrivateJwk,
  type Profile,
} from "../../src/hosted/contract"
import { makeHostedInteractiveSession } from "../../src/hosted/interactive-session"

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(ClientMessage))
const encode = Schema.encodeSync(Schema.fromJsonString(ServerFrame))
type Message = ClientMessage
type Frame = ServerFrame
type Attached = Extract<Frame["payload"], { readonly _tag: "ThreadAttached" }>

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
  snapshotThreadVersion: ThreadVersion.make(cursor),
  snapshotCursor: ThreadEventCursor.make(cursor),
  threadVersion: ThreadVersion.make(cursor),
  cursor: ThreadEventCursor.make(cursor),
  snapshot: value,
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

class FakeWebSocket extends EventTarget {
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
    this.receive(this, decode(String(value)))
  }

  frame(payload: Frame["payload"]) {
    if (this.readyState === 1)
      this.dispatchEvent(new MessageEvent("message", { data: encode({ protocolVersion: 1, payload }) }))
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

interface Harness {
  readonly sockets: Array<FakeWebSocket>
  readonly messages: Array<Message>
  readonly layer: Layer.Layer<Socket.WebSocketConstructor | Http | CredentialStore | ProfileStore | Crypto.Crypto>
}

const unusedHttp: HttpInterface = {
  register: () => Effect.die("unused"),
  startDeviceAuthorization: () => Effect.die("unused"),
  pollDeviceAuthorization: () => Effect.die("unused"),
  refresh: () => Effect.succeed({ accessToken: "access", refreshToken: "refresh", expiresIn: 600 }),
  context: () => Effect.die("unused"),
  invite: () => Effect.die("unused"),
  devices: () => Effect.die("unused"),
  revokeDevice: () => Effect.die("unused"),
  revokeAllDevices: () => Effect.die("unused"),
  issueThreadTicket: () => Effect.die("unused"),
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

const makeHarness = (receive: (socket: FakeWebSocket, message: Message, harness: Harness) => void): Harness => {
  const sockets: Array<FakeWebSocket> = []
  const messages: Array<Message> = []
  let harness: Harness | undefined
  const layer = Layer.mergeAll(
    BunCrypto.layer,
    Layer.succeed(Socket.WebSocketConstructor, () => {
      const currentHarness = harness
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
        load: () => Effect.succeed(Option.some({ refreshToken: Redacted.make("refresh"), privateJwk: key })),
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
      }),
    ),
  )
  harness = {
    sockets,
    messages,
    layer,
  }
  return harness
}

const eventually = (predicate: () => boolean): Effect.Effect<void> =>
  predicate() ? Effect.void : Effect.yieldNow.pipe(Effect.andThen(Effect.suspend(() => eventually(predicate))))

const reconnect = (harness: Harness) =>
  Effect.gen(function* () {
    yield* TestClock.adjust("1 second")
    yield* eventually(() => harness.sockets.length === 2)
    expect(harness.sockets).toHaveLength(2)
  })

const runSession = Effect.fn("test.runSession")(function* (
  harness: Harness,
  onEvent: (event: InteractiveEvent) => void = () => undefined,
) {
  const context = yield* Layer.build(harness.layer)
  const hosted = yield* makeHostedInteractiveSession({
    profile,
    threadId: "thread-1",
    createThread: () => Effect.die("unused"),
    setRemoteThreadCreation: () => Effect.void,
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

it.effect("does not poll AttachThread while an idle WebSocket remains connected", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = makeHarness(defaultReceive)
      const hosted = yield* runSession(harness)
      expect(harness.messages.filter((message) => message.command._tag === "AttachThread")).toHaveLength(1)
      for (let advance = 0; advance < 4; advance += 1) yield* TestClock.adjust("500 millis")
      expect(harness.messages.filter((message) => message.command._tag === "AttachThread")).toHaveLength(1)
      yield* hosted.session.quit
    }),
  ),
)

it.effect("applies and acknowledges one unsolicited contiguous ThreadEvent exactly once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const received: Array<string> = []
      const harness = makeHarness(defaultReceive)
      const hosted = yield* runSession(harness, (value) => received.push(value._tag))
      const update = event("thread-1", "1")
      harness.sockets[0]!.frame({ _tag: "ThreadEvent", event: update })
      yield* eventually(() => hosted.session.currentView()?.thread.updatedAt === 1)
      harness.sockets[0]!.frame({ _tag: "ThreadEvent", event: update })
      yield* eventually(() => harness.messages.some((message) => message.command._tag === "AcknowledgeCursor"))
      expect(received.filter((tag) => tag === "ThreadViewSnapshot")).toHaveLength(2)
      expect(hosted.session.currentView()?.thread.updatedAt).toBe(1)
      expect(
        harness.messages.filter(
          (message) => message.command._tag === "AcknowledgeCursor" && String(message.command.cursor) === "1",
        ),
      ).toHaveLength(1)
      yield* hosted.session.quit
    }),
  ),
)

it.effect("reconnects after the delivered cursor without duplicating the projection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const received: Array<string> = []
      const harness = makeHarness((socket, message, state) => {
        if (message.command._tag === "SubmitPrompt") {
          const submissions = state.messages.filter((candidate) => candidate.command._tag === "SubmitPrompt")
          if (submissions.length === 1) socket.close()
          else
            socket.frame({
              _tag: "CommandAccepted",
              requestId: message.requestId,
              commandId: message.command.commandId,
              threadId: message.command.threadId,
              threadVersion: ThreadVersion.make("1"),
              cursor: ThreadEventCursor.make("1"),
              result: { _tag: "Applied" },
            })
          return
        }
        if (message.command._tag !== "AttachThread") return
        const cursor = String(message.command.afterCursor)
        socket.frame(attached(message, snapshot("thread-1", Number(cursor)), cursor))
        if (state.sockets.length === 1) socket.frame({ _tag: "ThreadEvent", event: event("thread-1", "1") })
      })
      const hosted = yield* runSession(harness, (value) => received.push(value._tag))
      yield* eventually(() => hosted.session.currentView()?.thread.updatedAt === 1)
      const submitted = yield* hosted.session
        .submit("disconnect", undefined, undefined, undefined, "disconnect")
        .pipe(Effect.forkScoped)
      yield* eventually(() => hosted.states.at(-1)?.connectivity === "reconnecting")
      yield* reconnect(harness)
      yield* Fiber.join(submitted)
      yield* eventually(
        () => harness.messages.filter((message) => message.command._tag === "AttachThread").length === 2,
      )
      const attaches = harness.messages.filter((message) => message.command._tag === "AttachThread")
      expect(
        attaches.map((message) => message.command._tag === "AttachThread" && String(message.command.afterCursor)),
      ).toEqual(["0", "1"])
      expect(received.filter((tag) => tag === "ThreadViewSnapshot")).toHaveLength(2)
      yield* hosted.session.quit
    }),
  ),
)

it.effect("retains the newer Thread when a superseded selection receives late frames", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = makeHarness((socket, message) => {
        if (message.command._tag !== "AttachThread") return
        const threadId = String(message.command.threadId)
        socket.frame(
          attached(
            message,
            snapshot(threadId, threadId === "thread-new" ? 2 : 0),
            threadId === "thread-new" ? "2" : "0",
          ),
        )
      })
      const hosted = yield* runSession(harness)
      yield* hosted.session.selectThread("thread-old")
      yield* hosted.session.selectThread("thread-new")
      harness.sockets.at(-1)!.frame({
        _tag: "ThreadSnapshot",
        threadId: HostedThreadId.make("thread-old"),
        threadVersion: ThreadVersion.make("9"),
        cursor: ThreadEventCursor.make("9"),
        snapshot: snapshot("thread-old", 9),
      })
      harness.sockets.at(-1)!.frame({ _tag: "ThreadEvent", event: event("thread-old", "9") })
      yield* Effect.yieldNow
      expect(String(hosted.session.currentView()?.thread.id)).toBe("thread-new")
      expect(hosted.session.currentView()?.thread.updatedAt).toBe(2)
      yield* hosted.session.quit
    }),
  ),
)

it.effect("maps Runner waiting snapshots to executor-waiting with or without migration workspace data", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let attachCount = 0
      const harness = makeHarness((socket, message) => {
        if (message.command._tag !== "AttachThread") return
        attachCount += 1
        const workspace = attachCount === 1 ? undefined : ({ _tag: "RunnerWorkspace", state: "ready" } as const)
        socket.frame(attached(message, waitingSnapshot("runner", workspace), String(attachCount)))
      })
      const hosted = yield* runSession(harness)
      expect(hosted.states.at(-1)?.activity).toBe("executor-waiting")
      yield* hosted.session.reopenThread
      expect(hosted.states.at(-1)?.activity).toBe("executor-waiting")
      yield* hosted.session.quit
    }),
  ),
)

it.effect("consumes typed OrbWorkspace preparing and failed snapshots without legacy status frames", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let attachCount = 0
      const harness = makeHarness((socket, message) => {
        if (message.command._tag !== "AttachThread") return
        attachCount += 1
        const state = attachCount === 1 ? "preparing" : "failed"
        const workspace: HostedThreadSnapshot["workspace"] =
          state === "failed"
            ? { _tag: "OrbWorkspace", state, generation: "generation-1", message: "checkout failed" }
            : { _tag: "OrbWorkspace", state, generation: "generation-1" }
        socket.frame(attached(message, waitingSnapshot("orb", workspace), String(attachCount)))
      })
      const hosted = yield* runSession(harness)
      expect(hosted.states.at(-1)?.activity).toBe("workspace-preparing")
      yield* hosted.session.reopenThread
      expect(hosted.states.at(-1)?.activity).toBe("workspace-failed")
      yield* hosted.session.quit
    }),
  ),
)

it.effect("resends the exact admitted mutation until its authoritative outcome is known", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let version = 0
      const harness = makeHarness((socket, message) => {
        if (message.command._tag === "AttachThread") {
          socket.frame(attached(message, snapshot("thread-1", version), String(version)))
          return
        }
        if (message.command._tag !== "SubmitPrompt") return
        const submissions = harness.messages.filter((candidate) => candidate.command._tag === "SubmitPrompt")
        if (submissions.length === 1) {
          version = 1
          socket.close()
          return
        }
        socket.frame({
          _tag: "CommandAccepted",
          requestId: message.requestId,
          commandId: message.command.commandId,
          threadId: message.command.threadId,
          threadVersion: ThreadVersion.make(String(version)),
          cursor: ThreadEventCursor.make(String(version)),
          result: { _tag: "Applied" },
        })
      })
      const hosted = yield* runSession(harness)
      const submitted = yield* hosted.session
        .submit("first", undefined, [], undefined, "submission-1")
        .pipe(Effect.forkScoped)
      yield* eventually(() => hosted.states.at(-1)?.connectivity === "reconnecting")
      yield* reconnect(harness)
      yield* Fiber.join(submitted)
      const commands = harness.messages.filter((message) => message.command._tag === "SubmitPrompt")
      expect(commands).toHaveLength(2)
      expect(commands[0]!.command).toEqual(commands[1]!.command)
      expect(commands[0]!.requestId).not.toBe(commands[1]!.requestId)
      expect(commands[0]!.command).not.toHaveProperty("attachments")
      expect(version).toBe(1)
      yield* hosted.session.quit
    }),
  ),
)

it.effect("retries the exact mutation when the server reports a transient application failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = makeHarness((socket, message) => {
        if (message.command._tag === "AttachThread") {
          socket.frame(attached(message, snapshot("thread-1", 0)))
          return
        }
        if (message.command._tag !== "SubmitPrompt") return
        const submissions = harness.messages.filter((candidate) => candidate.command._tag === "SubmitPrompt")
        socket.frame(
          submissions.length === 1
            ? {
                _tag: "CommandRejected",
                requestId: message.requestId,
                commandId: message.command.commandId,
                threadId: message.command.threadId,
                reason: "unavailable",
                currentThreadVersion: ThreadVersion.make("1"),
                currentCursor: ThreadEventCursor.make("0"),
                message: "application interrupted",
                details: {},
              }
            : {
                _tag: "CommandAccepted",
                requestId: message.requestId,
                commandId: message.command.commandId,
                threadId: message.command.threadId,
                threadVersion: ThreadVersion.make("1"),
                cursor: ThreadEventCursor.make("0"),
                result: { _tag: "PromptAdmitted", status: "queued" },
              },
        )
      })
      const hosted = yield* runSession(harness)
      const submitted = yield* hosted.session
        .submit("retry transient", undefined, [], undefined, "submission-transient")
        .pipe(Effect.forkScoped)
      yield* eventually(() => hosted.states.at(-1)?.activity === "unknown-operation")
      yield* TestClock.adjust("250 millis")
      yield* Fiber.join(submitted)
      const commands = harness.messages.filter((message) => message.command._tag === "SubmitPrompt")
      expect(commands).toHaveLength(2)
      expect(commands[0]!.command).toEqual(commands[1]!.command)
      expect(commands[0]!.requestId).not.toBe(commands[1]!.requestId)
      yield* hosted.session.quit
    }),
  ),
)

it.effect("targets the pending submission identity when cancellation happens before a Turn exists", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let pendingSubmit: Message | undefined
      const harness = makeHarness((socket, message) => {
        if (message.command._tag === "AttachThread") {
          socket.frame(attached(message, snapshot("thread-1", 0)))
          return
        }
        if (message.command._tag === "SubmitPrompt") {
          pendingSubmit = message
          socket.frame({
            _tag: "CommandAdmitted",
            requestId: message.requestId,
            commandId: message.command.commandId,
            threadId: message.command.threadId,
            threadVersion: ThreadVersion.make("1"),
          })
          return
        }
        if (message.command._tag === "Cancel")
          socket.frame({
            _tag: "CommandAccepted",
            requestId: message.requestId,
            commandId: message.command.commandId,
            threadId: message.command.threadId,
            threadVersion: ThreadVersion.make("1"),
            cursor: ThreadEventCursor.make("0"),
            result: { _tag: "Applied" },
          })
      })
      const hosted = yield* runSession(harness)
      const submitted = yield* hosted.session
        .submit("cancel before admission", undefined, [], undefined, "submission-before-turn")
        .pipe(Effect.forkScoped)
      yield* eventually(() => pendingSubmit !== undefined)
      const cancellationFiber = yield* hosted.session
        .cancel({ submissionId: "submission-before-turn", threadId: "thread-1" })
        .pipe(Effect.forkScoped)
      yield* Fiber.join(cancellationFiber)
      const cancellation = harness.messages.find((message) => message.command._tag === "Cancel")
      if (pendingSubmit === undefined || pendingSubmit.command._tag !== "SubmitPrompt")
        return yield* Effect.die("Submission was not captured")
      const durableSubmitCommandId = pendingSubmit.command.commandId
      expect(pendingSubmit.command).toMatchObject({
        _tag: "SubmitPrompt",
        submissionId: "submission-before-turn",
      })
      expect(durableSubmitCommandId).not.toBe("submission-before-turn")
      expect(cancellation?.command).toMatchObject({
        _tag: "Cancel",
        target: { _tag: "Command", commandId: durableSubmitCommandId },
      })
      yield* Fiber.join(submitted)
      yield* hosted.session.quit
    }),
  ),
)

it.effect("forgets submission cancellation rendezvous after admission or rejection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let version = 0
      const harness = makeHarness((socket, message) => {
        if (message.command._tag === "AttachThread") {
          socket.frame(attached(message, snapshot("thread-1", 0)))
          return
        }
        if (message.command._tag !== "SubmitPrompt") return
        version += 1
        socket.frame({
          _tag: "CommandAdmitted",
          requestId: message.requestId,
          commandId: message.command.commandId,
          threadId: message.command.threadId,
          threadVersion: ThreadVersion.make(String(version)),
        })
      })
      const hosted = yield* runSession(harness)
      yield* hosted.session.submit("admitted", undefined, [], undefined, "submission-admitted")
      harness.sockets[0]!.frame({
        _tag: "ThreadEvent",
        event: {
          threadId: HostedThreadId.make("thread-1"),
          sequence: Sequence.make("1"),
          cursor: ThreadEventCursor.make("1"),
          threadVersion: ThreadVersion.make("1"),
          event: {
            _tag: "SubmissionAdmitted",
            threadId: Thread.ThreadId.make("thread-1"),
            turnId: Turn.TurnId.make("turn-1"),
            status: "active",
            submissionId: "submission-admitted",
          },
          createdAt: Timestamp.make("2026-08-25T00:00:00.000Z"),
        },
      })
      yield* eventually(() =>
        harness.messages.some(
          (message) => message.command._tag === "AcknowledgeCursor" && String(message.command.cursor) === "1",
        ),
      )
      expect(
        yield* Effect.result(hosted.session.cancel({ submissionId: "submission-admitted", threadId: "thread-1" })),
      ).toMatchObject({ _tag: "Failure" })

      yield* hosted.session.submit("rejected", undefined, [], undefined, "submission-rejected")
      harness.sockets[0]!.frame({
        _tag: "ThreadEvent",
        event: {
          threadId: HostedThreadId.make("thread-1"),
          sequence: Sequence.make("2"),
          cursor: ThreadEventCursor.make("2"),
          threadVersion: ThreadVersion.make("2"),
          event: {
            _tag: "SubmissionRejected",
            message: "rejected",
            submissionId: "submission-rejected",
          },
          createdAt: Timestamp.make("2026-08-25T00:00:00.000Z"),
        },
      })
      yield* eventually(() =>
        harness.messages.some(
          (message) => message.command._tag === "AcknowledgeCursor" && String(message.command.cursor) === "2",
        ),
      )
      expect(
        yield* Effect.result(hosted.session.cancel({ submissionId: "submission-rejected", threadId: "thread-1" })),
      ).toMatchObject({ _tag: "Failure" })
      expect(harness.messages.filter((message) => message.command._tag === "Cancel")).toHaveLength(0)
      yield* hosted.session.quit
    }),
  ),
)

it.effect("forgets submission cancellation rendezvous after a definitive command rejection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = makeHarness((socket, message) => {
        if (message.command._tag === "AttachThread") {
          socket.frame(attached(message, snapshot("thread-1", 0)))
          return
        }
        if (message.command._tag !== "SubmitPrompt") return
        socket.frame({
          _tag: "CommandRejected",
          requestId: message.requestId,
          commandId: message.command.commandId,
          threadId: message.command.threadId,
          reason: "forbidden",
          currentCursor: ThreadEventCursor.make("0"),
          message: "Submission rejected",
          details: {},
        })
      })
      const hosted = yield* runSession(harness)
      expect(
        yield* Effect.result(
          hosted.session.submit("rejected", undefined, [], undefined, "submission-command-rejected"),
        ),
      ).toMatchObject({ _tag: "Failure" })
      expect(
        yield* Effect.result(
          hosted.session.cancel({ submissionId: "submission-command-rejected", threadId: "thread-1" }),
        ),
      ).toMatchObject({ _tag: "Failure" })
      expect(harness.messages.filter((message) => message.command._tag === "Cancel")).toHaveLength(0)
      yield* hosted.session.quit
    }),
  ),
)

it.effect("retires a definitive rejection before cancellation can observe its command", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = makeHarness((socket, message) => {
        if (message.command._tag === "AttachThread") {
          socket.frame(attached(message, snapshot("thread-1", 0)))
          return
        }
        if (message.command._tag !== "SubmitPrompt") return
        socket.frame({
          _tag: "CommandRejected",
          requestId: message.requestId,
          commandId: message.command.commandId,
          threadId: message.command.threadId,
          reason: "forbidden",
          currentCursor: ThreadEventCursor.make("0"),
          message: "Submission rejected",
          details: {},
        })
      })
      const hosted = yield* runSession(harness)
      const submitted = yield* hosted.session
        .submit("rejected", undefined, [], undefined, "submission-rejection-race")
        .pipe(Effect.result, Effect.forkScoped)
      yield* eventually(() => harness.messages.some((message) => message.command._tag === "SubmitPrompt"))
      yield* Effect.yieldNow
      expect(
        yield* Effect.result(
          hosted.session.cancel({ submissionId: "submission-rejection-race", threadId: "thread-1" }),
        ),
      ).toMatchObject({ _tag: "Failure" })
      expect((yield* Fiber.join(submitted))._tag).toBe("Failure")
      expect(harness.messages.filter((message) => message.command._tag === "Cancel")).toHaveLength(0)
      yield* hosted.session.quit
    }),
  ),
)

it.effect("releases a submission identity interrupted before any connection can send it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = makeHarness((socket, message) => {
        if (message.command._tag === "AttachThread") {
          socket.frame(attached(message, snapshot("thread-1", 0)))
          return
        }
        if (message.command._tag !== "SubmitPrompt") return
        socket.frame({
          _tag: "CommandAdmitted",
          requestId: message.requestId,
          commandId: message.command.commandId,
          threadId: message.command.threadId,
          threadVersion: ThreadVersion.make("1"),
        })
      })
      const hosted = yield* runSession(harness)
      harness.sockets[0]!.close()
      yield* eventually(() => hosted.states.at(-1)?.connectivity === "reconnecting")
      const abandoned = yield* hosted.session
        .submit("abandoned", undefined, [], undefined, "submission-before-send")
        .pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(abandoned)
      expect(
        yield* Effect.result(hosted.session.cancel({ submissionId: "submission-before-send", threadId: "thread-1" })),
      ).toMatchObject({ _tag: "Failure" })
      yield* reconnect(harness)
      yield* hosted.session.submit("retry", undefined, [], undefined, "submission-before-send")
      expect(harness.messages.filter((message) => message.command._tag === "SubmitPrompt")).toHaveLength(1)
      yield* hosted.session.quit
    }),
  ),
)

it.effect("rejects a duplicate in-flight submission identity without sending another command", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let pending: Message | undefined
      const harness = makeHarness((socket, message) => {
        if (message.command._tag === "AttachThread") {
          socket.frame(attached(message, snapshot("thread-1", 0)))
          return
        }
        if (message.command._tag === "SubmitPrompt") pending = message
      })
      const hosted = yield* runSession(harness)
      const first = yield* hosted.session
        .submit("first", undefined, [], undefined, "submission-duplicate")
        .pipe(Effect.forkScoped)
      yield* eventually(() => pending !== undefined)
      expect(
        yield* Effect.result(hosted.session.submit("duplicate", undefined, [], undefined, "submission-duplicate")),
      ).toMatchObject({ _tag: "Failure" })
      expect(harness.messages.filter((message) => message.command._tag === "SubmitPrompt")).toHaveLength(1)
      if (pending === undefined || pending.command._tag !== "SubmitPrompt")
        return yield* Effect.die("Submission was not captured")
      harness.sockets[0]!.frame({
        _tag: "CommandAdmitted",
        requestId: pending.requestId,
        commandId: pending.command.commandId,
        threadId: pending.command.threadId,
        threadVersion: ThreadVersion.make("1"),
      })
      yield* Fiber.join(first)
      yield* hosted.session.quit
    }),
  ),
)

it.effect("keeps pending submission cancellation across an unrelated newer reattachment snapshot", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let threadOneAttachments = 0
      const harness = makeHarness((socket, message) => {
        if (message.command._tag === "AttachThread") {
          const threadId = String(message.command.threadId)
          if (threadId === "thread-1") threadOneAttachments += 1
          socket.frame(
            attached(
              message,
              snapshot(threadId, threadId === "thread-1" && threadOneAttachments === 2 ? 1 : 0),
              threadId === "thread-1" && threadOneAttachments === 2 ? "1" : "0",
            ),
          )
          return
        }
        if (message.command._tag === "SubmitPrompt")
          socket.frame({
            _tag: "CommandAdmitted",
            requestId: message.requestId,
            commandId: message.command.commandId,
            threadId: message.command.threadId,
            threadVersion: ThreadVersion.make("1"),
          })
        if (message.command._tag === "Cancel")
          socket.frame({
            _tag: "CommandAdmitted",
            requestId: message.requestId,
            commandId: message.command.commandId,
            threadId: message.command.threadId,
            threadVersion: ThreadVersion.make("2"),
          })
      })
      const hosted = yield* runSession(harness)
      yield* hosted.session.submit("pending", undefined, [], undefined, "submission-compacted")
      yield* hosted.session.selectThread("thread-2")
      yield* hosted.session.selectThread("thread-1")
      yield* hosted.session.cancel({ submissionId: "submission-compacted", threadId: "thread-1" })
      expect(harness.messages.filter((message) => message.command._tag === "Cancel")).toHaveLength(1)
      yield* hosted.session.quit
    }),
  ),
)

it.effect("keeps pending cancellation when a reconnect attachment is rejected as stale", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let attachments = 0
      const harness = makeHarness((socket, message) => {
        if (message.command._tag === "AttachThread") {
          attachments += 1
          if (attachments === 1) {
            socket.frame(attached(message, snapshot("thread-1", 0)))
            return
          }
          if (attachments === 2) {
            socket.frame({
              ...attached(message, snapshot("thread-1", 0), "1"),
              snapshotThreadVersion: ThreadVersion.make("0"),
              snapshotCursor: ThreadEventCursor.make("0"),
              events: [
                {
                  threadId: HostedThreadId.make("thread-1"),
                  sequence: Sequence.make("1"),
                  cursor: ThreadEventCursor.make("1"),
                  threadVersion: ThreadVersion.make("1"),
                  event: {
                    _tag: "SubmissionAdmitted",
                    threadId: Thread.ThreadId.make("thread-1"),
                    turnId: Turn.TurnId.make("turn-stale"),
                    status: "active",
                    submissionId: "submission-stale-attachment",
                  },
                  createdAt: Timestamp.make("2026-08-25T00:00:00.000Z"),
                },
              ],
            })
            return
          }
          socket.frame(attached(message, snapshot("thread-1", 2), "2"))
          return
        }
        if (message.command._tag === "SubmitPrompt")
          socket.frame({
            _tag: "CommandAdmitted",
            requestId: message.requestId,
            commandId: message.command.commandId,
            threadId: message.command.threadId,
            threadVersion: ThreadVersion.make("1"),
          })
        if (message.command._tag === "Cancel")
          socket.frame({
            _tag: "CommandAdmitted",
            requestId: message.requestId,
            commandId: message.command.commandId,
            threadId: message.command.threadId,
            threadVersion: ThreadVersion.make("3"),
          })
      })
      const hosted = yield* runSession(harness)
      yield* hosted.session.submit("pending", undefined, [], undefined, "submission-stale-attachment")
      harness.sockets[0]!.frame({ _tag: "ThreadEvent", event: event("thread-1", "1") })
      harness.sockets[0]!.frame({ _tag: "ThreadEvent", event: event("thread-1", "2") })
      yield* eventually(() => hosted.session.currentView()?.thread.updatedAt === 2)
      harness.sockets[0]!.close()
      yield* eventually(() => hosted.states.at(-1)?.connectivity === "reconnecting")
      yield* reconnect(harness)
      yield* eventually(() => hosted.states.at(-1)?.connectivity === "reconnecting")
      yield* TestClock.adjust("1 second")
      yield* eventually(() => harness.sockets.length === 3)
      yield* hosted.session.cancel({ submissionId: "submission-stale-attachment", threadId: "thread-1" })
      expect(harness.messages.filter((message) => message.command._tag === "Cancel")).toHaveLength(1)
      yield* hosted.session.quit
    }),
  ),
)

it.effect("keeps pending submission cancellation scoped to its Thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let pendingSubmit: Message | undefined
      const harness = makeHarness((socket, message) => {
        if (message.command._tag === "AttachThread") {
          socket.frame(attached(message, snapshot(String(message.command.threadId), 0)))
          return
        }
        if (message.command._tag === "SubmitPrompt") {
          pendingSubmit = message
          socket.frame({
            _tag: "CommandAdmitted",
            requestId: message.requestId,
            commandId: message.command.commandId,
            threadId: message.command.threadId,
            threadVersion: ThreadVersion.make("1"),
          })
          return
        }
        if (message.command._tag === "Cancel")
          socket.frame({
            _tag: "CommandAdmitted",
            requestId: message.requestId,
            commandId: message.command.commandId,
            threadId: message.command.threadId,
            threadVersion: ThreadVersion.make("2"),
          })
      })
      const hosted = yield* runSession(harness)
      yield* hosted.session.submit("pending on first Thread", undefined, [], undefined, "submission-first")
      yield* hosted.session.selectThread("thread-2")
      expect(
        yield* Effect.result(hosted.session.cancel({ submissionId: "submission-first", threadId: "thread-1" })),
      ).toMatchObject({ _tag: "Failure" })
      expect(harness.messages.filter((message) => message.command._tag === "Cancel")).toHaveLength(0)

      yield* hosted.session.selectThread("thread-1")
      yield* hosted.session.cancel({ submissionId: "submission-first", threadId: "thread-1" })
      const cancellation = harness.messages.find((message) => message.command._tag === "Cancel")
      if (pendingSubmit === undefined || pendingSubmit.command._tag !== "SubmitPrompt")
        return yield* Effect.die("Submission was not captured")
      expect(cancellation?.command).toMatchObject({
        _tag: "Cancel",
        threadId: "thread-1",
        target: { _tag: "Command", commandId: pendingSubmit.command.commandId },
      })
      yield* hosted.session.quit
    }),
  ),
)

it.effect("rejects a mutation response with another durable command identity", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = makeHarness((socket, message) => {
        if (message.command._tag === "AttachThread") {
          socket.frame(attached(message, snapshot("thread-1", 0)))
          return
        }
        if (message.command._tag === "SubmitPrompt")
          socket.frame({
            _tag: "CommandAdmitted",
            requestId: message.requestId,
            commandId: CommandId.make("another-command"),
            threadId: message.command.threadId,
            threadVersion: ThreadVersion.make("1"),
          })
      })
      const hosted = yield* runSession(harness)
      const result = yield* Effect.result(
        hosted.session.submit("wrong response", undefined, [], undefined, "submission-wrong-response"),
      )
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { message: expect.stringContaining("response command identity") },
      })
      yield* hosted.session.quit
    }),
  ),
)

it.effect("keeps UI submission identity separate from durable command identity across reopened sessions", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const durableIds: Array<string> = []
      const run = Effect.fn("HostedInteractiveSessionTest.reopen")(function* () {
        const harness = makeHarness((socket, message) => {
          if (message.command._tag === "AttachThread") {
            socket.frame(attached(message, snapshot("thread-1", 0)))
            return
          }
          if (message.command._tag !== "SubmitPrompt") return
          durableIds.push(message.command.commandId)
          expect(message.command.submissionId).toBe("submission-1")
          socket.frame({
            _tag: "CommandAdmitted",
            requestId: message.requestId,
            commandId: message.command.commandId,
            threadId: message.command.threadId,
            threadVersion: ThreadVersion.make("1"),
          })
        })
        const hosted = yield* runSession(harness)
        yield* hosted.session.submit("reopened", undefined, [], undefined, "submission-1")
        yield* hosted.session.quit
      })
      yield* run()
      yield* run()
      expect(durableIds).toHaveLength(2)
      expect(durableIds[0]).not.toBe(durableIds[1])
      expect(durableIds.every((id) => id.startsWith("submit:"))).toBe(true)
    }),
  ),
)

it.effect("ignores stale full snapshots and accepts a newer materialization at the same cursor", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = makeHarness(defaultReceive)
      const hosted = yield* runSession(harness)
      const socket = harness.sockets[0]!
      socket.frame({
        _tag: "ThreadSnapshot",
        threadId: HostedThreadId.make("thread-1"),
        threadVersion: ThreadVersion.make("2"),
        cursor: ThreadEventCursor.make("2"),
        snapshot: snapshot("thread-1", 2),
      })
      yield* eventually(() => hosted.session.currentView()?.thread.updatedAt === 2)
      socket.frame({
        _tag: "ThreadSnapshot",
        threadId: HostedThreadId.make("thread-1"),
        threadVersion: ThreadVersion.make("3"),
        cursor: ThreadEventCursor.make("1"),
        snapshot: snapshot("thread-1", 9),
      })
      yield* Effect.yieldNow
      expect(hosted.session.currentView()?.thread.updatedAt).toBe(2)
      socket.frame({
        _tag: "ThreadSnapshot",
        threadId: HostedThreadId.make("thread-1"),
        threadVersion: ThreadVersion.make("3"),
        cursor: ThreadEventCursor.make("2"),
        snapshot: snapshot("thread-1", 3),
      })
      yield* eventually(() => hosted.session.currentView()?.thread.updatedAt === 3)
      yield* hosted.session.quit
    }),
  ),
)

it.effect("rejects a full snapshot whose Thread version regresses", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = makeHarness(defaultReceive)
      const hosted = yield* runSession(harness)
      const socket = harness.sockets[0]!
      socket.frame({
        _tag: "ThreadSnapshot",
        threadId: HostedThreadId.make("thread-1"),
        threadVersion: ThreadVersion.make("2"),
        cursor: ThreadEventCursor.make("2"),
        snapshot: snapshot("thread-1", 2),
      })
      yield* eventually(() => hosted.session.currentView()?.thread.updatedAt === 2)
      socket.frame({
        _tag: "ThreadSnapshot",
        threadId: HostedThreadId.make("thread-1"),
        threadVersion: ThreadVersion.make("1"),
        cursor: ThreadEventCursor.make("3"),
        snapshot: snapshot("thread-1", 3),
      })
      yield* TestClock.adjust("250 millis")
      yield* eventually(() => hosted.states.at(-1)?.connectivity === "reconnecting")
      expect(hosted.session.currentView()?.thread.updatedAt).toBe(2)
      yield* hosted.session.quit
    }),
  ),
)
