import * as ResidentHandshake from "@rika/product/resident-service-handshake"
import * as ResidentService from "@rika/product/resident-service"
import { Function } from "effect"
import { json } from "./resident-protocol"

type ClientHandshakeOptions = {
  readonly identity: string
  readonly token: string
  readonly clientNonce: string
  readonly clientKind: ResidentHandshake.Handshake["clientKind"]
  readonly connectRole: ResidentHandshake.ConnectRole
}

export const makeClientHandshake = (options: ClientHandshakeOptions): ResidentHandshake.Handshake => {
  const signed = {
    identity: options.identity,
    clientNonce: options.clientNonce,
    clientKind: options.clientKind,
    connectRole: options.connectRole,
    protocolVersion: ResidentHandshake.HandshakeProtocol.protocolVersion,
    buildIdentity: ResidentHandshake.HandshakeProtocol.buildIdentity,
  }
  return {
    family: "rika-resident",
    ...signed,
    clientProof: ResidentHandshake.HandshakeProtocol.clientProof(options.token, signed),
  }
}

export const makeClientHandshakePair = (options: ClientHandshakeOptions) => {
  const signedHandshake = makeClientHandshake(options)
  return { handshake: json(signedHandshake), signedHandshake }
}

const verifyServerHandshakeImpl = (
  token: string,
  client: ResidentHandshake.Handshake,
  server: ResidentService.ServerMessage,
): boolean =>
  (server._tag === "accepted" || server._tag === "incompatible") &&
  server.identity === client.identity &&
  server.clientNonce === client.clientNonce &&
  ResidentHandshake.HandshakeProtocol.verifyServerProof(token, client, server)

export const verifyServerHandshake: {
  (client: ResidentHandshake.Handshake, server: ResidentService.ServerMessage): (token: string) => boolean
  (token: string, client: ResidentHandshake.Handshake, server: ResidentService.ServerMessage): boolean
} = Function.dual(3, verifyServerHandshakeImpl)
