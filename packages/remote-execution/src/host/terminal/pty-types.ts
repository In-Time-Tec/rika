import { Context, Effect, Schema, Stream } from "effect"
import {
  PtyCreate,
  PtyTranscriptChunk,
  type PtyGap,
  type PtyInput,
  type PtyReconnect,
  type PtyResize,
} from "../../protocol/messages"

export const TranscriptLimit = 256
export const OutputChunkLimit = 16_384

export const StoredRecord = Schema.Struct({
  ...PtyCreate.fields,
  connected: Schema.Boolean,
  terminated: Schema.Boolean,
  cursor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  transcript: Schema.Array(PtyTranscriptChunk),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})

const Snapshot = Schema.Struct({
  version: Schema.Literal(1),
  records: Schema.Array(StoredRecord),
})

export const SnapshotCodec = {
  decode: Schema.decodeUnknownEffect(Schema.fromJsonString(Snapshot)),
  encode: Schema.encodeEffect(Schema.fromJsonString(Snapshot)),
}

export interface Record extends PtyCreate {
  readonly connected: boolean
  readonly terminated: boolean
  readonly cursor: number
  readonly transcript: ReadonlyArray<PtyTranscriptChunk>
  readonly revision: number
}

export interface Connection extends PtyCreate {
  readonly connected: boolean
  readonly terminated: boolean
  readonly cursor: number
  readonly transcript: ReadonlyArray<PtyTranscriptChunk>
  readonly gap: PtyGap | null
}

export type Event =
  | { readonly _tag: "Output"; readonly ptyId: string; readonly chunk: PtyTranscriptChunk }
  | { readonly _tag: "Terminated"; readonly ptyId: string; readonly cursor: number }

export class PtyError extends Schema.TaggedError<PtyError>()("PtyError", {
  kind: Schema.Literals(["conflict", "driver", "missing", "protocol", "storage"]),
  message: Schema.String,
}) {}

export interface RepositoryInterface {
  readonly get: (ptyId: string) => Effect.Effect<Record | undefined, PtyError>
  readonly list: Effect.Effect<ReadonlyArray<Record>, PtyError>
  readonly insert: (record: Record) => Effect.Effect<Record, PtyError>
  readonly update: (record: Record, expectedRevision: number) => Effect.Effect<Record, PtyError>
}

export class Repository extends Context.Service<Repository, RepositoryInterface>()(
  "@rika/remote-execution/host/terminal/pty-types/Repository",
) {}

export interface DriverInterface {
  readonly create: (request: PtyCreate, output: Output, exit: Exit) => Effect.Effect<void, PtyError>
  readonly input: (request: PtyInput) => Effect.Effect<void, PtyError>
  readonly resize: (request: PtyResize) => Effect.Effect<void, PtyError>
  readonly reconnect: (ptyId: string, output: Output, exit: Exit) => Effect.Effect<void, PtyError>
  readonly terminate: (ptyId: string) => Effect.Effect<void, PtyError>
}

export class Driver extends Context.Service<Driver, DriverInterface>()(
  "@rika/remote-execution/host/terminal/pty-types/Driver",
) {}

export interface Interface {
  readonly create: (request: PtyCreate) => Effect.Effect<Connection, PtyError>
  readonly input: (request: PtyInput) => Effect.Effect<void, PtyError>
  readonly resize: (request: PtyResize) => Effect.Effect<Connection, PtyError>
  readonly disconnect: (ptyId: string) => Effect.Effect<Connection, PtyError>
  readonly disconnectAll: Effect.Effect<void, PtyError>
  readonly reconnect: (request: PtyReconnect) => Effect.Effect<Connection, PtyError>
  readonly terminate: (ptyId: string) => Effect.Effect<Connection, PtyError>
  readonly recordOutput: (ptyId: string, data: string) => Effect.Effect<PtyTranscriptChunk, PtyError>
  readonly cursor: Effect.Effect<number, PtyError>
  readonly events: Stream.Stream<Event>
}

export class Manager extends Context.Service<Manager, Interface>()(
  "@rika/remote-execution/host/terminal/pty-types/Manager",
) {}

export type Output = (ptyId: string, data: string) => Effect.Effect<void, PtyError>
export type Exit = (ptyId: string) => Effect.Effect<void, PtyError>
