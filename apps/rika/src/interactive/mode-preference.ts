import { Effect, FileSystem, Schema } from "effect"

const Preference = Schema.Struct({ version: Schema.Literal(1), mode: Schema.NonEmptyString })
const PreferenceFile = Schema.fromJsonString(Preference)

const filename = (dataRoot: string) => `${dataRoot}/mode.json`

export const loadModePreference = Effect.fn("ModePreference.load")(function* (
  dataRoot: string,
  modes: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const read = yield* Effect.result(fileSystem.readFileString(filename(dataRoot)))
  if (read._tag === "Failure") return undefined
  const decoded = yield* Effect.result(Schema.decodeUnknownEffect(PreferenceFile)(read.success))
  if (decoded._tag === "Failure" || !modes.includes(decoded.success.mode)) return undefined
  return decoded.success.mode
})

export const saveModePreference = Effect.fn("ModePreference.save")(function* (dataRoot: string, mode: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const encoded = yield* Schema.encodeEffect(PreferenceFile)({ version: 1, mode })
  yield* fileSystem.writeFileString(filename(dataRoot), `${encoded}\n`, { mode: 0o600 })
})
