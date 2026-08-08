import * as ServerHandshake from "@rika/product/server-service-handshake"
import * as ServerService from "@rika/product/server-service"
import { Effect, Function } from "effect"
import { json } from "./server-protocol"

type ClientHandshakeOptions = {
  readonly identity: string
  readonly token: string
  readonly clientNonce: string
  readonly clientKind: ServerHandshake.Handshake["clientKind"]
  readonly connectRole: ServerHandshake.ConnectRole
}

export const makeClientHandshake = (options: ClientHandshakeOptions): Effect.Effect<ServerHandshake.Handshake> =>
  Effect.gen(function* () {
    const signed = {
      identity: options.identity,
      clientNonce: options.clientNonce,
      clientKind: options.clientKind,
      connectRole: options.connectRole,
      protocolVersion: ServerHandshake.HandshakeProtocol.protocolVersion,
      buildIdentity: ServerHandshake.HandshakeProtocol.buildIdentity,
    }
    return {
      family: "rika-server",
      ...signed,
      clientProof: yield* ServerHandshake.HandshakeProtocol.clientProof(options.token, signed),
    }
  })

export const makeClientHandshakePair = (
  options: ClientHandshakeOptions,
): Effect.Effect<{ readonly handshake: string; readonly signedHandshake: ServerHandshake.Handshake }> =>
  Effect.gen(function* () {
    const signedHandshake = yield* makeClientHandshake(options)
    return { handshake: json(signedHandshake), signedHandshake }
  })

const verifyServerHandshakeImpl = (
  token: string,
  client: ServerHandshake.Handshake,
  server: ServerService.ServerMessage,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    return (
      (server._tag === "accepted" || server._tag === "incompatible") &&
      server.identity === client.identity &&
      server.clientNonce === client.clientNonce &&
      (yield* ServerHandshake.HandshakeProtocol.verifyServerProof(token, client, server))
    )
  })

export const verifyServerHandshake: {
  (client: ServerHandshake.Handshake, server: ServerService.ServerMessage): (token: string) => Effect.Effect<boolean>
  (token: string, client: ServerHandshake.Handshake, server: ServerService.ServerMessage): Effect.Effect<boolean>
} = Function.dual(3, verifyServerHandshakeImpl)
