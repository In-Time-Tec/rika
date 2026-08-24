import * as BunSocket from "@effect/platform-bun/BunSocket"
import { expect, it } from "@effect/vitest"
import { ClientMessage, ServerFrame } from "@rika/product/client-protocol"
import * as ExecutionProjection from "@rika/product/execution-projection"
import { Sequence, ThreadEventCursor, ThreadId, ThreadVersion, Timestamp } from "@rika/product/hosted-model"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import { Context, Effect, Layer, Schema } from "effect"
import { ThreadClient } from "../../src/hosted/contract"
import { layer } from "../../src/hosted/thread-client"

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(ClientMessage))
const encode = Schema.encodeSync(Schema.fromJsonString(ServerFrame))

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
                      protocolVersion: 1,
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
                      protocolVersion: 1,
                      payload: {
                        _tag: "ThreadAttached",
                        requestId: message.requestId,
                        threadId: message.command.threadId,
                        snapshotThreadVersion: ThreadVersion.make("1"),
                        snapshotCursor: ThreadEventCursor.make("0"),
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
                  socket.send(
                    encode({
                      protocolVersion: 1,
                      payload: {
                        _tag: "CommandAccepted",
                        requestId: message.requestId,
                        commandId: message.command.commandId,
                        threadId: ThreadId.make("thread-1"),
                        threadVersion: ThreadVersion.make("2"),
                        cursor: ThreadEventCursor.make("0"),
                        result:
                          message.command._tag === "SubmitPrompt"
                            ? {
                                _tag: "PromptAdmitted",
                                status: message.command.commandId === "submit-replay" ? "queued" : "accepted",
                              }
                            : { _tag: "Applied" },
                      },
                    }),
                  )
                  if (message.command._tag === "SubmitPrompt" && message.command.commandId !== "submit-replay")
                    socket.send(
                      encode({
                        protocolVersion: 1,
                        payload: {
                          _tag: "ThreadEvent",
                          event: {
                            threadId: ThreadId.make("thread-1"),
                            sequence: Sequence.make("1"),
                            cursor: ThreadEventCursor.make("1"),
                            threadVersion: ThreadVersion.make("2"),
                            createdAt: "2026-08-23T00:00:00.000Z",
                            event: {
                              _tag: "SubmissionAdmitted",
                              threadId: Thread.ThreadId.make("thread-1"),
                              turnId: Turn.TurnId.make("turn-1"),
                              status: "active",
                              submissionId: message.command.commandId,
                            },
                          },
                        },
                      }),
                    )
                  return
                }
                if (message.command._tag === "OpenPortal")
                  socket.send(
                    encode({
                      protocolVersion: 1,
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
        }),
      ).toBe("thread-1")
      expect(
        yield* threads.submit({
          ticket,
          threadId: "thread-1",
          request: { prompt: ["hello"], mode: "low" },
          commandId: "submit-1",
        }),
      ).toEqual({ commandId: "submit-1", status: "accepted" })
      expect(
        yield* threads.submit({
          ticket,
          threadId: "thread-1",
          request: { prompt: ["replayed prompt"] },
          commandId: "submit-replay",
        }),
      ).toEqual({ commandId: "submit-replay", status: "queued" })
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
                    protocolVersion: 1,
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
