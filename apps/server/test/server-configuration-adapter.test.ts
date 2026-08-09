import { describe, expect, it } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, Random } from "effect"
import { loadSettingsFile } from "../src/server/composition/server-configuration-adapter"

describe("desktop configuration defaults", () => {
  it.effect("uses an OpenRouter-free default for a clean desktop profile", () =>
    Effect.gen(function* () {
      const previous = process.env.RIKA_CLIENT
      process.env.RIKA_CLIENT = "desktop"
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.RIKA_CLIENT
          else process.env.RIKA_CLIENT = previous
        }),
      )
      const filename = `/tmp/rika-desktop-config-${yield* Random.nextInt}/.config/rika/settings.json`
      const settings = yield* loadSettingsFile(filename).pipe(Effect.provide(BunServices.layer))
      expect(settings).toMatchObject({
        modelAliases: {
          "rika-free": { provider: "openrouter", candidates: ["openrouter/free"] },
        },
        modelRoutes: {
          modes: { medium: { main: "rika-free", oracle: "rika-free" } },
          title: "rika-free",
          compaction: "rika-free",
        },
      })
    }),
  )
})
