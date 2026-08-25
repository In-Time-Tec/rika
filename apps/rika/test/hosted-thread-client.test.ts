import * as BunSocket from "@effect/platform-bun/BunSocket"
import { expect, it } from "@effect/vitest"
import { ClientMessage, ServerFrame } from "@rika/product/client-protocol"
import * as ExecutionProjection from "@rika/product/execution-projection"
import { Context, Effect, Layer, Schema } from "effect"
import { ThreadClient } from "../src/hosted/hosted-contract"
import { layer } from "../src/hosted/hosted-thread-client"

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
                        _tag: "CommandAdmitted",
                        requestId: message.requestId,
                        commandId: message.command.commandId,
                        threadId: "thread-1" as never,
                        threadVersion: "1" as never,
                      },
                    }),
                  )
                  socket.send(
                    encode({
                      protocolVersion: 1,
                      payload: {
                        _tag: "CommandAccepted",
                        requestId: message.requestId,
                        commandId: message.command.commandId,
                        threadId: "thread-1" as never,
                        threadVersion: "1" as never,
                        cursor: "0" as never,
                        result: { _tag: "ThreadCreated", threadId: "thread-1" as never },
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
                        snapshotThreadVersion: "1" as never,
                        snapshotCursor: "0" as never,
                        threadVersion: "1" as never,
                        cursor: "0" as never,
                        snapshot: {
                          executorKind: "runner",
                          view: {
                            thread: {
                              id: "thread-1" as never,
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
                        threadId: "thread-1" as never,
                        threadVersion: "2" as never,
                        cursor: "0" as never,
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
                            threadId: "thread-1" as never,
                            sequence: "1" as never,
                            cursor: "1" as never,
                            threadVersion: "2" as never,
                            createdAt: "2026-08-23T00:00:00.000Z",
                            event: {
                              _tag: "SubmissionAdmitted",
                              threadId: "thread-1" as never,
                              turnId: "turn-1" as never,
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
                        threadId: "thread-1" as never,
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
        expiresAt: "2026-08-21T07:00:00.000Z" as never,
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
                socket.send(
                  encode({
                    protocolVersion: 1,
                    payload: {
                      _tag: "CommandRejected",
                      requestId: message.requestId,
                      ...(commandId === undefined ? {} : { commandId }),
                      reason: "forbidden",
                      currentCursor: "0" as never,
                      message: "owner denied",
                      details: {},
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
            expiresAt: "2026-08-21T07:00:00.000Z" as never,
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
                    protocolVersion: 1,
                    payload: {
                      _tag: "CommandAccepted",
                      requestId: message.requestId,
                      commandId: "another-command" as never,
                      threadId: "thread-1" as never,
                      threadVersion: "1" as never,
                      cursor: "0" as never,
                      result: { _tag: "ThreadCreated", threadId: "thread-1" as never },
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
            expiresAt: "2026-08-21T07:00:00.000Z" as never,
            websocketUrl: `ws://127.0.0.1:${server.port}`,
            protocol: "rika.thread.v1",
          },
          commandId: "create-1",
          owner: { kind: "personal" },
          executorKind: "orb",
        }),
      )
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { kind: "protocol", message: expect.stringContaining("command identity") },
      })
    }),
  ),
)
