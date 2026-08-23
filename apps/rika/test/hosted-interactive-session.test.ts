import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunSocket from "@effect/platform-bun/BunSocket"
import { expect, it } from "@effect/vitest"
import {
  ClientMessage,
  ServerFrame,
  type HostedThreadSnapshot,
  type ThreadProtocolEvent,
} from "@rika/product/client-protocol"
import { Deferred, Effect, Fiber, Layer, Option, Redacted, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import {
  CredentialStore,
  Http,
  ProfileStore,
  type HttpInterface,
  type PrivateJwk,
  type Profile,
} from "../src/hosted/hosted-contract"
import { makeHostedInteractiveSession } from "../src/hosted/hosted-interactive-session"

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(ClientMessage))
const encode = Schema.encodeSync(Schema.fromJsonString(ServerFrame))
const key: PrivateJwk = { kty: "EC", crv: "P-256", x: "x", y: "y", d: "d" }
const profile: Profile = {
  origin: "https://hosted.example.test",
  deviceId: "device-1",
  clientId: "client-1",
  owner: { kind: "personal" },
}
const snapshot = (updatedAt = 1): HostedThreadSnapshot => ({
  thread: {
    id: "thread-1" as never,
    workspace: "workspace-1",
    title: "Thread",
    labels: [],
    pinned: false,
    archived: false,
    lineage: { _tag: "Original" },
    createdAt: 1,
    updatedAt,
  },
  turns: [],
  units: [],
  queue: { revision: 0, turns: [] },
  pendingAuthorizations: [],
})

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
  createProject: () => Effect.die("unused"),
  putEnvironment: () => Effect.die("unused"),
  revokeEnvironment: () => Effect.die("unused"),
  publishRepository: () => Effect.die("unused"),
}

it.effect("replays without gaps across reconnect and attaches a second controller without duplicate events", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const firstEvent = yield* Deferred.make<void>()
      const firstClosed = yield* Deferred.make<void>()
      const reattached = yield* Deferred.make<void>()
      const secondAttached = yield* Deferred.make<void>()
      const secondSnapshot = yield* Deferred.make<void>()
      const setupStatus = yield* Deferred.make<void>()
      const sockets = new WeakMap<object, number>()
      const commands: Array<ClientMessage["command"]> = []
      const afterCursors: Array<string> = []
      let opened = 0
      let version = "1"
      let cursor = "1"
      const threadEvent: ThreadProtocolEvent = {
        threadId: "thread-1" as never,
        sequence: "1" as never,
        cursor: "1" as never,
        threadVersion: "1" as never,
        event: { _tag: "ExecutionControlled", action: "cancelled" },
        createdAt: "2026-08-21T00:00:00.000Z" as never,
      }
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: (request, upgradeServer) =>
              upgradeServer.upgrade(request, { headers: { "sec-websocket-protocol": "rika.thread.v1" } })
                ? undefined
                : new Response("upgrade failed", { status: 500 }),
            websocket: {
              open: (socket) => {
                opened += 1
                sockets.set(socket, opened)
              },
              close: (socket) => {
                if (sockets.get(socket) === 1) Deferred.doneUnsafe(firstClosed, Effect.void)
              },
              message: (socket, value) => {
                const message = decode(String(value))
                commands.push(message.command)
                if (message.command._tag === "AttachThread") {
                  afterCursors.push(String(message.command.afterCursor))
                  const connection = sockets.get(socket)
                  socket.send(
                    encode({
                      protocolVersion: 1,
                      payload: {
                        _tag: "ThreadSnapshot",
                        requestId: message.requestId,
                        threadId: message.command.threadId,
                        threadVersion: version as never,
                        cursor: (connection === 1 ? "0" : cursor) as never,
                        snapshot: snapshot(Number(version)),
                      },
                    }),
                  )
                  if (connection === 1) {
                    socket.send(encode({ protocolVersion: 1, payload: { _tag: "ThreadEvent", event: threadEvent } }))
                    socket.send(encode({ protocolVersion: 1, payload: { _tag: "ThreadEvent", event: threadEvent } }))
                    socket.send(
                      encode({
                        protocolVersion: 1,
                        payload: {
                          _tag: "ExecutorStatus",
                          threadId: "thread-1" as never,
                          status: { state: "waiting" },
                        },
                      }),
                    )
                    socket.send(
                      encode({
                        protocolVersion: 1,
                        payload: {
                          _tag: "WorkspaceStatus",
                          threadId: "thread-1" as never,
                          status: { state: "setup" },
                        },
                      }),
                    )
                  } else if (connection === 2) Deferred.doneUnsafe(reattached, Effect.void)
                  else Deferred.doneUnsafe(secondAttached, Effect.void)
                  return
                }
                if (message.command._tag === "AcknowledgeCursor") {
                  socket.send(
                    encode({
                      protocolVersion: 1,
                      payload: {
                        _tag: "CommandAccepted",
                        requestId: message.requestId,
                        threadId: "thread-1" as never,
                        threadVersion: version as never,
                        cursor: cursor as never,
                        result: { _tag: "Applied" },
                      },
                    }),
                  )
                  if (sockets.get(socket) === 1 && message.command.cursor === "1") socket.close()
                  return
                }
                if (message.command._tag === "SubmitPrompt") {
                  version = "2"
                  socket.send(
                    encode({
                      protocolVersion: 1,
                      payload: {
                        _tag: "CommandAccepted",
                        requestId: message.requestId,
                        commandId: message.command.commandId,
                        threadId: "thread-1" as never,
                        threadVersion: "2" as never,
                        cursor: cursor as never,
                        result: { _tag: "Applied" },
                      },
                    }),
                  )
                  socket.send(
                    encode({
                      protocolVersion: 1,
                      payload: {
                        _tag: "ThreadSnapshot",
                        threadId: "thread-1" as never,
                        threadVersion: "2" as never,
                        cursor: cursor as never,
                        snapshot: snapshot(2),
                      },
                    }),
                  )
                  socket.send(
                    encode({
                      protocolVersion: 1,
                      payload: {
                        _tag: "ThreadSnapshot",
                        threadId: "thread-1" as never,
                        threadVersion: "2" as never,
                        cursor: cursor as never,
                        snapshot: snapshot(3),
                      },
                    }),
                  )
                }
              },
            },
          }),
        ),
        (runningServer) =>
          Effect.sync(() => {
            runningServer.stop(true)
          }),
      )
      const layer = Layer.mergeAll(
        BunCrypto.layer,
        BunSocket.layerWebSocketConstructor,
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
                ticket: `ticket-${opened + 1}`,
                expiresAt: "2026-08-21T01:00:00.000Z" as never,
                websocketUrl: `ws://127.0.0.1:${server.port}`,
                protocol: "rika.thread.v1",
              }),
          }),
        ),
      )
      const context = yield* Layer.build(layer)
      const first = yield* makeHostedInteractiveSession({
        threadId: "thread-1",
        executorKind: "runner",
        createThread: () => Effect.succeed("thread-2"),
        setRemoteThreadCreation: () => Effect.void,
      }).pipe(Effect.provide(context))
      const firstEvents: Array<string> = []
      const firstSnapshotUpdates: Array<number> = []
      const statuses: Array<string> = []
      yield* first.session.selectThread("thread-1")
      yield* first.connection.statusChanges.pipe(
        Stream.runForEach((status) =>
          Effect.sync(() => {
            statuses.push(status)
            if (status === "workspace-setup") Deferred.doneUnsafe(setupStatus, Effect.void)
          }),
        ),
        Effect.forkScoped,
      )
      const firstFiber = yield* first.session
        .events((event) => {
          firstEvents.push(event._tag)
          if (event._tag === "ThreadViewSnapshot") firstSnapshotUpdates.push(event.snapshot.thread.updatedAt)
          if (event._tag === "ExecutionControlled") Deferred.doneUnsafe(firstEvent, Effect.void)
        })
        .pipe(Effect.forkScoped)
      yield* Deferred.await(firstEvent)
      yield* Deferred.await(setupStatus)
      yield* Deferred.await(firstClosed)
      /**
       * The reconnect backoff runs on the TestClock, but the timer is scheduled when the close
       * event lands, so one blind adjust can fire before the timer exists and starve it forever.
       * Keep adjusting until the reattach lands.
       */
      const pumpReattach = Effect.gen(function* () {
        for (let attempt = 0; attempt < 200 && !(yield* Deferred.isDone(reattached)); attempt += 1) {
          yield* TestClock.adjust("50 millis")
          yield* Effect.yieldNow
        }
        return yield* Deferred.await(reattached)
      })
      yield* pumpReattach
      yield* first.session.submit("hello", undefined, undefined, undefined, "submission-1")
      const second = yield* makeHostedInteractiveSession({
        threadId: "thread-1",
        executorKind: "runner",
        createThread: () => Effect.succeed("thread-2"),
        setRemoteThreadCreation: () => Effect.void,
      }).pipe(Effect.provide(context))
      const secondEvents: Array<string> = []
      const secondFiber = yield* second.session
        .events((event) => {
          secondEvents.push(event._tag)
          if (event._tag === "ThreadViewSnapshot") Deferred.doneUnsafe(secondSnapshot, Effect.void)
        })
        .pipe(Effect.forkScoped)
      yield* Deferred.await(secondAttached)
      yield* Deferred.await(secondSnapshot)
      yield* first.session.quit
      yield* second.session.quit
      yield* Fiber.join(firstFiber)
      yield* Fiber.join(secondFiber)
      expect(afterCursors.slice(0, 3)).toEqual(["0", "1", "0"])
      expect(firstEvents.filter((tag) => tag === "ExecutionControlled")).toEqual(["ExecutionControlled"])
      expect(firstSnapshotUpdates.filter((updatedAt) => updatedAt === 2)).toHaveLength(1)
      expect(firstSnapshotUpdates.filter((updatedAt) => updatedAt === 3)).toHaveLength(1)
      expect(statuses).toEqual(
        expect.arrayContaining(["authenticating", "executor-waiting", "workspace-setup", "reconnecting"]),
      )
      expect(secondEvents).toContain("ThreadViewSnapshot")
      expect(commands.filter((command) => command._tag === "SubmitPrompt")).toHaveLength(1)
      expect(commands.some((command) => command._tag === "Cancel")).toBe(false)
    }),
  ),
)
