import { Context, Effect, Layer, Schema } from "effect"
import type { PtyCreate, PtyInput, PtyReconnect, PtyResize, PtyTranscriptChunk } from "./protocol"

export interface Record extends PtyCreate {
  readonly connected: boolean
  readonly cursor: number
  readonly transcript: ReadonlyArray<PtyTranscriptChunk>
  readonly revision: number
}

export interface Connection {
  readonly ptyId: string
  readonly connected: boolean
  readonly cursor: number
  readonly transcript: ReadonlyArray<PtyTranscriptChunk>
}

export class PtyError extends Schema.TaggedError<PtyError>()("PtyError", {
  kind: Schema.Literals(["conflict", "driver", "missing", "protocol", "storage"]),
  message: Schema.String,
}) {}

export interface RepositoryInterface {
  readonly get: (ptyId: string) => Effect.Effect<Record | undefined, PtyError>
  readonly insert: (record: Record) => Effect.Effect<Record, PtyError>
  readonly update: (record: Record, expectedRevision: number) => Effect.Effect<Record, PtyError>
}

export class Repository extends Context.Service<Repository, RepositoryInterface>()(
  "@rika/remote-execution/pty/Repository",
) {}

export interface DriverInterface {
  readonly create: (request: PtyCreate) => Effect.Effect<void, PtyError>
  readonly input: (request: PtyInput) => Effect.Effect<void, PtyError>
  readonly resize: (request: PtyResize) => Effect.Effect<void, PtyError>
  readonly disconnect: (ptyId: string) => Effect.Effect<void, PtyError>
  readonly reconnect: (ptyId: string) => Effect.Effect<void, PtyError>
}

export class Driver extends Context.Service<Driver, DriverInterface>()("@rika/remote-execution/pty/Driver") {}

export interface Interface {
  readonly create: (request: PtyCreate) => Effect.Effect<Connection, PtyError>
  readonly input: (request: PtyInput) => Effect.Effect<void, PtyError>
  readonly resize: (request: PtyResize) => Effect.Effect<Connection, PtyError>
  readonly disconnect: (ptyId: string) => Effect.Effect<Connection, PtyError>
  readonly reconnect: (request: PtyReconnect) => Effect.Effect<Connection, PtyError>
  readonly recordOutput: (ptyId: string, data: string) => Effect.Effect<PtyTranscriptChunk, PtyError>
}

export class Manager extends Context.Service<Manager, Interface>()("@rika/remote-execution/pty/Manager") {}

const connection = (
  record: Record,
  transcript: ReadonlyArray<PtyTranscriptChunk> = record.transcript,
): Connection => ({
  ptyId: record.ptyId,
  connected: record.connected,
  cursor: record.cursor,
  transcript,
})

const sameCreate = (record: Record, request: PtyCreate) =>
  record.command === request.command &&
  record.cwd === request.cwd &&
  record.cols === request.cols &&
  record.rows === request.rows

export const layer: Layer.Layer<Manager, never, Driver | Repository> = Layer.effect(
  Manager,
  Effect.gen(function* () {
    const repository = yield* Repository
    const driver = yield* Driver

    const load = Effect.fn("Pty.load")(function* (ptyId: string) {
      const record = yield* repository.get(ptyId)
      if (record === undefined) return yield* PtyError.make({ kind: "missing", message: `PTY ${ptyId} does not exist` })
      return record
    })

    const create = Effect.fn("Pty.create")(function* (request: PtyCreate) {
      const existing = yield* repository.get(request.ptyId)
      if (existing !== undefined) {
        if (!sameCreate(existing, request))
          return yield* PtyError.make({
            kind: "conflict",
            message: `PTY ${request.ptyId} already has different settings`,
          })
        return connection(existing)
      }
      yield* driver.create(request)
      const record = yield* repository.insert({
        ...request,
        connected: true,
        cursor: 0,
        transcript: [],
        revision: 0,
      })
      return connection(record)
    })

    const input = Effect.fn("Pty.input")(function* (request: PtyInput) {
      const record = yield* load(request.ptyId)
      if (!record.connected)
        return yield* PtyError.make({ kind: "protocol", message: `PTY ${request.ptyId} is disconnected` })
      yield* driver.input(request)
    })

    const resize = Effect.fn("Pty.resize")(function* (request: PtyResize) {
      const record = yield* load(request.ptyId)
      if (record.cols === request.cols && record.rows === request.rows) return connection(record)
      yield* driver.resize(request)
      return connection(
        yield* repository.update({ ...record, cols: request.cols, rows: request.rows }, record.revision),
      )
    })

    const disconnect = Effect.fn("Pty.disconnect")(function* (ptyId: string) {
      const record = yield* load(ptyId)
      if (!record.connected) return connection(record)
      yield* driver.disconnect(ptyId)
      return connection(yield* repository.update({ ...record, connected: false }, record.revision))
    })

    const reconnect = Effect.fn("Pty.reconnect")(function* (request: PtyReconnect) {
      const record = yield* load(request.ptyId)
      if (request.cursor > record.cursor)
        return yield* PtyError.make({ kind: "protocol", message: `PTY ${request.ptyId} cursor is ahead of transcript` })
      let active = record
      if (!record.connected) {
        yield* driver.reconnect(request.ptyId)
        active = yield* repository.update({ ...record, connected: true }, record.revision)
      }
      return connection(
        active,
        active.transcript.filter((chunk) => chunk.cursor > request.cursor),
      )
    })

    const recordOutput = Effect.fn("Pty.recordOutput")(function* (ptyId: string, data: string) {
      const record = yield* load(ptyId)
      const chunk = { cursor: record.cursor + 1, data }
      yield* repository.update(
        { ...record, cursor: chunk.cursor, transcript: [...record.transcript, chunk] },
        record.revision,
      )
      return chunk
    })

    return Manager.of({ create, input, resize, disconnect, reconnect, recordOutput })
  }),
)
