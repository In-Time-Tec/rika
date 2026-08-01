import * as ResidentService from "@rika/product/resident-service"
import { Function, Schema } from "effect"

const decodeClientImpl = Schema.decodeUnknownSync(ResidentService.ClientMessage)
export const decodeClient: {
  (): (input: unknown) => ResidentService.ClientMessage
  (input: unknown): ResidentService.ClientMessage
} = Function.dual((args) => args.length >= 1, decodeClientImpl)
const decodeServerImpl = Schema.decodeUnknownSync(ResidentService.ServerMessage)
export const decodeServer: {
  (): (input: unknown) => ResidentService.ServerMessage
  (input: unknown): ResidentService.ServerMessage
} = Function.dual((args) => args.length >= 1, decodeServerImpl)
const jsonImpl = Schema.encodeSync(Schema.UnknownFromJsonString)
export const json: {
  (): (input: unknown) => string
  (input: unknown): string
} = Function.dual((args) => args.length >= 1, jsonImpl)
const parseImpl = Schema.decodeSync(Schema.UnknownFromJsonString)
export const parse: {
  (): (input: string) => unknown
  (input: string): unknown
} = Function.dual((args) => args.length >= 1, parseImpl)
export const maxFrameBytes = 1_048_576
export const defaultOutboundCapacity = 1_024
export const maxServerMessageChunks = 16
export const maxClientMessageChunks = 16
