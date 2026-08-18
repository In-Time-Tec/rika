import * as SettingsDecoder from "@rika/configuration/configuration-settings"
import { Effect, FileSystem, Function, Path, Schema, Stream } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { createHash } from "node:crypto"

export type ConfigFileState = { readonly _tag: "missing" } | { readonly _tag: "present"; readonly hash: string }

export const stateOf = (text: string): ConfigFileState => ({
  _tag: "present",
  hash: createHash("sha256").update(text).digest("hex"),
})

export const configFileChanged: {
  (baseline: ConfigFileState, current: ConfigFileState): boolean
  (current: ConfigFileState): (baseline: ConfigFileState) => boolean
} = Function.dual(
  2,
  (baseline: ConfigFileState, current: ConfigFileState): boolean =>
    baseline._tag !== current._tag ||
    (baseline._tag === "present" && current._tag === "present" && baseline.hash !== current.hash),
)

export interface ConfigFileSnapshot {
  readonly state: ConfigFileState
  readonly text: string | undefined
}

export const readConfigFile = (
  filename: string,
): Effect.Effect<ConfigFileSnapshot, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    if (!(yield* fileSystem.exists(filename))) return { state: { _tag: "missing" }, text: undefined }
    const text = yield* fileSystem.readFileString(filename)
    return { state: stateOf(text), text }
  })

export const nearestExistingAncestor = (
  filename: string,
): Effect.Effect<string, PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const walk = (directory: string): Effect.Effect<string, PlatformError, FileSystem.FileSystem | Path.Path> =>
      fileSystem
        .exists(directory)
        .pipe(Effect.flatMap((exists) => (exists ? Effect.succeed(directory) : walk(path.dirname(directory)))))
    return yield* walk(path.dirname(filename))
  })

const parseConfigText = (filename: string, text: string) =>
  Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(text).pipe(
    Effect.mapError((error) =>
      SettingsDecoder.Decoder.ConfigurationSettingsFileError.make({
        path: filename,
        message: `Invalid JSON: ${String(error)}`,
      }),
    ),
    Effect.map((value) => SettingsDecoder.Decoder.decodeSettingsInput(filename, value)),
  )

export interface ConfigReloadWatcherOptions {
  readonly filename: string
  readonly debounceMilliseconds: number
  readonly onRestart: Effect.Effect<void>
}

export const watchConfigFileForRestart = (
  options: ConfigReloadWatcherOptions,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const attempt = (): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const watchDirectory = yield* nearestExistingAncestor(options.filename)
        const baseline = yield* readConfigFile(options.filename)
        yield* Effect.logInfo("server.config.watch.started").pipe(
          Effect.annotateLogs({
            "rika.config.path": options.filename,
            "rika.config.directory": watchDirectory,
            "rika.config.state": baseline.state._tag,
          }),
        )
        const inspect = () =>
          Effect.gen(function* () {
            const settled = yield* fileSystem.watch(watchDirectory).pipe(
              Stream.map(() => undefined),
              Stream.debounce(options.debounceMilliseconds),
              Stream.runHead,
            )
            if (settled === undefined) return "continue" as const
            const current = yield* readConfigFile(options.filename)
            if (!configFileChanged(baseline.state, current.state)) return "continue" as const
            if (current.state._tag === "present" && current.text !== undefined) {
              const parsed = yield* Effect.result(parseConfigText(options.filename, current.text))
              if (parsed._tag === "Failure") {
                yield* Effect.logWarning("server.config.watch.invalid").pipe(
                  Effect.annotateLogs({
                    "rika.config.path": options.filename,
                    "rika.failure.kind": String(parsed.failure),
                  }),
                )
                return "continue" as const
              }
            }
            yield* Effect.logInfo("server.config.watch.changed").pipe(
              Effect.annotateLogs({ "rika.config.path": options.filename }),
            )
            yield* options.onRestart
            return "restart" as const
          })
        const loop = (): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> =>
          Effect.gen(function* () {
            const outcome = yield* inspect().pipe(
              Effect.catch((error) =>
                Effect.logWarning("server.config.watch.error").pipe(
                  Effect.annotateLogs({ "rika.config.path": options.filename, "rika.failure.kind": String(error) }),
                  Effect.andThen(Effect.sleep("1 second")),
                  Effect.as("continue" as const),
                ),
              ),
            )
            if (outcome === "restart") return
            return yield* loop()
          })
        return yield* loop()
      })
    const retry = (): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
      attempt().pipe(
        Effect.catch((error) =>
          Effect.logWarning("server.config.watch.error").pipe(
            Effect.annotateLogs({ "rika.config.path": options.filename, "rika.failure.kind": String(error) }),
            Effect.andThen(Effect.sleep("1 second")),
            Effect.andThen(retry),
          ),
        ),
      )
    return yield* retry()
  })
