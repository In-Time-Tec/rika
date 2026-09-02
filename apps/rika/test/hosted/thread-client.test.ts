import * as BunSocket from "@effect/platform-bun/BunSocket"
import { expect, it } from "@effect/vitest"
import { ClientMessage, protocolVersion, ServerFrame } from "@rika/product/client-protocol"
import * as ExecutionProjection from "@rika/product/execution-projection"
import { CommandId, Sequence, ThreadEventCursor, ThreadId, ThreadVersion, Timestamp } from "@rika/product/hosted-model"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import * as Thread from "@rika/product/thread-record"
import type * as ThreadView from "@rika/product/thread-view"
import * as Turn from "@rika/product/turn-record"
import type * as TranscriptUnit from "@rika/transcript/transcript-unit"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import { Context, Effect, Layer, Schema } from "effect"
import { ThreadClient } from "../../src/hosted/contract"
import { layer } from "../../src/hosted/thread-client"

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(ClientMessage))
const encode = Schema.encodeSync(Schema.fromJsonString(ServerFrame))

let eventSequence = 0
const threadEvent = (event: InteractiveEvent) => {
  eventSequence += 1
  return encode({
    protocolVersion,
    payload: {
      _tag: "ThreadEvent",
      event: {
        threadId: ThreadId.make("thread-1"),
        sequence: Sequence.make(String(eventSequence)),
        cursor: ThreadEventCursor.make(String(eventSequence)),
        threadVersion: ThreadVersion.make("2"),
        createdAt: "2026-08-23T00:00:00.000Z",
        event,
      },
    },
  })
}

const assistantEntry = (turnId: string, position: number, text: string): TranscriptUnit.Unit => ({
  key: `assistant:${turnId}:${position}`,
  turnId,
  order: TranscriptOrdering.unitOrder(`assistant:${turnId}:${position}`, position),
  revision: position,
  content: { _tag: "Entry", role: "assistant", text },
})

const turnChange = (
  turnId: string,
  status: ThreadView.ThreadViewTurnRecord["status"],
): ThreadView.ThreadViewTurnChange => ({
  _tag: "UpsertTurn",
  turn: {
    kind: "agent",
    id: Turn.TurnId.make(turnId),
    threadId: Thread.ThreadId.make("thread-1"),
    prompt: turnId,
    status,
    author: { _tag: "Human" },
    lineage: { _tag: "Original" },
    createdAt: 1,
    updatedAt: 1,
  },
  projectionRevision: 0,
  usage: ExecutionProjection.emptyUsageState(),
})

const viewPatch = (
  revision: number,
  upsert: ReadonlyArray<TranscriptUnit.Unit>,
  turnChanges: ReadonlyArray<ThreadView.ThreadViewTurnChange>,
): InteractiveEvent => ({
  _tag: "ThreadViewPatch",
  patch: {
    threadId: Thread.ThreadId.make("thread-1"),
    baseRevision: revision - 1,
    revision,
    upsert,
    remove: [],
    turnChanges,
  },
})

it.effect("creates, attaches, submits, and replays admission through the authenticated Thread WebSocket protocol", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commands: Array<ClientMessage["command"]> = []
      const offeredProtocols: Array<string> = []
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve<{ readonly authenticated: true }>({
            hostname: "127.0.0.1",
            port: 0,
            fetch: (request, upgradeServer) => {
              offeredProtocols.push(request.headers.get("sec-websocket-protocol") ?? "")
              return upgradeServer.upgrade(request, {
                data: { authenticated: true },
                headers: { "sec-websocket-protocol": "rika.thread.v1" },
              })
                ? undefined
                : new Response("upgrade failed", { status: 500 })
            },
            websocket: {
              message: (socket, value) => {
                const message = decode(String(value))
                commands.push(message.command)
                if (message.command._tag === "CreateThread") {
                  socket.send(
                    encode({
                      protocolVersion,
                      payload: {
                        _tag: "CommandAdmitted",
                        requestId: message.requestId,
                        commandId: message.command.commandId,
                        threadId: ThreadId.make("thread-1"),
                        threadVersion: ThreadVersion.make("1"),
                      },
                    }),
                  )
                  socket.send(
                    encode({
                      protocolVersion,
                      payload: {
                        _tag: "CommandAccepted",
                        requestId: message.requestId,
                        commandId: message.command.commandId,
                        threadId: ThreadId.make("thread-1"),
                        threadVersion: ThreadVersion.make("1"),
                        cursor: ThreadEventCursor.make("0"),
                        result: { _tag: "ThreadCreated", threadId: ThreadId.make("thread-1") },
                      },
                    }),
                  )
                  return
                }
                if (message.command._tag === "AttachThread") {
                  socket.send(
                    encode({
                      protocolVersion,
                      payload: {
                        _tag: "ThreadAttached",
                        requestId: message.requestId,
                        threadId: message.command.threadId,
                        baseCursor: ThreadEventCursor.make("0"),
                        threadVersion: ThreadVersion.make("1"),
                        cursor: ThreadEventCursor.make("0"),
                        checkpoint: {
                          threadVersion: ThreadVersion.make("1"),
                          cursor: ThreadEventCursor.make("0"),
                          snapshot: {
                            executorKind: "runner",
                            view: {
                              thread: {
                                id: Thread.ThreadId.make("thread-1"),
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
                          },
                        },
                        events: [],
                        participants: [],
                      },
                    }),
                  )
                  return
                }
                if (
                  message.command._tag === "SubmitPrompt" ||
                  message.command._tag === "EnsureRepositoryService" ||
                  message.command._tag === "StopRepositoryService"
                ) {
                  const queued =
                    message.command._tag === "SubmitPrompt" && message.command.commandId === "submit-replay"
                  const accepted = encode({
                    protocolVersion,
                    payload: {
                      _tag: "CommandAccepted",
                      requestId: message.requestId,
                      commandId: message.command.commandId,
                      threadId: ThreadId.make("thread-1"),
                      threadVersion: ThreadVersion.make("2"),
                      cursor: ThreadEventCursor.make("0"),
                      result:
                        message.command._tag === "SubmitPrompt"
                          ? { _tag: "PromptAdmitted", status: queued ? "queued" : "accepted" }
                          : { _tag: "Applied" },
                    },
                  })
                  if (message.command._tag !== "SubmitPrompt") {
                    socket.send(accepted)
                    return
                  }
                  const turnId = queued ? "turn-2" : "turn-1"
                  const send = (event: InteractiveEvent) => socket.send(threadEvent(event))
                  // The durable admission event may land before the command acknowledgement.
                  send({
                    _tag: "SubmissionAdmitted",
                    threadId: Thread.ThreadId.make("thread-1"),
                    turnId: Turn.TurnId.make(turnId),
                    status: queued ? "queued" : "active",
                    submissionId: message.command.commandId,
                  })
                  socket.send(accepted)
                  // Text and settlement of the still-active earlier Turn must not be attributed to the queued one.
                  if (queued)
                    send(
                      viewPatch(1, [assistantEntry("turn-1", 1, "earlier turn")], [turnChange("turn-1", "completed")]),
                    )
                  send(viewPatch(2, [assistantEntry(turnId, 1, "draft")], [turnChange(turnId, "running")]))
                  send(
                    viewPatch(
                      3,
                      [assistantEntry(turnId, 1, `answer for ${message.command.text}`)],
                      [turnChange(turnId, "completed")],
                    ),
                  )
                  return
                }
                if (message.command._tag === "OpenPortal")
                  socket.send(
                    encode({
                      protocolVersion,
                      payload: {
                        _tag: "PortalOpened",
                        requestId: message.requestId,
                        threadId: ThreadId.make("thread-1"),
                        port: message.command.port,
                        url: "https://3000-orb.example.test",
                      },
                    }),
                  )
              },
            },
          }),
        ),
        (runningServer) => Effect.tryPromise(() => runningServer.stop(true)),
      )
      const context = yield* Layer.build(layer.pipe(Layer.provide(BunSocket.layerWebSocketConstructor)))
      const threads = Context.get(context, ThreadClient)
      const ticket = {
        ticket: "single-use-ticket",
        expiresAt: Timestamp.make("2026-08-21T07:00:00.000Z"),
        websocketUrl: `ws://127.0.0.1:${server.port}`,
        protocol: "rika.thread.v1" as const,
      }
      expect(
        yield* threads.create({
          ticket,
          commandId: "create-1",
          owner: { kind: "personal" },
          executorKind: "orb",
          archiveThreadId: "thread-before-create-1",
          workspaceSeedId: "seed-1",
        }),
      ).toBe("thread-1")
      expect(
        yield* threads.submit({
          ticket,
          threadId: "thread-1",
          request: { prompt: ["hello"], mode: "low" },
          commandId: "submit-1",
        }),
      ).toEqual({ commandId: "submit-1", status: "accepted", turnId: "turn-1", text: "answer for hello" })
      expect(
        yield* threads.submit({
          ticket,
          threadId: "thread-1",
          request: { prompt: ["replayed prompt"] },
          commandId: "submit-replay",
        }),
      ).toEqual({
        commandId: "submit-replay",
        status: "queued",
        turnId: "turn-2",
        text: "answer for replayed prompt",
      })
      yield* threads.ensureService({
        ticket,
        threadId: "thread-1",
        commandId: "service-start-1",
        service: { serviceId: "web", command: "bun", args: ["run", "dev"], cwd: "." },
      })
      yield* threads.stopService({
        ticket,
        threadId: "thread-1",
        commandId: "service-stop-1",
        serviceId: "web",
      })
      expect(
        yield* threads.openPortal({
          ticket,
          threadId: "thread-1",
          requestId: "portal-1",
          port: 3000,
        }),
      ).toBe("https://3000-orb.example.test")
      expect(commands.map((command) => command._tag)).toEqual([
        "CreateThread",
        "AttachThread",
        "SubmitPrompt",
        "AttachThread",
        "SubmitPrompt",
        "AttachThread",
        "EnsureRepositoryService",
        "AttachThread",
        "StopRepositoryService",
        "AttachThread",
        "OpenPortal",
      ])
      expect(commands[0]).toMatchObject({
        executorKind: "orb",
        archiveThreadId: "thread-before-create-1",
        workspaceSeedId: "seed-1",
      })
      expect(commands[2]).toMatchObject({
        threadId: "thread-1",
        expectedThreadVersion: "1",
        text: "hello",
        mode: "low",
      })
      expect(commands[6]).toMatchObject({
        threadId: "thread-1",
        expectedThreadVersion: "1",
        service: { serviceId: "web", command: "bun", args: ["run", "dev"], cwd: "." },
      })
      expect(commands[8]).toMatchObject({ threadId: "thread-1", expectedThreadVersion: "1", serviceId: "web" })
      expect(commands[10]).toMatchObject({ threadId: "thread-1", port: 3000 })
      expect(offeredProtocols).toEqual(Array.from({ length: 6 }, () => "rika.thread.v1, rika.ticket.single-use-ticket"))
    }),
  ),
)

it.effect("returns a hosted rejection instead of accepting a failed command", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve<{ readonly authenticated: true }>({
            hostname: "127.0.0.1",
            port: 0,
            fetch: (request, upgradeServer) =>
              upgradeServer.upgrade(request, {
                data: { authenticated: true },
                headers: { "sec-websocket-protocol": "rika.thread.v1" },
              })
                ? undefined
                : new Response("upgrade failed", { status: 500 }),
            websocket: {
              message: (socket, value) => {
                const message = decode(String(value))
                const commandId = message.command._tag === "CreateThread" ? message.command.commandId : undefined
                const rejection: Extract<ServerFrame["payload"], { readonly _tag: "CommandRejected" }> = {
                  _tag: "CommandRejected",
                  requestId: message.requestId,
                  reason: "forbidden",
                  currentCursor: ThreadEventCursor.make("0"),
                  message: "owner denied",
                  details: {},
                }
                socket.send(
                  encode({
                    protocolVersion,
                    payload: commandId === undefined ? rejection : { ...rejection, commandId },
                  }),
                )
              },
            },
          }),
        ),
        (runningServer) => Effect.tryPromise(() => runningServer.stop(true)),
      )
      const context = yield* Layer.build(layer.pipe(Layer.provide(BunSocket.layerWebSocketConstructor)))
      const threads = Context.get(context, ThreadClient)
      const result = yield* Effect.result(
        threads.create({
          ticket: {
            ticket: "single-use-ticket",
            expiresAt: Timestamp.make("2026-08-21T07:00:00.000Z"),
            websocketUrl: `ws://127.0.0.1:${server.port}`,
            protocol: "rika.thread.v1",
          },
          commandId: "create-1",
          owner: { kind: "personal" },
          executorKind: "orb",
        }),
      )
      expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "denied", message: "owner denied" } })
    }),
  ),
)

it.effect("rejects a command response with another durable command identity", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve<{ readonly authenticated: true }>({
            hostname: "127.0.0.1",
            port: 0,
            fetch: (request, upgradeServer) =>
              upgradeServer.upgrade(request, {
                data: { authenticated: true },
                headers: { "sec-websocket-protocol": "rika.thread.v1" },
              })
                ? undefined
                : new Response("upgrade failed", { status: 500 }),
            websocket: {
              message: (socket, value) => {
                const message = decode(String(value))
                if (message.command._tag !== "CreateThread") return
                socket.send(
                  encode({
                    protocolVersion,
                    payload: {
                      _tag: "CommandAccepted",
                      requestId: message.requestId,
                      commandId: CommandId.make("another-command"),
                      threadId: ThreadId.make("thread-1"),
                      threadVersion: ThreadVersion.make("1"),
                      cursor: ThreadEventCursor.make("0"),
                      result: { _tag: "ThreadCreated", threadId: ThreadId.make("thread-1") },
                    },
                  }),
                )
              },
            },
          }),
        ),
        (runningServer) => Effect.tryPromise(() => runningServer.stop(true)),
      )
      const context = yield* Layer.build(layer.pipe(Layer.provide(BunSocket.layerWebSocketConstructor)))
      const threads = Context.get(context, ThreadClient)
      const result = yield* Effect.result(
        threads.create({
          ticket: {
            ticket: "single-use-ticket",
            expiresAt: Timestamp.make("2026-08-21T07:00:00.000Z"),
            websocketUrl: `ws://127.0.0.1:${server.port}`,
            protocol: "rika.thread.v1",
          },
          commandId: "create-1",
          owner: { kind: "personal" },
          executorKind: "orb",
        }),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure.kind).toBe("protocol")
        expect(result.failure.message).toContain("command identity")
      }
    }),
  ),
)
