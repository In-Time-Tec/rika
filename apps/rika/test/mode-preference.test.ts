import * as BunServices from "@effect/platform-bun/BunServices"
import * as Settings from "@rika/configuration/configuration-settings"
import { expect, test } from "vitest"
import { Effect, FileSystem, Layer, Schema } from "effect"
import { loadModePreference, resolveModeDefault, saveModePreference } from "../src/interactive/process/mode-preference"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(
    Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context)))),
  )
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

test("uses a persisted selection as the next default after restart when defaultMode is omitted", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const dataRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-mode-preference-" })

        yield* saveModePreference(dataRoot, "deep-review")

        const rememberedMode = yield* loadModePreference(dataRoot, ["quick", "deep-review"])
        expect(rememberedMode).toBe("deep-review")
        expect(resolveModeDefault(undefined, rememberedMode, Settings.Defaults.settingsDefaults.defaultMode)).toBe(
          "deep-review",
        )
        expect(yield* loadModePreference(dataRoot, ["quick", "ship"])).toBeUndefined()
      }),
    ),
  ))

test("a configured defaultMode overrides the remembered mode", () =>
  expect(resolveModeDefault("quick", "deep-review", Settings.Defaults.settingsDefaults.defaultMode)).toBe("quick"))

test("missing, stale, and malformed preferences use the existing settings default", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const dataRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-mode-preference-invalid-" })
        const fallbackMode = Settings.Defaults.settingsDefaults.defaultMode

        expect(resolveModeDefault(undefined, yield* loadModePreference(dataRoot, ["quick"]), fallbackMode)).toBe(
          fallbackMode,
        )
        yield* saveModePreference(dataRoot, "removed")
        expect(resolveModeDefault(undefined, yield* loadModePreference(dataRoot, ["quick"]), fallbackMode)).toBe(
          fallbackMode,
        )
        yield* fileSystem.writeFileString(`${dataRoot}/mode.json`, "not json")
        expect(resolveModeDefault(undefined, yield* loadModePreference(dataRoot, ["quick"]), fallbackMode)).toBe(
          fallbackMode,
        )
        yield* fileSystem.writeFileString(`${dataRoot}/mode.json`, encodeJson({ version: 2, mode: "quick" }))
        expect(yield* loadModePreference(dataRoot, ["quick"])).toBeUndefined()
        yield* fileSystem.writeFileString(`${dataRoot}/mode.json`, encodeJson({ version: 1, mode: "" }))
        expect(yield* loadModePreference(dataRoot, ["quick"])).toBeUndefined()
      }),
    ),
  ))
