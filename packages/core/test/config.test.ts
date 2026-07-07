import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Config, Settings, Telemetry } from "../src/index"

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

  test("uses the same lenient boolean env parser for config settings and telemetry", async () => {
    const env = {
      RIKA_COMPACTION_AUTO: "1",
      RIKA_COMPACTION_PRUNE: "enabled",
      RIKA_MEMORY_AUTO_CONTEXT: "yes",
      RIKA_TELEMETRY: "on",
    }
    const workspace = "/workspace/rika-config-test"

    const values = await Effect.runPromise(Config.get().pipe(Effect.provide(Config.layerFromEnv(env, workspace))))
    const snapshot = await Effect.runPromise(
      Settings.snapshot.pipe(Effect.provide(Settings.layerFromEnv(env, workspace))),
    )
    const telemetry = Telemetry.fromEnv(env, "0.0.0")

    expect(values.compaction_auto).toBe(true)
    expect(values.compaction_prune).toBe(true)
    expect(snapshot.values.memory.autoContext).toBe(true)
    expect(snapshot.values.telemetry.enabled).toBe(true)
    expect(telemetry.enabled).toBe(true)
  })

  test("invalid settings-backed env values fail fast through settings and config", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-config-invalid-shared-"))
    const home = join(root, "home")
    const workspace = join(root, "workspace")
    await mkdir(join(home, ".config", "rika"), { recursive: true })
    await mkdir(join(workspace, ".rika"), { recursive: true })
    await writeFile(
      join(home, ".config", "rika", "settings.json"),
      JSON.stringify({ "mode.default": "deep1", "compaction.auto": true }),
    )
    const cases = [
      { env: { RIKA_COMPACTION_AUTO: "sometimes" }, key: "RIKA_COMPACTION_AUTO", value: "sometimes" },
      { env: { RIKA_MODE: "depe2" }, key: "RIKA_MODE", value: "depe2" },
    ] as const

    try {
      for (const current of cases) {
        const env = { HOME: home, ...current.env }
        const configError = await Effect.runPromise(
          Config.get().pipe(Effect.provide(Config.layerFromEnv(env, workspace)), Effect.flip),
        )
        const settingsError = await Effect.runPromise(
          Settings.snapshot.pipe(Effect.provide(Settings.layerFromEnv(env, workspace)), Effect.flip),
        )
        const message = `Invalid ${current.key} ${current.value}`

        expect(configError).toMatchObject({ key: current.key, message })
        expect(settingsError).toMatchObject({ key: current.key, message })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("parses subagent tool mode from env", async () => {
    const values = await Effect.runPromise(
      Config.get().pipe(
        Effect.provide(
          Config.layerFromEnv(
            {
              RIKA_SUBAGENT_TOOLS: "full",
            },
            "/workspace/rika-config-test",
          ),
        ),
      ),
    )

    expect(values.subagent_tools).toBe("full")
  })

  test("rejects invalid subagent tool mode env values", async () => {
    const error = await Effect.runPromise(
      Config.valuesFromEnv(
        {
          RIKA_SUBAGENT_TOOLS: "read-write",
        },
        "/workspace/rika-config-test",
      ).pipe(Effect.flip),
    )

    expect(error).toMatchObject({
      key: "RIKA_SUBAGENT_TOOLS",
      message: "Invalid RIKA_SUBAGENT_TOOLS read-write",
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
        data_dir: `${home}/.rika`,
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
