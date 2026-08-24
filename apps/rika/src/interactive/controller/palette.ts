import { workspacePaths } from "@rika/configuration/configuration-paths"
import * as SettingsDecoder from "@rika/configuration/configuration-settings"
import { Effect, FileSystem, Path, Schema } from "effect"

const SettingsObject = Schema.Record(Schema.String, Schema.Json)
const decodeSettingsObject = Schema.decodeUnknownEffect(SettingsObject)

export const writeSubagentLimit = Effect.fn("InteractivePalette.writeSubagentLimit")(function* (
  workspace: string,
  limit: "maxDepth" | "maxSubagents",
  value: number,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const filename = workspacePaths(workspace).settings
  const current = yield* fileSystem.exists(filename).pipe(
    Effect.flatMap((exists) =>
      exists
        ? fileSystem.readFileString(filename).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(SettingsObject))),
            Effect.mapError((cause) =>
              SettingsDecoder.Decoder.ConfigurationSettingsFileError.make({
                path: filename,
                message: `Cannot update invalid settings file: ${String(cause)}`,
              }),
            ),
          )
        : Effect.succeed(Schema.decodeSync(SettingsObject)({})),
    ),
  )
  const subagents = current.subagents
  const decodedSubagents =
    subagents === undefined
      ? {}
      : yield* decodeSettingsObject(subagents).pipe(
          Effect.mapError(() =>
            SettingsDecoder.Decoder.ConfigurationSettingsFileError.make({
              path: filename,
              message: "Cannot update settings file: subagents must be an object",
            }),
          ),
        )
  const next = { ...current, subagents: { ...decodedSubagents, [limit]: value } }
  SettingsDecoder.Decoder.decodeSettingsInput(filename, next)
  yield* fileSystem.makeDirectory(path.dirname(filename), { recursive: true })
  const encoded = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(next)
  yield* fileSystem.writeFileString(filename, `${encoded}\n`)
})
