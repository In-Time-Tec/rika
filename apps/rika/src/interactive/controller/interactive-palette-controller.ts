import { workspacePaths } from "@rika/configuration/configuration-paths"
import * as SettingsDecoder from "@rika/configuration/configuration-settings"
import { Effect, FileSystem, Path, Schema } from "effect"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

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
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)),
            Effect.mapError((cause) =>
              SettingsDecoder.Decoder.ConfigurationSettingsFileError.make({
                path: filename,
                message: `Cannot update invalid settings file: ${String(cause)}`,
              }),
            ),
          )
        : Effect.succeed({}),
    ),
  )
  if (!isRecord(current))
    return yield* SettingsDecoder.Decoder.ConfigurationSettingsFileError.make({
      path: filename,
      message: "Cannot update settings file: root must be an object",
    })
  const subagents = current.subagents
  if (subagents !== undefined && !isRecord(subagents))
    return yield* SettingsDecoder.Decoder.ConfigurationSettingsFileError.make({
      path: filename,
      message: "Cannot update settings file: subagents must be an object",
    })
  const next = { ...current, subagents: { ...subagents, [limit]: value } }
  SettingsDecoder.Decoder.decodeSettingsInput(filename, next)
  yield* fileSystem.makeDirectory(path.dirname(filename), { recursive: true })
  const encoded = yield* Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)(next)
  yield* fileSystem.writeFileString(filename, `${encoded}\n`)
})
