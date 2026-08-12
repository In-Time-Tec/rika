import type { InteractiveCommand } from "@rika/product/interactive-command"
import { workspacePaths } from "@rika/configuration/configuration-paths"
import * as SettingsDecoder from "@rika/configuration/configuration-settings"
import { Effect, FileSystem, Path, Schema } from "effect"

export interface PaletteCommand {
  readonly id: string
  readonly category: string
  readonly label: string
  readonly action: unknown
}

export const paletteCommands = [
  { id: "new-thread", category: "thread", label: "New thread", action: { _tag: "NewThread" as const } },
] as const

export const installPaletteCommands = (commands: Array<PaletteCommand>): void => {
  for (const command of paletteCommands.toReversed())
    if (!commands.some((candidate) => candidate.id === command.id)) commands.unshift(command)
}

export const paletteCommand = (action: unknown): InteractiveCommand | undefined =>
  action !== null && typeof action === "object" && "_tag" in action && action._tag === "NewThread"
    ? { _tag: "NewThread" }
    : undefined

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
