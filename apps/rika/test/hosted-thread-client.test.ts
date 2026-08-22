import * as BunSocket from "@effect/platform-bun/BunSocket"
import { expect, it } from "@effect/vitest"
import { ClientMessage, ServerFrame } from "@rika/product/client-protocol"
import { Context, Effect, Layer, Schema } from "effect"
import { ThreadClient } from "../src/hosted/hosted-contract"
import { layer } from "../src/hosted/hosted-thread-client"

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(ClientMessage))
const encode = Schema.encodeSync(Schema.fromJsonString(ServerFrame))

it.effect("creates, attaches, and submits through the authenticated Thread WebSocket protocol", () =>
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
                        _tag: "ThreadSnapshot",
                        requestId: message.requestId,
                        threadId: message.command.threadId,
                        threadVersion: "1" as never,
                        cursor: "0" as never,
                        snapshot: {
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
                          turns: [],
                          units: [],
                          queue: { revision: 0, turns: [] },
                          pendingAuthorizations: [],
                        },
                      },
                    }),
                  )
                  return
                }
                if (message.command._tag === "SubmitPrompt")
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
                        result: { _tag: "Applied" },
                      },
                    }),
                  )
              },
            },
          }),
        ),
        (runningServer) => Effect.promise(() => runningServer.stop(true)),
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
          executorKind: "e2b",
        }),
      ).toBe("thread-1")
      expect(
        yield* threads.submit({
          ticket,
          threadId: "thread-1",
          request: { prompt: ["hello"], mode: "low" },
          commandId: "submit-1",
        }),
      ).toEqual({ commandId: "submit-1", status: "queued" })
      expect(commands.map((command) => command._tag)).toEqual(["CreateThread", "AttachThread", "SubmitPrompt"])
      expect(commands[2]).toMatchObject({ expectedThreadVersion: "1", text: "hello", mode: "low" })
      expect(offeredProtocols).toEqual([
        "rika.thread.v1, rika.ticket.single-use-ticket",
        "rika.thread.v1, rika.ticket.single-use-ticket",
      ])
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
        (runningServer) => Effect.promise(() => runningServer.stop(true)),
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
          executorKind: "e2b",
        }),
      )
      expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "denied", message: "owner denied" } })
    }),
  ),
)
