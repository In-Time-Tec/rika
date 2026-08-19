import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, test } from "vitest"
import { Effect, FileSystem, Layer, Schema } from "effect"
import { loadModePreference, saveModePreference } from "../src/interactive/process/mode-preference"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(
    Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context)))),
  )
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

test("remembers a selected mode only while it remains configured", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const dataRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-mode-preference-" })

        yield* saveModePreference(dataRoot, "deep-review")

        expect(yield* loadModePreference(dataRoot, ["quick", "deep-review"])).toBe("deep-review")
        expect(yield* loadModePreference(dataRoot, ["quick", "ship"])).toBeUndefined()
      }),
    ),
  ))

test("ignores missing and malformed mode preferences", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const dataRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-mode-preference-invalid-" })

        expect(yield* loadModePreference(dataRoot, ["quick"])).toBeUndefined()
        yield* fileSystem.writeFileString(`${dataRoot}/mode.json`, "not json")
        expect(yield* loadModePreference(dataRoot, ["quick"])).toBeUndefined()
        yield* fileSystem.writeFileString(`${dataRoot}/mode.json`, encodeJson({ version: 2, mode: "quick" }))
        expect(yield* loadModePreference(dataRoot, ["quick"])).toBeUndefined()
        yield* fileSystem.writeFileString(`${dataRoot}/mode.json`, encodeJson({ version: 1, mode: "" }))
        expect(yield* loadModePreference(dataRoot, ["quick"])).toBeUndefined()
      }),
    ),
  ))
