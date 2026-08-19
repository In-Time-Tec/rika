import { Context, Effect, Layer, Schema } from "effect"
import type { PtyCreate, PtyInput, PtyReconnect, PtyResize, PtyTranscriptChunk } from "./protocol"

export interface PtyRecord extends PtyCreate {
  readonly connected: boolean
  readonly cursor: number
  readonly transcript: ReadonlyArray<PtyTranscriptChunk>
  readonly revision: number
}

export interface PtyConnection {
  readonly ptyId: string
  readonly connected: boolean
  readonly cursor: number
  readonly transcript: ReadonlyArray<PtyTranscriptChunk>
}

export class PtyError extends Schema.TaggedError<PtyError>()("PtyError", {
  kind: Schema.Literals(["conflict", "driver", "missing", "protocol", "storage"]),
  message: Schema.String,
}) {}

export interface PtyRepositoryInterface {
  readonly get: (ptyId: string) => Effect.Effect<PtyRecord | undefined, PtyError>
  readonly insert: (record: PtyRecord) => Effect.Effect<PtyRecord, PtyError>
  readonly update: (record: PtyRecord, expectedRevision: number) => Effect.Effect<PtyRecord, PtyError>
}

export class PtyRepository extends Context.Service<PtyRepository, PtyRepositoryInterface>()(
  "@rika/remote-execution/pty/PtyRepository",
) {}

export interface PtyDriverInterface {
  readonly create: (request: PtyCreate) => Effect.Effect<void, PtyError>
  readonly input: (request: PtyInput) => Effect.Effect<void, PtyError>
  readonly resize: (request: PtyResize) => Effect.Effect<void, PtyError>
  readonly disconnect: (ptyId: string) => Effect.Effect<void, PtyError>
  readonly reconnect: (ptyId: string) => Effect.Effect<void, PtyError>
}

export class PtyDriver extends Context.Service<PtyDriver, PtyDriverInterface>()(
  "@rika/remote-execution/pty/PtyDriver",
) {}

export interface Interface {
  readonly create: (request: PtyCreate) => Effect.Effect<PtyConnection, PtyError>
  readonly input: (request: PtyInput) => Effect.Effect<void, PtyError>
  readonly resize: (request: PtyResize) => Effect.Effect<PtyConnection, PtyError>
  readonly disconnect: (ptyId: string) => Effect.Effect<PtyConnection, PtyError>
  readonly reconnect: (request: PtyReconnect) => Effect.Effect<PtyConnection, PtyError>
  readonly recordOutput: (ptyId: string, data: string) => Effect.Effect<PtyTranscriptChunk, PtyError>
}

export class PtyManager extends Context.Service<PtyManager, Interface>()("@rika/remote-execution/pty/PtyManager") {}

const connection = (
  record: PtyRecord,
  transcript: ReadonlyArray<PtyTranscriptChunk> = record.transcript,
): PtyConnection => ({
  ptyId: record.ptyId,
  connected: record.connected,
  cursor: record.cursor,
  transcript,
})

const sameCreate = (record: PtyRecord, request: PtyCreate) =>
  record.command === request.command &&
  record.cwd === request.cwd &&
  record.cols === request.cols &&
  record.rows === request.rows

export const layer: Layer.Layer<PtyManager, never, PtyDriver | PtyRepository> = Layer.effect(
  PtyManager,
  Effect.gen(function* () {
    const repository = yield* PtyRepository
    const driver = yield* PtyDriver

    const load = Effect.fn("PtyManager.load")(function* (ptyId: string) {
      const record = yield* repository.get(ptyId)
      if (record === undefined) return yield* PtyError.make({ kind: "missing", message: `PTY ${ptyId} does not exist` })
      return record
    })

    const create = Effect.fn("PtyManager.create")(function* (request: PtyCreate) {
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

    const input = Effect.fn("PtyManager.input")(function* (request: PtyInput) {
      const record = yield* load(request.ptyId)
      if (!record.connected)
        return yield* PtyError.make({ kind: "protocol", message: `PTY ${request.ptyId} is disconnected` })
      yield* driver.input(request)
    })

    const resize = Effect.fn("PtyManager.resize")(function* (request: PtyResize) {
      const record = yield* load(request.ptyId)
      if (record.cols === request.cols && record.rows === request.rows) return connection(record)
      yield* driver.resize(request)
      return connection(
        yield* repository.update({ ...record, cols: request.cols, rows: request.rows }, record.revision),
      )
    })

    const disconnect = Effect.fn("PtyManager.disconnect")(function* (ptyId: string) {
      const record = yield* load(ptyId)
      if (!record.connected) return connection(record)
      yield* driver.disconnect(ptyId)
      return connection(yield* repository.update({ ...record, connected: false }, record.revision))
    })

    const reconnect = Effect.fn("PtyManager.reconnect")(function* (request: PtyReconnect) {
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

    const recordOutput = Effect.fn("PtyManager.recordOutput")(function* (ptyId: string, data: string) {
      const record = yield* load(ptyId)
      const chunk = { cursor: record.cursor + 1, data }
      yield* repository.update(
        { ...record, cursor: chunk.cursor, transcript: [...record.transcript, chunk] },
        record.revision,
      )
      return chunk
    })

    return PtyManager.of({ create, input, resize, disconnect, reconnect, recordOutput })
  }),
)
