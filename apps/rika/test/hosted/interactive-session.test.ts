import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as BunSocket from "@effect/platform-bun/BunSocket"
import { expect, it } from "@effect/vitest"
import {
  ClientMessage,
  ServerFrame,
  type HostedThreadSnapshot,
  type ThreadProtocolEvent,
} from "@rika/product/client-protocol"
import * as ExecutionProjection from "@rika/product/execution-projection"
import { Deferred, Effect, Fiber, Layer, Logger, Metric, Option, Redacted, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
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
type ThreadAttached = Extract<ServerFrame["payload"], { readonly _tag: "ThreadAttached" }>
const key: PrivateJwk = { kty: "EC", crv: "P-256", x: "x", y: "y", d: "d" }
const profile: Profile = {
  origin: "https://hosted.example.test",
  deviceId: "device-1",
  clientId: "client-1",
  owner: { kind: "personal" },
}
const snapshot = (
  updatedAt = 1,
  executorKind: "runner" | "orb" = "runner",
  threadId = "thread-1",
): HostedThreadSnapshot => ({
  executorKind,
  view: {
    thread: {
      id: threadId as never,
      workspace: "workspace-1",
      title: "Thread",
      labels: [],
      pinned: false,
      archived: false,
      lineage: { _tag: "Original" },
      createdAt: 1,
      updatedAt,
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

const authorizationCheckpoint = {
  version: ExecutionProjection.projectionVersion,
  cursor: "authorization-cursor",
  state: '{"operation":"write","path":"README.md"}',
}
const authorizationSnapshot = (status: "pending" | "approved", commandReady: boolean): HostedThreadSnapshot => {
  const updatedAt = status === "pending" ? 3 : 4
  const current = snapshot(updatedAt)
  const usage = {
    ...ExecutionProjection.emptyUsageState(),
    costNanoUsd: 42,
    tokens: { total: 3, input: { total: 2 }, output: { total: 1 } },
    pricedAttempts: 1,
    countedAttempts: 1,
    sourceComplete: true,
    context: { requestOrdinal: 1, purpose: "conversation" as const, inputTokens: 2 },
    active: { _tag: "Available" as const, accumulatedMillis: 25 },
  }
  const pendingSteering = {
    runId: "run-1",
    entryId: "entry-1",
    requestId: "request-1",
    sequence: 1,
    text: "keep the exact API",
  }
  const view = {
    ...current.view,
    revision: status === "pending" ? 7 : 8,
    turns: [
      {
        turn: {
          kind: "agent" as const,
          id: "turn-authorization" as never,
          threadId: "thread-1" as never,
          prompt: "Update the README",
          status: "waiting" as const,
          author: { _tag: "Human" as const },
          lineage: { _tag: "Original" as const },
          createdAt: 2,
          updatedAt,
        },
        units: [
          {
            key: "authorization:1",
            turnId: "turn-authorization",
            order: [{ sequence: 0, part: 0, key: "authorization:1" }] as const,
            revision: status === "pending" ? 4 : 5,
            content: {
              _tag: "Block" as const,
              block: {
                _tag: "AuthorizationCard" as const,
                id: "authorization-1",
                operation: "write",
                capability: "workspace",
                input: '{"path":"README.md"}',
                inputTruncated: false,
                status,
              },
            },
          },
        ],
        projectionRevision: status === "pending" ? 4 : 5,
        usage,
        pendingSteering: [pendingSteering],
        settledSteering: [],
      },
    ],
    usage: { state: usage, contextCapacity: { contextWindow: 128_000, reserveTokens: 16_000 } },
  }
  return {
    executorKind: "runner",
    view,
    pendingAuthorizations: commandReady
      ? [
          {
            threadId: "thread-1" as never,
            turnId: "turn-authorization" as never,
            authorizationId: "authorization-1",
            operation: "write",
            capability: "workspace",
            input: '{"path":"README.md"}',
            inputTruncated: false,
            checkpoint: authorizationCheckpoint,
          },
        ]
      : [],
  }
}

const attachment = (input: {
  readonly requestId: string
  readonly threadId: string
  readonly threadVersion: string
  readonly cursor: string
  readonly snapshotThreadVersion?: string
  readonly snapshotCursor?: string
  readonly snapshot: HostedThreadSnapshot
  readonly events?: ReadonlyArray<ThreadProtocolEvent>
  readonly participants?: ThreadAttached["participants"]
}): ThreadAttached => ({
  _tag: "ThreadAttached",
  requestId: input.requestId as never,
  threadId: input.threadId as never,
  snapshotThreadVersion: (input.snapshotThreadVersion ?? input.threadVersion) as never,
  snapshotCursor: (input.snapshotCursor ?? ((input.events?.length ?? 0) === 0 ? input.cursor : "0")) as never,
  threadVersion: input.threadVersion as never,
  cursor: input.cursor as never,
  snapshot: input.snapshot,
  events: input.events ?? [],
  participants: input.participants ?? [],
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
  Effect.gen(function* () {
    const observations: Array<ReturnType<typeof Logger.formatStructured.log>> = []
    const logger = Logger.map(Logger.formatStructured, (record) => observations.push(record))
    yield* Effect.scoped(
      Effect.gen(function* () {
        const firstEvent = yield* Deferred.make<void>()
        const firstClosed = yield* Deferred.make<void>()
        const reattached = yield* Deferred.make<void>()
        const secondAttached = yield* Deferred.make<void>()
        const secondSnapshot = yield* Deferred.make<void>()
        const setupStatus = yield* Deferred.make<void>()
        const orbTarget = yield* Deferred.make<void>()
        const orbSetup = yield* Deferred.make<void>()
        const submittedSnapshot = yield* Deferred.make<void>()
        const approvalRequired = yield* Deferred.make<void>()
        const approvalCleared = yield* Deferred.make<void>()
        const slowAttached = yield* Deferred.make<void>()
        const runnerSetup = yield* Deferred.make<void>()
        const orbReconnecting = yield* Deferred.make<void>()
        const orbReconnected = yield* Deferred.make<void>()
        const failureReconnecting = yield* Deferred.make<void>()
        const failureReconnected = yield* Deferred.make<void>()
        const gatedAttached = yield* Deferred.make<void>()
        const staleRefreshAttached = yield* Deferred.make<void>()
        const staleRefreshRecovered = yield* Deferred.make<void>()
        const supersededAttached = yield* Deferred.make<void>()
        const newerAttached = yield* Deferred.make<void>()
        const queuedAttached = yield* Deferred.make<void>()
        const queuedRecovered = yield* Deferred.make<void>()
        const queuedRecoveryStatusObserved = yield* Deferred.make<void>()
        const queuedRecoveryConnected = yield* Deferred.make<void>()
        const failingAttached = yield* Deferred.make<void>()
        const malformedAttached = yield* Deferred.make<void>()
        const defectInitialAttached = yield* Deferred.make<void>()
        const thread2Restored = yield* Deferred.make<void>()
        const postDefectThread2Restored = yield* Deferred.make<void>()
        const thread3Attached = yield* Deferred.make<void>()
        const thread3Event = yield* Deferred.make<void>()
        const thread3Replayed = yield* Deferred.make<void>()
        const malformedRecovered = yield* Deferred.make<void>()
        const defectRecovered = yield* Deferred.make<void>()
        const defectThrown = yield* Deferred.make<void>()
        const defectReplacementPublished = yield* Deferred.make<void>()
        const defectConnected = yield* Deferred.make<void>()
        const mismatchReattached = yield* Deferred.make<void>()
        const sockets = new WeakMap<object, number>()
        const attachments = new WeakMap<object, string>()
        const attachmentLog: Array<{ readonly connection: number; readonly threadId: string }> = []
        const commands: Array<ClientMessage["command"]> = []
        const afterCursors: Array<string> = []
        const mutationThreads: Array<string> = []
        const mutationVersions: Array<string> = []
        const acknowledgements: Array<{
          readonly connection: number
          readonly threadId: string
          readonly cursor: string
        }> = []
        let sendSlowFrames: (() => void) | undefined
        let releaseGated: (() => void) | undefined
        let sendLateRetainedFrames: (() => void) | undefined
        let sendRefreshEvent: (() => void) | undefined
        let releaseStaleRefresh: (() => void) | undefined
        let releaseSuperseded: (() => void) | undefined
        let releaseQueued: (() => void) | undefined
        let sendQueuedRecoveryStatus: (() => void) | undefined
        let sendOrbSetup: (() => void) | undefined
        let sendThread3Setup: (() => void) | undefined
        let disconnectOrb: (() => void) | undefined
        let finalRunnerExpected = false
        let orbReconnectExpected = false
        let orbReconnectObserved = false
        let failureReconnectExpected = false
        let failureReplacementObserved = false
        let secondControllerExpected = false
        let thread3Attaches = 0
        let mismatchSent = false
        let gatedReleased = false
        let gatedAttaches = 0
        let thread2RestoreExpected = false
        let postDefectThread2RestoreExpected = false
        let queuedRecoveryExpected = false
        let malformedRecoveryExpected = false
        let defectRecoveryExpected = false
        let defectDispatchExpected = false
        let defectAttaches = 0
        const defectObservations: Array<{
          readonly eventThread: string
          readonly currentThread: string | undefined
          readonly checkpoint: typeof authorizationCheckpoint | undefined
          readonly target: string
          readonly participants: number
        }> = []
        let approvalObserved = false
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
        const lateAuthorization = authorizationSnapshot("pending", true)
        const lateAuthorizationSnapshot: HostedThreadSnapshot = {
          ...lateAuthorization,
          view: {
            ...lateAuthorization.view,
            thread: { ...lateAuthorization.view.thread, updatedAt: 99 },
          },
        }
        const server = yield* BunHttpServer.make({ hostname: "127.0.0.1", port: 0 })
        yield* server.serve(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const upgraded = yield* request.upgrade
            const write = yield* upgraded.writer
            const runSync = Effect.runSyncWith(yield* Effect.context<never>())
            const socket = {
              send: (value: string) => runSync(write(value)),
              close: () => runSync(write(new Socket.CloseEvent())),
            }
            yield* upgraded.runString(
              (value) =>
                Effect.sync(() => {
                  const message = decode(value)
                  commands.push(message.command)
                  if (message.command._tag === "AttachThread") {
                    afterCursors.push(String(message.command.afterCursor))
                    const connection = sockets.get(socket)
                    const attachedThreadId = message.command.threadId
                  const attachedThread = String(attachedThreadId)
                  attachments.set(socket, attachedThread)
                  attachmentLog.push({ connection: connection!, threadId: attachedThread })
                  if (thread2RestoreExpected && attachedThread === "thread-2")
                    Deferred.doneUnsafe(thread2Restored, Effect.void)
                  if (postDefectThread2RestoreExpected && attachedThread === "thread-2")
                    Deferred.doneUnsafe(postDefectThread2Restored, Effect.void)
                  if (queuedRecoveryExpected && attachedThread === "thread-2")
                    Deferred.doneUnsafe(queuedRecovered, Effect.void)
                  if (malformedRecoveryExpected && attachedThread === "thread-2")
                    Deferred.doneUnsafe(malformedRecovered, Effect.void)
                  if (attachedThread === "thread-defect") {
                    defectAttaches += 1
                    if (defectRecoveryExpected && defectAttaches > 2) Deferred.doneUnsafe(defectRecovered, Effect.void)
                  }
                  if (failureReconnectExpected && connection !== undefined && attachedThread === "thread-2")
                    failureReplacementObserved = true
                  if (attachedThread === "thread-failing") {
                    Deferred.doneUnsafe(failingAttached, Effect.void)
                    socket.send(
                      encode({
                        protocolVersion: 1,
                        payload: {
                          _tag: "CommandRejected",
                          requestId: message.requestId,
                          threadId: message.command.threadId,
                          reason: "unavailable",
                          message: "selection unavailable",
                          details: {},
                        },
                      }),
                    )
                    return
                  }
                  if (attachedThread === "thread-malformed") {
                    Deferred.doneUnsafe(malformedAttached, Effect.void)
                    socket.send(
                      encode({
                        protocolVersion: 1,
                        payload: attachment({
                          requestId: message.requestId,
                          threadId: attachedThread,
                          threadVersion: "10",
                          cursor: "10",
                          snapshotThreadVersion: "10",
                          snapshotCursor: "9",
                          snapshot: snapshot(10, "runner", attachedThread),
                          events: [
                            {
                              threadId: attachedThread as never,
                              sequence: "10" as never,
                              cursor: "10" as never,
                              threadVersion: "10" as never,
                              event: {
                                _tag: "ThreadViewPatch",
                                patch: {
                                  threadId: attachedThread as never,
                                  baseRevision: 99,
                                  revision: 100,
                                  upsert: [],
                                  remove: [],
                                  turnChanges: [],
                                },
                              },
                              createdAt: "2026-08-21T00:00:00.000Z" as never,
                            },
                          ],
                        }),
                      }),
                    )
                    return
                  }
                  if (attachedThread === "thread-slow") {
                    sendSlowFrames = () => {
                      socket.send(
                        encode({
                          protocolVersion: 1,
                          payload: attachment({
                            requestId: message.requestId,
                            threadId: attachedThread,
                            threadVersion: "7" as never,
                            cursor: "7" as never,
                            snapshot: snapshot(7, "orb", "thread-slow"),
                          }),
                        }),
                      )
                      socket.send(
                        encode({
                          protocolVersion: 1,
                          payload: {
                            _tag: "WorkspaceStatus",
                            threadId: "thread-slow" as never,
                            status: { state: "resuming" },
                          },
                        }),
                      )
                    }
                    Deferred.doneUnsafe(slowAttached, Effect.void)
                    return
                  }
                  if (attachedThread === "thread-superseded") {
                    releaseSuperseded = () =>
                      socket.send(
                        encode({
                          protocolVersion: 1,
                          payload: attachment({
                            requestId: message.requestId,
                            threadId: attachedThread,
                            threadVersion: "8" as never,
                            cursor: "8" as never,
                            snapshot: snapshot(8, "runner", "thread-superseded"),
                          }),
                        }),
                      )
                    Deferred.doneUnsafe(supersededAttached, Effect.void)
                    return
                  }
                  if (attachedThread === "thread-queued") {
                    releaseQueued = () =>
                      socket.send(
                        encode({
                          protocolVersion: 1,
                          payload: attachment({
                            requestId: message.requestId,
                            threadId: attachedThread,
                            threadVersion: "9" as never,
                            cursor: "9" as never,
                            snapshot: snapshot(9, "runner", "thread-queued"),
                          }),
                        }),
                      )
                    Deferred.doneUnsafe(queuedAttached, Effect.void)
                    return
                  }
                  if (attachedThread === "thread-gated") {
                    gatedAttaches += 1
                    sendLateRetainedFrames = () => {
                      socket.send(
                        encode({
                          protocolVersion: 1,
                          payload: {
                            _tag: "ThreadSnapshot",
                            threadId: "thread-2" as never,
                            threadVersion: "99" as never,
                            cursor: "99" as never,
                            snapshot: snapshot(99, "runner", "thread-2"),
                          },
                        }),
                      )
                      socket.send(
                        encode({
                          protocolVersion: 1,
                          payload: {
                            _tag: "ThreadEvent",
                            event: {
                              threadId: "thread-2" as never,
                              sequence: "99" as never,
                              cursor: "99" as never,
                              threadVersion: "99" as never,
                              event: { _tag: "ExecutionControlled", action: "cancelled" },
                              createdAt: "2026-08-21T00:00:00.000Z" as never,
                            },
                          },
                        }),
                      )
                      socket.send(
                        encode({
                          protocolVersion: 1,
                          payload: {
                            _tag: "ExecutorStatus",
                            threadId: "thread-2" as never,
                            status: { state: "terminal" },
                          },
                        }),
                      )
                      socket.send(
                        encode({
                          protocolVersion: 1,
                          payload: { _tag: "PresenceSnapshot", threadId: "thread-2" as never, participants: [] },
                        }),
                      )
                    }
                    const sendGated = (threadVersion = "6", attachedCursor = "6") =>
                      socket.send(
                        encode({
                          protocolVersion: 1,
                          payload: attachment({
                            requestId: message.requestId,
                            threadId: attachedThread,
                            threadVersion: threadVersion as never,
                            cursor: attachedCursor as never,
                            snapshot: snapshot(6, "runner", "thread-gated"),
                          }),
                        }),
                      )
                    if (gatedAttaches === 2) {
                      sendRefreshEvent = () =>
                        socket.send(
                          encode({
                            protocolVersion: 1,
                            payload: {
                              _tag: "ThreadEvent",
                              event: {
                                threadId: attachedThread as never,
                                sequence: "7" as never,
                                cursor: "7" as never,
                                threadVersion: "7" as never,
                                event: { _tag: "ThreadTitled", threadId: attachedThread, title: "Gated seven" },
                                createdAt: "2026-08-21T00:00:00.000Z" as never,
                              },
                            },
                          }),
                        )
                      releaseStaleRefresh = sendGated
                      Deferred.doneUnsafe(staleRefreshAttached, Effect.void)
                    } else if (gatedAttaches > 2) {
                      sendGated("7", "7")
                      Deferred.doneUnsafe(staleRefreshRecovered, Effect.void)
                    } else if (gatedReleased) sendGated()
                    else {
                      releaseGated = () => {
                        gatedReleased = true
                        sendGated()
                      }
                      Deferred.doneUnsafe(gatedAttached, Effect.void)
                    }
                    return
                  }
                  if (attachedThread === "thread-defect") {
                    if (defectAttaches === 1) {
                      Deferred.doneUnsafe(defectInitialAttached, Effect.void)
                      socket.send(
                        encode({
                          protocolVersion: 1,
                          payload: attachment({
                            requestId: message.requestId,
                            threadId: attachedThread,
                            threadVersion: "1",
                            cursor: "1",
                            snapshot: snapshot(1, "runner", attachedThread),
                          }),
                        }),
                      )
                      return
                    }
                    const defectSnapshot = snapshot(2, "orb", attachedThread)
                    socket.send(
                      encode({
                        protocolVersion: 1,
                        payload: attachment({
                          requestId: message.requestId,
                          threadId: attachedThread,
                          threadVersion: "2",
                          cursor: "2",
                          snapshot: {
                            ...defectSnapshot,
                            pendingAuthorizations: [
                              {
                                threadId: attachedThread as never,
                                turnId: "turn-defect" as never,
                                authorizationId: "authorization-defect",
                                operation: "write",
                                capability: "workspace",
                                input: "{}",
                                inputTruncated: false,
                                checkpoint: authorizationCheckpoint,
                              },
                            ],
                          },
                          participants: [
                            {
                              actor: {
                                _tag: "PersonalActor",
                                owner: { _tag: "PersonalOwner", userId: "defect-user" as never },
                                userId: "defect-user" as never,
                                clientId: "defect-client" as never,
                                deviceId: "defect-device" as never,
                              },
                              status: "controlling",
                            },
                          ],
                        }),
                      }),
                    )
                    return
                  }
                  socket.send(
                    encode({
                      protocolVersion: 1,
                      payload: attachment({
                        requestId: message.requestId,
                        threadId: attachedThread,
                        threadVersion: version as never,
                        cursor: (attachedThread === "thread-3" && thread3Attaches > 0 ? "2" : cursor) as never,
                        snapshot: snapshot(
                          Number(version),
                          attachedThread === "thread-2" ? "orb" : "runner",
                          attachedThread,
                        ),
                        events: connection === 1 ? [threadEvent] : [],
                        participants:
                          connection === 1
                            ? [
                                {
                                  actor: {
                                    _tag: "PersonalActor",
                                    owner: { _tag: "PersonalOwner", userId: "initial-user" as never },
                                    userId: "initial-user" as never,
                                    clientId: "initial-client" as never,
                                    deviceId: "initial-device" as never,
                                  },
                                  status: "controlling",
                                },
                              ]
                            : [],
                      }),
                    }),
                  )
                  if (queuedRecoveryExpected && attachedThread === "thread-2")
                    sendQueuedRecoveryStatus = () =>
                      socket.send(
                        encode({
                          protocolVersion: 1,
                          payload: {
                            _tag: "WorkspaceStatus",
                            threadId: "thread-2" as never,
                            status: { state: "resuming" },
                          },
                        }),
                      )
                  if (attachedThread === "thread-3") {
                    thread3Attaches += 1
                    let attached: Deferred.Deferred<void>
                    if (thread3Attaches === 1) attached = thread3Attached
                    else if (thread3Attaches === 2) attached = thread3Replayed
                    else attached = mismatchReattached
                    Deferred.doneUnsafe(attached, Effect.void)
                    if (thread3Attaches === 1)
                      socket.send(
                        encode({
                          protocolVersion: 1,
                          payload: {
                            _tag: "ThreadEvent",
                            event: {
                              threadId: "thread-3" as never,
                              sequence: "2" as never,
                              cursor: "2" as never,
                              threadVersion: "2" as never,
                              createdAt: "2026-08-21T00:00:00.000Z" as never,
                              event: { _tag: "ThreadTitled", threadId: "thread-3", title: "Three" },
                            },
                          },
                        }),
                      )
                    sendThread3Setup = () =>
                      socket.send(
                        encode({
                          protocolVersion: 1,
                          payload: {
                            _tag: "WorkspaceStatus",
                            threadId: "thread-3" as never,
                            status: { state: "setup" },
                          },
                        }),
                      )
                  }
                  if (attachedThread === "thread-newer") Deferred.doneUnsafe(newerAttached, Effect.void)
                  if (connection === 1) {
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
                  } else if (connection === 2) {
                    Deferred.doneUnsafe(reattached, Effect.void)
                    if (attachedThread === "thread-2") {
                      disconnectOrb = () => socket.close()
                      socket.send(
                        encode({
                          protocolVersion: 1,
                          payload: {
                            _tag: "ThreadSnapshot",
                            threadId: "thread-1" as never,
                            threadVersion: "99" as never,
                            cursor: "2" as never,
                            snapshot: lateAuthorizationSnapshot,
                          },
                        }),
                      )
                      socket.send(
                        encode({
                          protocolVersion: 1,
                          payload: {
                            _tag: "ThreadEvent",
                            event: {
                              ...threadEvent,
                              sequence: "3" as never,
                              cursor: "3" as never,
                              threadVersion: "99" as never,
                            },
                          },
                        }),
                      )
                      socket.send(
                        encode({
                          protocolVersion: 1,
                          payload: {
                            _tag: "ThreadEvent",
                            event: {
                              threadId: "thread-1" as never,
                              sequence: "4" as never,
                              cursor: "4" as never,
                              threadVersion: "99" as never,
                              event: {
                                _tag: "ThreadViewSnapshot",
                                snapshot: {
                                  ...lateAuthorizationSnapshot.view,
                                  thread: { ...lateAuthorizationSnapshot.view.thread, updatedAt: 100 },
                                },
                              },
                              createdAt: "2026-08-21T00:00:00.000Z" as never,
                            },
                          },
                        }),
                      )
                      socket.send(
                        encode({
                          protocolVersion: 1,
                          payload: {
                            _tag: "PresenceSnapshot",
                            threadId: "thread-1" as never,
                            participants: [
                              {
                                actor: {
                                  _tag: "PersonalActor",
                                  owner: { _tag: "PersonalOwner", userId: "late-user" as never },
                                  userId: "late-user" as never,
                                  clientId: "late-client" as never,
                                  deviceId: "late-device" as never,
                                },
                                status: "controlling",
                              },
                            ],
                          },
                        }),
                      )
                      sendOrbSetup = () =>
                        socket.send(
                          encode({
                            protocolVersion: 1,
                            payload: {
                              _tag: "WorkspaceStatus",
                              threadId: "thread-2" as never,
                              status: { state: "setup" },
                            },
                          }),
                        )
                    }
                  } else if (secondControllerExpected) Deferred.doneUnsafe(secondAttached, Effect.void)
                  return
                }
                if (message.command._tag === "AcknowledgeCursor") {
                  acknowledgements.push({
                    connection: sockets.get(socket)!,
                    threadId: String(message.command.threadId),
                    cursor: String(message.command.cursor),
                  })
                  socket.send(
                    encode({
                      protocolVersion: 1,
                      payload: {
                        _tag: "CommandAccepted",
                        requestId: message.requestId,
                        threadId: message.command.threadId,
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
                  const commandThread = String(message.command.threadId)
                  mutationThreads.push(commandThread)
                  mutationVersions.push(String(message.command.expectedThreadVersion))
                  version = "2"
                  const mismatch = message.command.commandId === "submission-mismatch" && !mismatchSent
                  if (mismatch) mismatchSent = true
                  socket.send(
                    encode({
                      protocolVersion: 1,
                      payload: {
                        _tag: "CommandAccepted",
                        requestId: message.requestId,
                        commandId: message.command.commandId,
                        threadId: (mismatch ? "thread-wrong" : message.command.threadId) as never,
                        threadVersion: "2" as never,
                        cursor: cursor as never,
                        result: { _tag: "Applied" },
                      },
                    }),
                  )
                  if (mismatch) return
                  if (commandThread === "thread-1") {
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
                          snapshot: authorizationSnapshot("pending", false),
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
                          snapshot: authorizationSnapshot("pending", true),
                        },
                      }),
                    )
                  }
                  return
                }
                if (message.command._tag === "Approve") {
                  socket.send(
                    encode({
                      protocolVersion: 1,
                      payload: {
                        _tag: "CommandAccepted",
                        requestId: message.requestId,
                        commandId: message.command.commandId,
                        threadId: message.command.threadId,
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
                        threadId: message.command.threadId,
                        threadVersion: "2" as never,
                        cursor: cursor as never,
                        snapshot: authorizationSnapshot("approved", false),
                      },
                    }),
                  )
                }
                }),
              {
                onOpen: Effect.sync(() => {
                  opened += 1
                  sockets.set(socket, opened)
                }),
              },
            ).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (sockets.get(socket) === 1) Deferred.doneUnsafe(firstClosed, Effect.void)
                }),
              ),
            )
            return HttpServerResponse.empty()
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
                  websocketUrl: `ws://127.0.0.1:${server.address._tag === "TcpAddress" ? server.address.port : 0}`,
                  protocol: "rika.thread.v1",
                }),
            }),
          ),
        )
        const context = yield* Layer.build(layer)
        const first = yield* makeHostedInteractiveSession({
          threadId: "thread-1",
          createThread: () => Effect.succeed("thread-2"),
          setRemoteThreadCreation: () => Effect.void,
        }).pipe(Effect.provide(context))
        const firstEvents: Array<string> = []
        const firstSnapshotUpdates: Array<string> = []
        const states: Array<(typeof first.connection)["initialState"]> = []
        yield* first.connection.stateChanges.pipe(
          Stream.runForEach((state) =>
            Effect.sync(() => {
              states.push(state)
              if (state.activity === "workspace-setup") Deferred.doneUnsafe(setupStatus, Effect.void)
              if (state.target === "orb") Deferred.doneUnsafe(orbTarget, Effect.void)
              if (state.target === "orb" && state.activity === "workspace-setup")
                Deferred.doneUnsafe(orbSetup, Effect.void)
              if (state.activity === "approval-required") {
                approvalObserved = true
                Deferred.doneUnsafe(approvalRequired, Effect.void)
              } else if (approvalObserved) Deferred.doneUnsafe(approvalCleared, Effect.void)
              if (finalRunnerExpected && state.target === "runner" && state.activity === "workspace-setup")
                Deferred.doneUnsafe(runnerSetup, Effect.void)
              if (orbReconnectExpected && state.target === "orb" && state.connectivity === "reconnecting") {
                orbReconnectObserved = true
                Deferred.doneUnsafe(orbReconnecting, Effect.void)
              }
              if (orbReconnectObserved && state.target === "orb" && state.connectivity === "connected")
                Deferred.doneUnsafe(orbReconnected, Effect.void)
              if (failureReconnectExpected && state.target === "orb" && state.connectivity === "reconnecting") {
                Deferred.doneUnsafe(failureReconnecting, Effect.void)
              }
              if (failureReplacementObserved && state.target === "orb" && state.connectivity === "connected")
                Deferred.doneUnsafe(failureReconnected, Effect.void)
              if (defectRecoveryExpected && state.target === "orb" && state.connectivity === "connected")
                Deferred.doneUnsafe(defectConnected, Effect.void)
              if (queuedRecoveryExpected && state.target === "orb" && state.activity === "workspace-resuming")
                Deferred.doneUnsafe(queuedRecoveryStatusObserved, Effect.void)
              if (queuedRecoveryExpected && state.connectivity === "connected")
                Deferred.doneUnsafe(queuedRecoveryConnected, Effect.void)
            }),
          ),
          Effect.forkScoped,
        )
        const firstFiber = yield* first.session
          .events((event) => {
            firstEvents.push(event._tag)
            if (event._tag === "ThreadViewSnapshot") {
              if (defectDispatchExpected && String(event.snapshot.thread.id) === "thread-defect") {
                defectDispatchExpected = false
                defectObservations.push({
                  eventThread: String(event.snapshot.thread.id),
                  currentThread: first.session.currentView()?.thread.id,
                  checkpoint: first.session.projectionCheckpoint("turn-defect"),
                  target: states.at(-1)!.target,
                  participants: states.at(-1)!.participants,
                })
                Deferred.doneUnsafe(defectThrown, Effect.void)
                throw new Error("attachment dispatch defect")
              }
              firstSnapshotUpdates.push(`${event.snapshot.thread.id}:${event.snapshot.thread.updatedAt}`)
              if (event.snapshot.thread.id === "thread-defect" && event.snapshot.thread.updatedAt === 2)
                Deferred.doneUnsafe(defectReplacementPublished, Effect.void)
              if (event.snapshot.thread.id === "thread-1" && event.snapshot.thread.updatedAt === 3)
                Deferred.doneUnsafe(submittedSnapshot, Effect.void)
            }
            if (event._tag === "ExecutionControlled") Deferred.doneUnsafe(firstEvent, Effect.void)
            if (event._tag === "ThreadTitled") Deferred.doneUnsafe(thread3Event, Effect.void)
          })
          .pipe(Effect.forkScoped)
        yield* Deferred.await(setupStatus)
        yield* Deferred.await(firstClosed)
        /**
         * The reconnect backoff runs on the TestClock, but the timer is scheduled when the close
         * event lands, so one blind adjust can fire before the timer exists and starve it forever.
         * Keep adjusting until the reattach lands.
         */
        const pumpReconnect = (done: Deferred.Deferred<void>) =>
          Effect.gen(function* () {
            for (let attempt = 0; attempt < 200 && !(yield* Deferred.isDone(done)); attempt += 1) {
              yield* TestClock.adjust("50 millis")
              yield* Effect.yieldNow
            }
            return yield* Deferred.await(done)
          })
        yield* pumpReconnect(reattached)
        yield* first.session.selectThread("thread-1")
        const unchangedRenderCount = firstSnapshotUpdates.length
        const unchangedStateCount = states.length
        const refreshCount = attachmentLog.length
        for (let poll = 0; poll < 3; poll += 1) {
          yield* TestClock.adjust("500 millis")
          yield* Effect.yieldNow
        }
        expect(attachmentLog.length).toBeGreaterThan(refreshCount)
        expect(firstSnapshotUpdates).toHaveLength(unchangedRenderCount)
        expect(states.slice(unchangedStateCount)).toEqual([])
        yield* first.session.submit("hello", undefined, undefined, undefined, "submission-1")
        yield* Deferred.await(submittedSnapshot)
        yield* Deferred.await(approvalRequired)
        expect(first.session.currentView()).toMatchObject({
          revision: 7,
          usage: { state: { costNanoUsd: 42 }, contextCapacity: { contextWindow: 128_000 } },
          turns: [
            {
              projectionRevision: 4,
              pendingSteering: [{ text: "keep the exact API" }],
              units: [{ content: { block: { _tag: "AuthorizationCard", status: "pending" } } }],
            },
          ],
        })
        expect(first.session.projectionCheckpoint("turn-authorization")).toEqual(authorizationCheckpoint)
        yield* first.session.approveAuthorization(
          "turn-authorization" as never,
          "authorization-1",
          authorizationCheckpoint,
        )
        yield* Deferred.await(approvalCleared)
        expect(first.session.projectionCheckpoint("turn-authorization")).toBeUndefined()
        expect(first.session.currentView()).toMatchObject({
          revision: 8,
          turns: [{ units: [{ content: { block: { _tag: "AuthorizationCard", status: "approved" } } }] }],
        })
        yield* first.session.newOrbThread!
        yield* Effect.sync(() => sendOrbSetup!())
        yield* Deferred.await(orbTarget)
        yield* Deferred.await(orbSetup)
        expect(states.at(-1)).toMatchObject({ target: "orb", activity: "workspace-setup", participants: 0 })
        expect(first.session.currentView()?.thread.id).toBe("thread-2")
        expect(first.session.projectionCheckpoint("turn-authorization")).toBeUndefined()
        expect(firstSnapshotUpdates).not.toContain("thread-1:99")
        expect(firstSnapshotUpdates).not.toContain("thread-1:100")
        orbReconnectExpected = true
        yield* Effect.sync(() => disconnectOrb!())
        yield* pumpReconnect(orbReconnecting)
        yield* pumpReconnect(orbReconnected)
        const gatedSelection = yield* first.session.selectThread("thread-gated").pipe(Effect.forkChild)
        yield* Deferred.await(gatedAttached)
        const retainedView = first.session.currentView()
        const retainedCheckpoint = first.session.projectionCheckpoint("turn-authorization")
        const retainedState = states.at(-1)
        const retainedStateCount = states.length
        const retainedRenderCount = firstSnapshotUpdates.length
        const retainedEventCount = firstEvents.length
        const retainedAckCount = acknowledgements.length
        yield* Effect.sync(() => sendLateRetainedFrames!())
        yield* Effect.yieldNow
        expect(first.session.currentView()).toEqual(retainedView)
        expect(first.session.projectionCheckpoint("turn-authorization")).toEqual(retainedCheckpoint)
        expect(states).toHaveLength(retainedStateCount)
        expect(states.at(-1)).toEqual(retainedState)
        expect(firstSnapshotUpdates).toHaveLength(retainedRenderCount)
        expect(firstEvents).toHaveLength(retainedEventCount)
        expect(acknowledgements).toHaveLength(retainedAckCount)
        yield* Effect.sync(() => releaseGated!())
        yield* Fiber.join(gatedSelection)
        expect(first.session.currentView()?.thread.id).toBe("thread-gated")
        expect(states.at(-1)).toMatchObject({ target: "runner", participants: 0 })
        for (
          let attempt = 0;
          attempt < 20 &&
          !acknowledgements.some(
            (acknowledgement) => acknowledgement.threadId === "thread-gated" && acknowledgement.cursor === "6",
          );
          attempt += 1
        )
          yield* Effect.yieldNow
        const refreshRenderCount = firstSnapshotUpdates.length
        const refreshAckCount = acknowledgements.length
        const refreshEventCount = firstEvents.filter((event) => event === "ThreadTitled").length
        yield* TestClock.adjust("500 millis")
        yield* Deferred.await(staleRefreshAttached)
        yield* Effect.sync(() => sendRefreshEvent!())
        for (
          let attempt = 0;
          attempt < 20 &&
          !acknowledgements
            .slice(refreshAckCount)
            .some((acknowledgement) => acknowledgement.threadId === "thread-gated" && acknowledgement.cursor === "7");
          attempt += 1
        )
          yield* Effect.yieldNow
        expect(acknowledgements.slice(refreshAckCount)).toEqual([
          expect.objectContaining({ threadId: "thread-gated", cursor: "7" }),
        ])
        yield* Effect.sync(() => releaseStaleRefresh!())
        yield* pumpReconnect(staleRefreshRecovered)
        expect(first.session.currentView()?.thread.id).toBe("thread-gated")
        expect(firstSnapshotUpdates).toHaveLength(refreshRenderCount)
        expect(firstEvents.filter((event) => event === "ThreadTitled")).toHaveLength(refreshEventCount + 1)
        expect(acknowledgements.slice(refreshAckCount)).toEqual([
          expect.objectContaining({ threadId: "thread-gated", cursor: "7" }),
        ])
        thread2RestoreExpected = true
        const restoreThread2 = yield* first.session.selectThread("thread-2").pipe(Effect.forkChild)
        yield* pumpReconnect(thread2Restored)
        yield* Fiber.join(restoreThread2)
        thread2RestoreExpected = false
        const supersededAttachmentStart = attachmentLog.length
        const supersededSelection = yield* first.session.selectThread("thread-superseded").pipe(Effect.forkChild)
        yield* Deferred.await(supersededAttached)
        const newerSelection = yield* first.session.selectThread("thread-newer").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* Effect.sync(() => releaseSuperseded!())
        expect(yield* Fiber.await(supersededSelection)).toMatchObject({ _tag: "Failure" })
        yield* pumpReconnect(newerAttached)
        yield* Fiber.join(newerSelection)
        const supersededAttachments = attachmentLog.slice(supersededAttachmentStart)
        const supersededSocket = supersededAttachments.find((entry) => entry.threadId === "thread-superseded")
        const newerReplacement = supersededAttachments.find(
          (entry) => entry.connection !== supersededSocket?.connection,
        )
        expect(newerReplacement).toMatchObject({ threadId: "thread-2" })
        expect(
          supersededAttachments.some(
            (entry) => entry.connection === newerReplacement?.connection && entry.threadId === "thread-newer",
          ),
        ).toBe(true)
        yield* first.session.selectThread("thread-2")
        const queuedAttachmentStart = attachmentLog.length
        const queuedSelection = yield* first.session.selectThread("thread-queued").pipe(Effect.forkChild)
        yield* Deferred.await(queuedAttached)
        const interruptedQueued = yield* first.session.selectThread("thread-interrupted-queued").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* Fiber.interrupt(interruptedQueued)
        queuedRecoveryExpected = true
        yield* Effect.sync(() => releaseQueued!())
        expect(yield* Fiber.await(queuedSelection)).toMatchObject({ _tag: "Failure" })
        yield* pumpReconnect(queuedRecovered)
        yield* Effect.sync(() => sendQueuedRecoveryStatus!())
        yield* Deferred.await(queuedRecoveryStatusObserved)
        yield* Deferred.await(queuedRecoveryConnected)
        expect(attachmentLog.slice(queuedAttachmentStart).at(-1)).toMatchObject({ threadId: "thread-2" })
        expect(
          attachmentLog.slice(queuedAttachmentStart).some((entry) => entry.threadId === "thread-interrupted-queued"),
        ).toBe(false)
        expect(
          acknowledgements.some((acknowledgement) => acknowledgement.threadId === "thread-interrupted-queued"),
        ).toBe(false)
        expect(first.session.currentView()?.thread.id).toBe("thread-2")
        expect(states.at(-1)).toMatchObject({ target: "orb", participants: 0, activity: "workspace-resuming" })
        queuedRecoveryExpected = false
        failureReconnectExpected = true
        const failingSelection = yield* first.session
          .selectThread("thread-failing")
          .pipe(Effect.result, Effect.forkChild)
        yield* pumpReconnect(failingAttached)
        const failingSelectionResult = yield* Fiber.join(failingSelection)
        expect(failingSelectionResult).toMatchObject({ _tag: "Failure" })
        yield* pumpReconnect(failureReconnecting)
        yield* pumpReconnect(failureReconnected)
        expect(states.at(-1)).toMatchObject({ connectivity: "connected", target: "orb", participants: 0 })
        malformedRecoveryExpected = true
        const malformedSelection = yield* first.session
          .selectThread("thread-malformed")
          .pipe(Effect.result, Effect.forkChild)
        yield* pumpReconnect(malformedAttached)
        expect(yield* Fiber.join(malformedSelection)).toMatchObject({ _tag: "Failure" })
        yield* pumpReconnect(malformedRecovered)
        malformedRecoveryExpected = false
        expect(firstSnapshotUpdates).not.toContain("thread-malformed:10")
        const initialDefectSelection = yield* first.session.selectThread("thread-defect").pipe(Effect.forkChild)
        yield* pumpReconnect(defectInitialAttached)
        yield* Fiber.join(initialDefectSelection)
        for (
          let attempt = 0;
          attempt < 20 &&
          !acknowledgements.some(
            (acknowledgement) => acknowledgement.threadId === "thread-defect" && acknowledgement.cursor === "1",
          );
          attempt += 1
        )
          yield* Effect.yieldNow
        defectRecoveryExpected = true
        defectDispatchExpected = true
        const defectAckStart = acknowledgements.length
        const defectSelection = yield* first.session.selectThread("thread-defect").pipe(Effect.exit, Effect.forkChild)
        yield* Deferred.await(defectThrown)
        expect(yield* Fiber.join(defectSelection)).toMatchObject({ _tag: "Failure" })
        expect(acknowledgements.slice(defectAckStart)).not.toContainEqual(
          expect.objectContaining({ threadId: "thread-defect", cursor: "2" }),
        )
        yield* pumpReconnect(defectRecovered)
        yield* Deferred.await(defectReplacementPublished)
        yield* pumpReconnect(defectConnected)
        for (let attempt = 0; attempt < 20 && acknowledgements.length === defectAckStart; attempt += 1)
          yield* Effect.yieldNow
        defectRecoveryExpected = false
        expect(defectObservations).toEqual([
          {
            eventThread: "thread-defect",
            currentThread: "thread-defect",
            checkpoint: authorizationCheckpoint,
            target: "orb",
            participants: 1,
          },
        ])
        expect(first.session.currentView()?.thread.id).toBe("thread-defect")
        expect(firstSnapshotUpdates.filter((update) => update === "thread-defect:2")).toHaveLength(1)
        expect(acknowledgements.slice(defectAckStart)).toEqual([
          expect.objectContaining({ threadId: "thread-defect", cursor: "2" }),
        ])
        yield* first.session.submit("defect mutation", undefined, undefined, undefined, "submission-defect")
        expect(mutationThreads.at(-1)).toBe("thread-defect")
        expect(mutationVersions.at(-1)).toBe("2")
        const defectRenderCount = firstSnapshotUpdates.length
        const defectStateCount = states.length
        const defectAckCount = acknowledgements.length
        yield* TestClock.adjust("500 millis")
        yield* Effect.yieldNow
        expect(firstSnapshotUpdates).toHaveLength(defectRenderCount)
        expect(states).toHaveLength(defectStateCount)
        expect(acknowledgements).toHaveLength(defectAckCount)
        postDefectThread2RestoreExpected = true
        const postDefectSelection = yield* first.session.selectThread("thread-2").pipe(Effect.forkChild)
        yield* pumpReconnect(postDefectThread2Restored)
        yield* Fiber.join(postDefectSelection)
        postDefectThread2RestoreExpected = false
        const interruptedAttachmentStart = attachmentLog.length
        const slowSelection = yield* first.session.selectThread("thread-slow").pipe(Effect.forkChild)
        yield* Deferred.await(slowAttached)
        yield* Fiber.interrupt(slowSelection)
        const currentSelection = yield* first.session.selectThread("thread-3").pipe(Effect.forkChild)
        yield* pumpReconnect(thread3Attached)
        yield* Fiber.join(currentSelection)
        yield* Deferred.await(thread3Event)
        const interruptedAttachments = attachmentLog.slice(interruptedAttachmentStart)
        const interruptedSocket = interruptedAttachments.find((entry) => entry.threadId === "thread-slow")
        const replacement = interruptedAttachments.find((entry) => entry.connection !== interruptedSocket?.connection)
        expect(interruptedSocket).toBeDefined()
        expect(replacement).toMatchObject({ threadId: "thread-2" })
        expect(
          interruptedAttachments.some(
            (entry) => entry.connection === replacement?.connection && entry.threadId === "thread-3",
          ),
        ).toBe(true)
        finalRunnerExpected = true
        yield* Effect.sync(() => sendSlowFrames!())
        yield* Effect.sync(() => sendThread3Setup!())
        yield* Deferred.await(runnerSetup)
        yield* first.session.reopenThread
        yield* pumpReconnect(thread3Replayed)
        expect(yield* Effect.result(first.session.readQueue("thread-1"))).toMatchObject({ _tag: "Failure" })
        yield* first.session.submit("still on three", undefined, undefined, undefined, "submission-2")
        const openedBeforeMismatch = opened
        const mismatched = yield* first.session
          .submit("quarantine mismatch", undefined, undefined, undefined, "submission-mismatch")
          .pipe(Effect.forkChild)
        yield* pumpReconnect(mismatchReattached)
        yield* Fiber.join(mismatched)
        expect(opened).toBeGreaterThan(openedBeforeMismatch)
        secondControllerExpected = true
        const second = yield* makeHostedInteractiveSession({
          threadId: "thread-1",
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
        expect(afterCursors.slice(0, 2)).toEqual(["0", "1"])
        expect(afterCursors[attachmentLog.findIndex((entry) => entry.threadId === "thread-2")]).toBe("0")
        expect(firstEvents.filter((tag) => tag === "ExecutionControlled")).toEqual([])
        expect(firstEvents.filter((tag) => tag === "ThreadTitled")).toEqual(["ThreadTitled", "ThreadTitled"])
        expect(acknowledgements.filter((acknowledgement) => acknowledgement.connection === 1)).toEqual([
          { connection: 1, threadId: "thread-1", cursor: "1" },
        ])
        expect(
          acknowledgements
            .filter((acknowledgement) => acknowledgement.threadId === "thread-3")
            .map((acknowledgement) => acknowledgement.cursor)
            .slice(0, 2),
        ).toEqual(["1", "2"])
        expect(firstSnapshotUpdates.filter((update) => update === "thread-1:2")).toHaveLength(1)
        expect(firstSnapshotUpdates.filter((update) => update === "thread-1:3")).toHaveLength(1)
        expect(firstSnapshotUpdates).not.toContain("thread-1:99")
        expect(firstSnapshotUpdates).not.toContain("thread-superseded:8")
        expect(firstSnapshotUpdates).not.toContain("thread-queued:9")
        expect(states).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ connectivity: "connecting", target: "resolving", activity: "authenticating" }),
            expect.objectContaining({ target: "runner", participants: 1 }),
            expect.objectContaining({ connectivity: "connected", target: "runner", activity: "workspace-setup" }),
            expect.objectContaining({ connectivity: "reconnecting", target: "runner" }),
          ]),
        )
        const runnerIndex = states.findIndex((state) => state.target === "runner")
        const resolvingIndex = states.findIndex((state, index) => index > runnerIndex && state.target === "resolving")
        const orbIndex = states.findIndex((state, index) => index > resolvingIndex && state.target === "orb")
        expect(runnerIndex).toBeGreaterThanOrEqual(0)
        expect(resolvingIndex).toBeGreaterThan(runnerIndex)
        expect(orbIndex).toBeGreaterThan(resolvingIndex)
        expect(states.at(-1)).toMatchObject({ target: "runner", participants: 0 })
        expect(states.filter((state) => state.activity === "workspace-resuming")).toHaveLength(1)
        expect(secondEvents).toContain("ThreadViewSnapshot")
        expect(commands.filter((command) => command._tag === "SubmitPrompt")).toHaveLength(5)
        expect(commands.filter((command) => command._tag === "Approve")).toEqual([
          expect.objectContaining({
            threadId: "thread-1",
            turnId: "turn-authorization",
            authorizationId: "authorization-1",
            checkpoint: authorizationCheckpoint,
          }),
        ])
        expect(mutationThreads).toEqual(["thread-1", "thread-defect", "thread-3", "thread-3", "thread-3"])
        for (const rejected of [
          { threadId: "thread-1", cursor: "2" },
          { threadId: "thread-1", cursor: "3" },
          { threadId: "thread-1", cursor: "4" },
          { threadId: "thread-slow", cursor: "7" },
          { threadId: "thread-superseded", cursor: "8" },
          { threadId: "thread-queued", cursor: "9" },
          { threadId: "thread-malformed", cursor: "10" },
        ])
          expect(acknowledgements).not.toContainEqual(expect.objectContaining(rejected))
        expect(commands.some((command) => command._tag === "Cancel")).toBe(false)
      }),
    ).pipe(
      Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
      Effect.provideService(Metric.MetricRegistry, new Map()),
    )
    const completions = observations.filter((record) => String(record.message).startsWith("hosted."))
    const count = (message: string) => completions.filter((record) => record.message === message).length
    expect({
      attachSuccess: count("hosted.attach.success"),
      attachFailure: count("hosted.attach.failure"),
      targetResolutionSuccess: count("hosted.target_resolution.success"),
      targetResolutionFailure: count("hosted.target_resolution.failure"),
    }).toEqual({
      attachSuccess: 29,
      attachFailure: 7,
      targetResolutionSuccess: 10,
      targetResolutionFailure: 4,
    })
    const threadMilestones = completions.filter(
      (record) =>
        record.message === "hosted.attach.success" ||
        record.message === "hosted.attach.failure" ||
        record.message === "hosted.target_resolution.success" ||
        record.message === "hosted.target_resolution.failure",
    )
    const milestoneThreadIds = threadMilestones.map((record) => record.annotations["rika.thread.id"])
    expect(milestoneThreadIds.every((threadId) => typeof threadId === "string")).toBe(true)
    expect(milestoneThreadIds).toEqual(
      expect.arrayContaining(["thread-1", "thread-2", "thread-3", "thread-queued", "thread-malformed"]),
    )
    const selectedThreadIds = new Set([
      "thread-1",
      "thread-2",
      "thread-3",
      "thread-gated",
      "thread-superseded",
      "thread-newer",
      "thread-queued",
      "thread-failing",
      "thread-malformed",
      "thread-defect",
    ])
    for (const threadId of milestoneThreadIds) expect(selectedThreadIds.has(String(threadId))).toBe(true)
    const rendered = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.Unknown)))(completions)
    expect(rendered).toContain('"rika.thread.id"')
    for (const forbidden of [
      "hello",
      "defect mutation",
      "still on three",
      "quarantine mismatch",
      "payload",
      "ownerId",
      "defect-user",
      "defect-client",
      "defect-device",
    ])
      expect(rendered).not.toContain(forbidden)
  }),
)
