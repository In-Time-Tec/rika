// Rika transport connection for the desktop renderer (M3 Phase A).
// Wraps @rika/client connect() with the desktop client kind, a WebCrypto
// implementation of effect's Crypto service, and the renderer's WebSocket.
// The desktop main process owns Rika Server lifecycle; the renderer attaches
// to the running server. Run inside a Scope (the renderer's app root scope).
import { Crypto, Effect, Exit, Scope } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import { connect } from "@rika/client/connection"
import type * as ServerHandshake from "@rika/product/server-service-handshake"
import type * as ServerService from "@rika/product/server-service"
import { Sha256WebLayer } from "@rika/product/server-service-sha256-web"
import type { RikaEndpoint } from "./endpoint"

export type RikaConnection = {
  readonly connection: ServerService.Connection
  readonly close: Effect.Effect<void>
}

/** effect Crypto backed by the platform WebCrypto API (renderer + Bun both have it). */
export const WebCryptoLayer: Effect.Effect<Crypto.Crypto> = Effect.sync(() =>
  Crypto.make({
    randomBytes: (size) => {
      const bytes = new Uint8Array(size)
      globalThis.crypto.getRandomValues(bytes)
      return bytes
    },
    digest: (algorithm, data) =>
      Effect.tryPromise(() => globalThis.crypto.subtle.digest(algorithm, data).then((digest) => new Uint8Array(digest))),
  }),
)

export const connectRika = (endpoint: RikaEndpoint, identity: string): Effect.Effect<RikaConnection> =>
  Effect.gen(function* () {
    const crypto = yield* WebCryptoLayer
    const connectionScope = yield* Scope.make()
    yield* Effect.addFinalizer((exit) => Scope.close(connectionScope, exit))
    const connection = yield* connect({
      url: endpoint.url,
      identity,
      token: endpoint.token,
      clientKind: "desktop" as ServerHandshake.Handshake["clientKind"],
      connectRole: "reattach" as ServerHandshake.ConnectRole,
      role: "attached" as ServerService.Connection["role"],
    }).pipe(
      Effect.provideService(
        Socket.WebSocketConstructor,
        (url: string, protocols?: string | string[] | undefined) => new WebSocket(url, protocols),
      ),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provide(Sha256WebLayer),
      Scope.provide(connectionScope),
    )
    return {
      connection,
      close: Scope.close(connectionScope, Exit.void),
    }
  })
