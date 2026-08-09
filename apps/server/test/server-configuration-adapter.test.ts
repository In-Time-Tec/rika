import { describe, expect, it } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem, Path, Random } from "effect"
import { loadSettingsFile } from "../src/server/composition/server-configuration-adapter"

const expectDesktopRoutes = (settings: Awaited<ReturnType<typeof loadSettingsFile>>) => {
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
}

describe("desktop configuration defaults", () => {
  it.effect("enforces an OpenRouter-free route for clean and existing desktop profiles", () =>
    Effect.gen(function* () {
      const previous = process.env.RIKA_CLIENT
      process.env.RIKA_CLIENT = "desktop"
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.RIKA_CLIENT
          else process.env.RIKA_CLIENT = previous
        }),
      )
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const filename = `/tmp/rika-desktop-config-${yield* Random.nextInt}/.config/rika/settings.json`

      expectDesktopRoutes(yield* loadSettingsFile(filename))

      yield* fileSystem.makeDirectory(path.dirname(filename), { recursive: true })
      yield* fileSystem.writeFileString(
        filename,
        JSON.stringify({
          modelAliases: {
            existing: {
              preset: "openai",
              provider: "openrouter",
              candidates: ["deepseek/deepseek-chat"],
              displayName: "Existing route",
            },
          },
          modelRoutes: {
            modes: { medium: { main: "existing", oracle: "existing" } },
            title: "existing",
            compaction: "existing",
          },
        }),
      )
      const existing = yield* loadSettingsFile(filename)
      expectDesktopRoutes(existing)
      expect(existing.modelAliases?.existing).toBeDefined()
    }).pipe(Effect.provide(BunServices.layer)),
  )
})
