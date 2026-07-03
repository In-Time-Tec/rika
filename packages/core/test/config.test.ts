import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Config } from "../src/index"

describe("Config", () => {
  test("parses compaction auto and reserved token settings from env", async () => {
    const values = await Effect.runPromise(
      Config.get().pipe(
        Effect.provide(
          Config.layerFromEnv(
            {
              RIKA_MODE: "rush",
              RIKA_COMPACTION_AUTO: "false",
              RIKA_COMPACTION_RESERVED: "12345",
              RIKA_COMPACTION_PRUNE: "false",
              RIKA_COMPACTION_PRUNE_PROTECT: "40000",
              RIKA_COMPACTION_PRUNE_MINIMUM: "20000",
            },
            "/workspace/rika-config-test",
          ),
        ),
      ),
    )

    expect(values).toMatchObject({
      default_mode: "rush",
      compaction_auto: false,
      compaction_reserved: 12_345,
      compaction_prune: false,
      compaction_prune_protect: 40_000,
      compaction_prune_minimum: 20_000,
    })
  })

  test("resolves settings-backed config values without allowing infra settings aliases", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-config-settings-"))
    const home = join(root, "home")
    const workspace = join(root, "workspace")
    await mkdir(join(home, ".config", "rika"), { recursive: true })
    await mkdir(join(workspace, ".rika"), { recursive: true })
    await writeFile(
      join(home, ".config", "rika", "settings.json"),
      JSON.stringify({
        "mode.default": "deep1",
        "compaction.auto": true,
        "compaction.reserved": 1_000,
      }),
    )
    await writeFile(
      join(workspace, ".rika", "settings.json"),
      JSON.stringify({
        "mode.default": "deep2",
        "database.url": "file:settings.sqlite",
        "backend.id": "settings-backend",
      }),
    )

    try {
      const values = await Effect.runPromise(
        Config.get().pipe(
          Effect.provide(
            Config.layerFromEnv(
              {
                HOME: home,
                RIKA_COMPACTION_RESERVED: "2000",
              },
              workspace,
            ),
          ),
        ),
      )

      expect(values).toMatchObject({
        workspace_root: workspace,
        data_dir: `${workspace}/.rika`,
        default_mode: "deep2",
        compaction_auto: true,
        compaction_reserved: 2_000,
      })
      expect(values.database_url).toBeUndefined()
      expect(values.backend_id).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
