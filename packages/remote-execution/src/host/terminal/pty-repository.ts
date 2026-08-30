import { Crypto, Effect, Encoding, FileSystem, Layer, Ref, Schema, Semaphore } from "effect"
import type { Fence } from "../../protocol/messages"
import { PtyError, Repository, type Record, SnapshotCodec, StoredRecord } from "./pty-types"

const fenceIdentity = (fence: Fence) =>
  `${fence.target}\0${fence.assignmentId}\0${fence.assignmentGeneration}\0${fence.instanceId}\0${fence.executorId}\0${fence.processIncarnation}`

const directoryMode = 0o700
const fileMode = 0o600

export const digestName = Effect.fn("Pty.digestName")(function* (value: string) {
  const crypto = yield* Crypto.Crypto
  const digest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(value))
    .pipe(Effect.mapError(() => PtyError.make({ kind: "storage", message: "Could not identify PTY state" })))
  return Encoding.encodeHex(digest)
})

export const repositoryLayer = (options: {
  readonly stateDirectory: string
  readonly fence: Fence
}): Layer.Layer<Repository, PtyError, Crypto.Crypto | FileSystem.FileSystem> =>
  Layer.effect(
    Repository,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const assignment = yield* digestName(fenceIdentity(options.fence))
      const directory = `${options.stateDirectory}/pty`
      const filename = `${directory}/assignment-${assignment}.json`
      const lock = yield* Semaphore.make(1)
      const secureDirectory = fileSystem.makeDirectory(directory, { recursive: true, mode: directoryMode }).pipe(
        Effect.andThen(fileSystem.chmod(directory, directoryMode)),
        Effect.mapError(() => PtyError.make({ kind: "storage", message: "Could not secure PTY state" })),
      )
      const exists = yield* secureDirectory.pipe(
        Effect.andThen(fileSystem.exists(filename)),
        Effect.mapError(() => PtyError.make({ kind: "storage", message: "Could not inspect PTY state" })),
      )
      const loaded = exists
        ? yield* fileSystem.chmod(filename, fileMode).pipe(
            Effect.andThen(fileSystem.readFileString(filename)),
            Effect.mapError(() => PtyError.make({ kind: "storage", message: "Could not read PTY state" })),
            Effect.flatMap((text) =>
              SnapshotCodec.decode(text).pipe(
                Effect.mapError(() => PtyError.make({ kind: "storage", message: "PTY state is invalid" })),
              ),
            ),
          )
        : { version: 1 as const, records: [] }
      const records = yield* Ref.make(
        new Map(loaded.records.map((record) => [record.ptyId, Schema.decodeSync(StoredRecord)(record)] as const)),
      )

      const persist = Effect.fn("Pty.Repository.persist")(function* (next: Map<string, Record>) {
        const temporary = `${filename}.tmp-${process.pid}`
        const text = yield* SnapshotCodec.encode({ version: 1, records: [...next.values()] }).pipe(
          Effect.mapError(() => PtyError.make({ kind: "storage", message: "Could not encode PTY state" })),
        )
        yield* secureDirectory
        yield* fileSystem.writeFileString(temporary, text, { mode: fileMode }).pipe(
          Effect.andThen(fileSystem.chmod(temporary, fileMode)),
          Effect.andThen(fileSystem.rename(temporary, filename)),
          Effect.andThen(fileSystem.chmod(filename, fileMode)),
          Effect.ensuring(fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)),
          Effect.mapError(() => PtyError.make({ kind: "storage", message: "Could not persist PTY state" })),
        )
        yield* Ref.set(records, next)
      })

      const get = (ptyId: string) => Effect.map(Ref.get(records), (current) => current.get(ptyId))
      const list = Effect.map(Ref.get(records), (current) => [...current.values()])
      const insert = Effect.fn("Pty.Repository.insert")(function* (record: Record) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(records)
            if (current.has(record.ptyId))
              return yield* PtyError.make({ kind: "conflict", message: `PTY ${record.ptyId} already exists` })
            const next = new Map(current).set(record.ptyId, record)
            yield* persist(next)
            return record
          }),
        )
      })
      const update = Effect.fn("Pty.Repository.update")(function* (record: Record, expectedRevision: number) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(records)
            const known = current.get(record.ptyId)
            if (known === undefined)
              return yield* PtyError.make({ kind: "missing", message: `PTY ${record.ptyId} does not exist` })
            if (known.revision !== expectedRevision)
              return yield* PtyError.make({ kind: "conflict", message: `PTY ${record.ptyId} revision is stale` })
            const updated = { ...record, revision: expectedRevision + 1 }
            const next = new Map(current).set(record.ptyId, updated)
            yield* persist(next)
            return updated
          }),
        )
      })

      return Repository.of({ get, list, insert, update })
    }),
  )
