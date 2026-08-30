import { Deferred, Effect, Layer, PubSub, Semaphore, Stream } from "effect"
import type { PtyCreate, PtyGap, PtyInput, PtyReconnect, PtyResize, PtyTranscriptChunk } from "../../protocol/messages"
import { controlOutput } from "./pty-driver"
import { digestName } from "./pty-repository"
import {
  Driver,
  Manager,
  OutputChunkLimit,
  PtyError,
  Repository,
  TranscriptLimit,
  type Connection,
  type Event,
  type Exit,
  type Output,
  type Record,
} from "./pty-types"

export * from "./pty-types"
export { driverLayer, detectCapabilities, liveCapabilities } from "./pty-driver"
export { repositoryLayer } from "./pty-repository"

export const testing = { controlOutput, digestName } as const

const connection = (
  record: Record,
  transcript: ReadonlyArray<PtyTranscriptChunk> = record.transcript,
  gap: PtyGap | null = null,
): Connection => ({
  ptyId: record.ptyId,
  command: record.command,
  cwd: record.cwd,
  cols: record.cols,
  rows: record.rows,
  connected: record.connected,
  terminated: record.terminated,
  cursor: record.cursor,
  transcript,
  gap,
})

const sameCreate = (record: Record, request: PtyCreate) =>
  record.command === request.command && record.cwd === request.cwd

export const layer: Layer.Layer<Manager, never, Driver | Repository> = Layer.effect(
  Manager,
  Effect.gen(function* () {
    const repository = yield* Repository
    const driver = yield* Driver
    const operation = yield* Semaphore.make(1)
    const changes = yield* PubSub.bounded<Event>(TranscriptLimit)

    const load = Effect.fn("Pty.load")(function* (ptyId: string) {
      const record = yield* repository.get(ptyId)
      if (record === undefined) return yield* PtyError.make({ kind: "missing", message: `PTY ${ptyId} does not exist` })
      return record
    })

    const recordOutput = Effect.fn("Pty.recordOutput")(function* (ptyId: string, data: string) {
      if (data.length > OutputChunkLimit)
        return yield* PtyError.make({ kind: "protocol", message: `PTY ${ptyId} output chunk exceeds the limit` })
      return yield* operation.withPermits(1)(
        Effect.gen(function* () {
          const record = yield* load(ptyId)
          if (record.terminated)
            return yield* PtyError.make({ kind: "protocol", message: `PTY ${ptyId} is terminated` })
          const chunk = { cursor: record.cursor + 1, data }
          const transcript = [...record.transcript, chunk].slice(-TranscriptLimit)
          const updated = yield* repository.update({ ...record, cursor: chunk.cursor, transcript }, record.revision)
          if (updated.connected) yield* PubSub.publish(changes, { _tag: "Output", ptyId, chunk })
          return chunk
        }),
      )
    })

    const recordExit = Effect.fn("Pty.recordExit")(function* (ptyId: string) {
      yield* operation.withPermits(1)(
        Effect.gen(function* () {
          const record = yield* load(ptyId)
          if (record.terminated) return
          const updated = yield* repository.update({ ...record, connected: false, terminated: true }, record.revision)
          yield* PubSub.publish(changes, { _tag: "Terminated", ptyId, cursor: updated.cursor })
        }),
      )
    })

    const output: Output = (ptyId, data) => recordOutput(ptyId, data).pipe(Effect.asVoid)
    const exit: Exit = recordExit

    const create = Effect.fn("Pty.create")(function* (request: PtyCreate) {
      return yield* operation.withPermits(1)(
        Effect.gen(function* () {
          const existing = yield* repository.get(request.ptyId)
          if (existing !== undefined) {
            if (!sameCreate(existing, request))
              return yield* PtyError.make({
                kind: "conflict",
                message: `PTY ${request.ptyId} already has different settings`,
              })
            if (existing.terminated) return connection(existing)
            yield* driver.reconnect(existing.ptyId, output, exit)
            return connection(
              existing.connected
                ? existing
                : yield* repository.update({ ...existing, connected: true }, existing.revision),
            )
          }
          const gate = yield* Deferred.make<void>()
          yield* driver.create(
            request,
            (ptyId, data) => Deferred.await(gate).pipe(Effect.andThen(output(ptyId, data))),
            (ptyId) => Deferred.await(gate).pipe(Effect.andThen(exit(ptyId))),
          )
          const record = yield* repository.insert({
            ...request,
            connected: true,
            terminated: false,
            cursor: 0,
            transcript: [],
            revision: 0,
          })
          yield* Deferred.succeed(gate, undefined)
          return connection(record)
        }),
      )
    })

    const input = Effect.fn("Pty.input")(function* (request: PtyInput) {
      yield* operation.withPermits(1)(
        Effect.gen(function* () {
          const record = yield* load(request.ptyId)
          if (!record.connected || record.terminated)
            return yield* PtyError.make({ kind: "protocol", message: `PTY ${request.ptyId} is not connected` })
          yield* driver.input(request)
        }),
      )
    })

    const resize = Effect.fn("Pty.resize")(function* (request: PtyResize) {
      return yield* operation.withPermits(1)(
        Effect.gen(function* () {
          const record = yield* load(request.ptyId)
          if (!record.connected || record.terminated)
            return yield* PtyError.make({ kind: "protocol", message: `PTY ${request.ptyId} is not connected` })
          if (record.cols === request.cols && record.rows === request.rows) return connection(record)
          yield* driver.resize(request)
          return connection(
            yield* repository.update({ ...record, cols: request.cols, rows: request.rows }, record.revision),
          )
        }),
      )
    })

    const disconnect = Effect.fn("Pty.disconnect")(function* (ptyId: string) {
      return yield* operation.withPermits(1)(
        Effect.gen(function* () {
          const record = yield* load(ptyId)
          if (!record.connected) return connection(record)
          return connection(yield* repository.update({ ...record, connected: false }, record.revision))
        }),
      )
    })

    const disconnectAll = operation.withPermits(1)(
      Effect.gen(function* () {
        for (const record of yield* repository.list) {
          if (record.connected && !record.terminated)
            yield* repository.update({ ...record, connected: false }, record.revision)
        }
      }),
    )

    const reconnect = Effect.fn("Pty.reconnect")(function* (request: PtyReconnect) {
      return yield* operation.withPermits(1)(
        Effect.gen(function* () {
          const record = yield* load(request.ptyId)
          if (record.terminated)
            return yield* PtyError.make({ kind: "protocol", message: `PTY ${request.ptyId} is terminated` })
          if (request.cursor > record.cursor)
            return yield* PtyError.make({
              kind: "protocol",
              message: `PTY ${request.ptyId} cursor is ahead of transcript`,
            })
          yield* driver.reconnect(request.ptyId, output, exit)
          const active = record.connected
            ? record
            : yield* repository.update({ ...record, connected: true }, record.revision)
          const first = active.transcript[0]?.cursor ?? active.cursor + 1
          const gap = request.cursor + 1 < first ? { fromCursor: request.cursor + 1, toCursor: first - 1 } : null
          return connection(
            active,
            active.transcript.filter((chunk) => chunk.cursor > request.cursor),
            gap,
          )
        }),
      )
    })

    const terminate = Effect.fn("Pty.terminate")(function* (ptyId: string) {
      return yield* operation.withPermits(1)(
        Effect.gen(function* () {
          const record = yield* load(ptyId)
          if (record.terminated) return connection(record)
          yield* driver.terminate(ptyId)
          const updated = yield* repository.update({ ...record, connected: false, terminated: true }, record.revision)
          return connection(updated)
        }),
      )
    })

    const cursor = Effect.map(repository.list, (records) =>
      records.reduce((latest, record) => Math.max(latest, record.cursor), 0),
    )
    const events = Stream.fromPubSub(changes)

    return Manager.of({
      create,
      input,
      resize,
      disconnect,
      disconnectAll,
      reconnect,
      terminate,
      recordOutput,
      cursor,
      events,
    })
  }),
)
