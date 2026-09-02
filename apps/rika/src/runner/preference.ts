import { Effect, FileSystem, Schema } from "effect"
import { RunnerError, RemoteThreadCreation } from "./contract"
import { writePrivateFile } from "../platform/private-file"

const PreferenceFile = Schema.Struct({
  formatVersion: Schema.Literal(1),
  checkouts: Schema.Record(Schema.String, RemoteThreadCreation),
})

export interface Store {
  readonly get: (deviceId: string, checkoutFingerprint: string) => Effect.Effect<RemoteThreadCreation, RunnerError>
  readonly set: (
    deviceId: string,
    checkoutFingerprint: string,
    preference: RemoteThreadCreation,
  ) => Effect.Effect<void, RunnerError>
}

const key = (deviceId: string, checkoutFingerprint: string) => `${deviceId}:${checkoutFingerprint}`
const failure = (message: string) => RunnerError.make({ message })

export const make = Effect.fn("RunnerPreference.make")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const load = Effect.gen(function* () {
    if (!(yield* fileSystem.exists(path).pipe(Effect.mapError(() => failure("Runner admission could not be read")))))
      return PreferenceFile.make({ formatVersion: 1, checkouts: {} })
    return yield* fileSystem.readFileString(path).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(PreferenceFile))),
      Effect.mapError(() => failure("Runner admission file is corrupt")),
    )
  })
  return {
    get: (deviceId: string, checkoutFingerprint: string) =>
      Effect.map(load, (values) => values.checkouts[key(deviceId, checkoutFingerprint)] ?? "denied"),
    set: (deviceId: string, checkoutFingerprint: string, preference: RemoteThreadCreation) =>
      Effect.gen(function* () {
        const current = yield* load
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(PreferenceFile))({
          formatVersion: 1,
          checkouts: { ...current.checkouts, [key(deviceId, checkoutFingerprint)]: preference },
        }).pipe(Effect.mapError(() => failure("Runner admission could not be encoded")))
        yield* writePrivateFile(fileSystem, path, encoded).pipe(
          Effect.mapError(() => failure("Runner admission could not be saved")),
        )
      }),
  } satisfies Store
})
