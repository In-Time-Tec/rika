import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Layer, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { TestClock } from "effect/testing"
import type { IdentityConfig } from "@rika/identity"
import { protocolVersion } from "@rika/product/client-protocol"
import { serveApi, browserThreadWebSocketPath } from "../../src/server/bun"
import { frame } from "../../src/hosted/thread/protocol-contract"
import { httpFixture } from "./http/fixture"
import "./browser-review/live.harness"

const config: IdentityConfig = {
  production: false,
  port: 0,
  baseUrl: "http://127.0.0.1",
  trustedOrigins: [],
  authSecret: Redacted.make("abcdefghijklmnopqrstuvwxyz-0123456789-ABCDEF"),
  resource: "http://127.0.0.1/api/v1",
  databaseUrl: Redacted.make("postgresql://unused"),
  databaseSsl: "disable",
}

it.effect(
  "browser socket requires exact Origin and cookie capability, rejects malformed frames and closes revoked idle sessions",
  () =>
    Effect.gen(function* () {
      const base = httpFixture.dependencies()
      let active = true
      let connections = 0
      const server = yield* serveApi({
        config,
        dependencies: {
          ...base,
          identity: {
            ...base.identity,
            browserSession: (request) =>
              Effect.succeed(
                request.headers.get("cookie") === "session=test"
                  ? { userId: "reader", expiresAt: Number.MAX_SAFE_INTEGER, validate: Effect.sync(() => active) }
                  : undefined,
              ),
          },
          threads: {
            issueTicket: () => Effect.die("Browser requested a device ticket"),
            connect: () => Effect.die("Browser connected as a device"),
            connectBrowser: (principal) =>
              Effect.sync(() => {
                expect(principal._tag).toBe("BrowserRead")
                connections++
                return {
                  validate: principal.validate,
                  receive: (message) =>
                    Effect.succeed([
                      frame({
                        _tag: "CommandRejected",
                        requestId: message.requestId,
                        reason: "forbidden",
                        message: "x".repeat(32 * 1024 * 1024),
                        details: {},
                      }),
                    ]),
                  outbound: Effect.never,
                  detach: Effect.void,
                }
              }),
          },
        },
      })
      const url = `http://127.0.0.1:${server.server.port}${browserThreadWebSocketPath}`
      const client = yield* HttpClient.HttpClient.pipe(Effect.provide(yield* Layer.build(FetchHttpClient.layer)))
      for (const origin of [undefined, "null", "http://127.0.0.1.evil", "https://evil.test"]) {
        const headers = new Headers({ cookie: "session=test", "sec-websocket-protocol": "rika.thread.v1" })
        if (origin !== undefined) headers.set("origin", origin)
        expect((yield* client.get(url, { headers })).status).toBe(403)
      }
      expect(
        (yield* client.get(url, { headers: { origin: config.baseUrl, "sec-websocket-protocol": "rika.thread.v1" } }))
          .status,
      ).toBe(401)
      expect(connections).toBe(0)
      const open = Effect.gen(function* () {
        const effectContext = yield* Effect.context<never>()

        const opened = yield* Deferred.make<void>()
        const closed = yield* Deferred.make<number>()
        // Bun transport boundary: real Origin/cookie handshake cannot use a browser constructor.
        // ast-grep-ignore: effect-prefer-socket
        const socket = new WebSocket(url.replace("http:", "ws:"), {
          protocols: ["rika.thread.v1"],
          headers: { origin: config.baseUrl, cookie: "session=test" },
        })
        socket.addEventListener("open", () => Effect.runSyncWith(effectContext)(Deferred.succeed(opened, undefined)))
        socket.addEventListener("close", (event) =>
          Effect.runSyncWith(effectContext)(Deferred.succeed(closed, event.code)),
        )
        yield* Effect.addFinalizer(() => Effect.sync(() => socket.close()))
        yield* Deferred.await(opened)
        return { socket, closed }
      })
      const malformed = yield* open
      malformed.socket.send(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
          protocolVersion,
          command: { _tag: "InventedMutation" },
        }),
      )
      expect(yield* Deferred.await(malformed.closed)).toBe(1003)
      const oversized = yield* open
      oversized.socket.send(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
          protocolVersion,
          requestId: "overflow",
          command: { _tag: "Detach" },
        }),
      )
      expect(yield* Deferred.await(oversized.closed)).toBe(1013)
      const idle = yield* open
      active = false
      yield* TestClock.adjust("1 second")
      expect(yield* Deferred.await(idle.closed)).toBe(1008)
      expect(connections).toBe(3)
    }),
)
