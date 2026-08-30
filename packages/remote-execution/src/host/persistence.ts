import { Crypto, Effect, Encoding, FileSystem, Option, Schema } from "effect"
import type { SessionWire } from "../protocol/messages"
import { SessionWire as SessionWireSchema } from "../protocol/messages"
import * as Operations from "../protocol/operations"
import { HostError } from "./error"

const directoryMode = 0o700
const fileMode = 0o600
const decodeSession = Schema.decodeUnknownEffect(Schema.fromJsonString(SessionWireSchema))
const encodeSession = Schema.encodeEffect(Schema.fromJsonString(SessionWireSchema))
const OperationReceiptSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  receipts: Schema.Array(Operations.OperationReceipt),
})
const decodeOperationReceipts = Schema.decodeUnknownEffect(Schema.fromJsonString(OperationReceiptSnapshot))
const encodeOperationReceipts = Schema.encodeEffect(Schema.fromJsonString(OperationReceiptSnapshot))

export interface SessionStore {
  readonly load: Effect.Effect<Option.Option<SessionWire>, HostError>
  readonly save: (session: SessionWire) => Effect.Effect<void, HostError>
}

export const sessionStore = (stateDirectory: string): Effect.Effect<SessionStore, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const filename = `${stateDirectory}/session.json`
    const restrictDirectory = fileSystem.makeDirectory(stateDirectory, { recursive: true, mode: directoryMode }).pipe(
      Effect.andThen(fileSystem.chmod(stateDirectory, directoryMode)),
      Effect.mapError(() => HostError.make({ message: "Could not secure executor session state" })),
    )
    const load = restrictDirectory.pipe(
      Effect.andThen(
        fileSystem
          .exists(filename)
          .pipe(Effect.mapError(() => HostError.make({ message: "Could not inspect executor session state" }))),
      ),
      Effect.flatMap((exists) =>
        exists
          ? fileSystem.chmod(filename, fileMode).pipe(
              Effect.andThen(fileSystem.readFileString(filename)),
              Effect.mapError(() => HostError.make({ message: "Could not read executor session state" })),
              Effect.flatMap((text) =>
                decodeSession(text).pipe(
                  Effect.mapError(() => HostError.make({ message: "Executor session state is invalid" })),
                  Effect.map(Option.some),
                ),
              ),
            )
          : Effect.succeedNone,
      ),
    )
    const save = Effect.fn("Host.sessionStore.save")(function* (session: SessionWire) {
      const temporary = `${filename}.tmp-${process.pid}`
      const text = yield* encodeSession(session).pipe(
        Effect.mapError(() => HostError.make({ message: "Could not encode executor session state" })),
      )
      yield* restrictDirectory
      yield* fileSystem.writeFileString(temporary, text, { mode: fileMode }).pipe(
        Effect.andThen(fileSystem.chmod(temporary, fileMode)),
        Effect.andThen(fileSystem.rename(temporary, filename)),
        Effect.andThen(fileSystem.chmod(filename, fileMode)),
        Effect.ensuring(fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)),
        Effect.mapError(() => HostError.make({ message: "Could not persist executor session state" })),
      )
    })
    return { load, save } satisfies SessionStore
  })

export interface OperationReceiptStore {
  readonly load: Effect.Effect<Operations.ReceiptMap, HostError>
  readonly save: (frames: Operations.ReceiptMap) => Effect.Effect<void, HostError>
}

const operationReceiptStore = (
  stateDirectory: string,
  assignmentId: string,
  assignmentGeneration: number,
): Effect.Effect<OperationReceiptStore, never, FileSystem.FileSystem | Crypto.Crypto> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const crypto = yield* Crypto.Crypto
    const directory = `${stateDirectory}/operation-receipts`
    const assignmentDigest = yield* crypto.digest("SHA-256", new TextEncoder().encode(assignmentId)).pipe(Effect.orDie)
    const filename = `${directory}/assignment-${Encoding.encodeHex(assignmentDigest)}-g${assignmentGeneration}.json`
    const restrictDirectory = fileSystem.makeDirectory(directory, { recursive: true, mode: directoryMode }).pipe(
      Effect.andThen(fileSystem.chmod(directory, directoryMode)),
      Effect.mapError(() => HostError.make({ message: "Could not secure executor operation receipts" })),
    )
    const load = restrictDirectory.pipe(
      Effect.andThen(
        fileSystem
          .exists(filename)
          .pipe(Effect.mapError(() => HostError.make({ message: "Could not inspect executor operation receipts" }))),
      ),
      Effect.flatMap((exists) =>
        exists
          ? fileSystem.chmod(filename, fileMode).pipe(
              Effect.andThen(fileSystem.readFileString(filename)),
              Effect.mapError(() => HostError.make({ message: "Could not read executor operation receipts" })),
              Effect.flatMap((text) =>
                decodeOperationReceipts(text).pipe(
                  Effect.mapError(() => HostError.make({ message: "Executor operation receipts are invalid" })),
                ),
              ),
              Effect.map(
                (snapshot) =>
                  new Map(
                    snapshot.receipts.map(
                      (receipt) =>
                        [
                          Operations.executionKey(receipt.operationKey, receipt.frames[0].attribution.attempt),
                          receipt.frames,
                        ] as const,
                    ),
                  ),
              ),
            )
          : Effect.succeed(new Map()),
      ),
    )
    const save = Effect.fn("Host.operationReceiptStore.save")(function* (frames: Operations.ReceiptMap) {
      const temporary = `${filename}.tmp-${process.pid}`
      const text = yield* encodeOperationReceipts({
        version: 1,
        receipts: [...frames.values()].flatMap((retained) => {
          const first = retained[0]
          return first === undefined
            ? []
            : [
                Operations.OperationReceipt.make({
                  operationKey: first.attribution.operationKey,
                  frames: [first, ...retained.slice(1)],
                }),
              ]
        }),
      }).pipe(Effect.mapError(() => HostError.make({ message: "Could not encode executor operation receipts" })))
      yield* restrictDirectory
      yield* fileSystem.writeFileString(temporary, text, { mode: fileMode }).pipe(
        Effect.andThen(fileSystem.chmod(temporary, fileMode)),
        Effect.andThen(fileSystem.rename(temporary, filename)),
        Effect.andThen(fileSystem.chmod(filename, fileMode)),
        Effect.ensuring(fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)),
        Effect.mapError(() => HostError.make({ message: "Could not persist executor operation receipts" })),
      )
    })
    return { load, save } satisfies OperationReceiptStore
  })

export const persistence = { operationReceiptStore }
