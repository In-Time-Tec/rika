import * as ServerService from "@rika/product/server-service"
import { Function, Schema } from "effect"

const decodeClientImpl = Schema.decodeUnknownSync(ServerService.ClientMessage)
export const decodeClient: {
  (): (input: unknown) => ServerService.ClientMessage
  (input: unknown): ServerService.ClientMessage
} = Function.dual((args) => args.length >= 1, decodeClientImpl)
const decodeServerImpl = Schema.decodeUnknownSync(ServerService.ServerMessage)
export const decodeServer: {
  (): (input: unknown) => ServerService.ServerMessage
  (input: unknown): ServerService.ServerMessage
} = Function.dual((args) => args.length >= 1, decodeServerImpl)
const jsonImpl = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
export const json: {
  (): (input: unknown) => string
  (input: unknown): string
} = Function.dual((args) => args.length >= 1, jsonImpl)
const parseImpl = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))
export const parse: {
  (): (input: string) => unknown
  (input: string): unknown
} = Function.dual((args) => args.length >= 1, parseImpl)
export const maxFrameBytes = 1_048_576
export const defaultOutboundCapacity = 1_024
export const maxServerMessageChunks = 16
export const maxClientMessageChunks = 16
