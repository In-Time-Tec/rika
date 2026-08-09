import { Crypto, Deferred, Effect, Exit, Ref, Schema, Scope } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import { connect } from "@rika/client/connection"
import { makeInteractiveSupervisor, serverSocketFailure } from "@rika/client/reconnect"
import type * as ServerHandshake from "@rika/product/server-service-handshake"
import * as ServerService from "@rika/product/server-service"
import { Sha256WebLayer } from "@rika/product/server-service-sha256-web"

export type RikaConnectionInput = {
  readonly url: string
  readonly token: string
  readonly identity: string
}

export type RikaConnection = {
  readonly connection: ServerService.Connection
  readonly close: Effect.Effect<void>
}

export const WebCryptoLayer: Effect.Effect<Crypto.Crypto> = Effect.sync(() =>
  Crypto.make({
    randomBytes: (size) => {
      const bytes = new Uint8Array(size)
      globalThis.crypto.getRandomValues(bytes)
      return bytes
    },
    digest: (algorithm, data) =>
      Effect.tryPromise(() =>
        globalThis.crypto.subtle.digest(algorithm, Uint8Array.from(data)).then((digest) => new Uint8Array(digest)),
      ),
  }),
)

export const connectRika = (input: RikaConnectionInput) =>
  Effect.gen(function* () {
    const crypto = yield* WebCryptoLayer
    const connectionScope = yield* Scope.make()
    yield* Effect.addFinalizer((exit) => Scope.close(connectionScope, exit))

    const connectPhysical = () =>
      connect({
        url: input.url,
        identity: input.identity,
        token: input.token,
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
        Effect.mapError((error) =>
          Schema.is(ServerService.ServerServiceError)(error) ? error : serverSocketFailure(error, false),
        ),
      )

    const initial = yield* connectPhysical()
    const current = yield* Ref.make(initial)
    const logicalClosed = yield* Deferred.make<void>()
    const acquireReady = (_policy: "launch" | "reattach") =>
      connectPhysical().pipe(Effect.tap((connection) => Ref.set(current, connection)))
    const supervise = makeInteractiveSupervisor({ initial, acquireReady, logicalClosed })

    const connection: ServerService.Connection = {
      ...initial,
      ping: Ref.get(current).pipe(Effect.flatMap((physical) => physical.ping)),
      run: (operationInput, options) =>
        operationInput._tag === "Interactive" && options?.interactive !== undefined
          ? supervise(operationInput, options.interactive)
          : Ref.get(current).pipe(Effect.flatMap((physical) => physical.run(operationInput, options))),
      closed: Deferred.await(logicalClosed),
      close: Deferred.succeed(logicalClosed, undefined).pipe(
        Effect.andThen(Ref.get(current)),
        Effect.flatMap((physical) => physical.close),
        Effect.ensuring(Scope.close(connectionScope, Exit.void)),
      ),
    }
    return {
      connection,
      close: connection.close,
    }
  })
