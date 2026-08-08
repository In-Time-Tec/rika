import * as ServerHandshake from "@rika/product/server-service-handshake"
import * as ServerService from "@rika/product/server-service"
import { Function } from "effect"
import { json } from "./server-protocol"

type ClientHandshakeOptions = {
  readonly identity: string
  readonly token: string
  readonly clientNonce: string
  readonly clientKind: ServerHandshake.Handshake["clientKind"]
  readonly connectRole: ServerHandshake.ConnectRole
}

export const makeClientHandshake = (options: ClientHandshakeOptions): ServerHandshake.Handshake => {
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
    clientProof: ServerHandshake.HandshakeProtocol.clientProof(options.token, signed),
  }
}

export const makeClientHandshakePair = (options: ClientHandshakeOptions) => {
  const signedHandshake = makeClientHandshake(options)
  return { handshake: json(signedHandshake), signedHandshake }
}

const verifyServerHandshakeImpl = (
  token: string,
  client: ServerHandshake.Handshake,
  server: ServerService.ServerMessage,
): boolean =>
  (server._tag === "accepted" || server._tag === "incompatible") &&
  server.identity === client.identity &&
  server.clientNonce === client.clientNonce &&
  ServerHandshake.HandshakeProtocol.verifyServerProof(token, client, server)

export const verifyServerHandshake: {
  (client: ServerHandshake.Handshake, server: ServerService.ServerMessage): (token: string) => boolean
  (token: string, client: ServerHandshake.Handshake, server: ServerService.ServerMessage): boolean
} = Function.dual(3, verifyServerHandshakeImpl)
