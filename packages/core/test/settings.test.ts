import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Settings } from "../src/index"

describe("Settings", () => {
  test("resolves env over workspace settings over user settings over defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-settings-"))
    const home = join(root, "home")
    const workspace = join(root, "workspace")
    await mkdir(join(home, ".config", "rika"), { recursive: true })
    await mkdir(join(workspace, ".rika"), { recursive: true })
    await writeFile(
      join(home, ".config", "rika", "settings.json"),
      JSON.stringify({
        "orb.template": "user-template",
        "orb.idleTimeoutSeconds": 111,
        "project.default": "user-project",
        "user.name": "user-name",
      }),
    )
    await writeFile(
      join(workspace, ".rika", "settings.json"),
      JSON.stringify({
        "orb.template": "workspace-template",
        "project.default": "workspace-project",
        "user.name": "workspace-name",
      }),
    )

    try {
      const snapshot = await Effect.runPromise(
        Settings.snapshot.pipe(
          Effect.provide(
            Settings.layerFromEnv(
              {
                HOME: home,
                RIKA_ORB_TEMPLATE: "env-template",
                RIKA_ORB_IDLE_TIMEOUT: "42",
                RIKA_USER: "env-name",
              },
              workspace,
            ),
          ),
        ),
      )

      expect(snapshot.values).toEqual({
        orb: {
          template: "env-template",
          idleTimeoutSeconds: 42,
        },
        project: {
          default: "workspace-project",
        },
        user: {
          name: "env-name",
        },
        mode: {
          default: "smart",
        },
        compaction: {},
        keymap: {},
        telemetry: {
          enabled: true,
          endpoint: "http://127.0.0.1:27686",
        },
      })
      expect(snapshot.sources).toMatchObject({
        "orb.template": "env",
        "orb.idleTimeoutSeconds": "env",
        "project.default": "workspace",
        "user.name": "env",
        "mode.default": "default",
        "telemetry.enabled": "default",
        "telemetry.endpoint": "default",
      })
      expect(snapshot.keymapSources).toEqual({})
      expect(snapshot.warnings).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("warns on malformed JSON and falls back without crashing", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-settings-malformed-"))
    const home = join(root, "home")
    const workspace = join(root, "workspace")
    await mkdir(join(home, ".config", "rika"), { recursive: true })
    await mkdir(workspace, { recursive: true })
    const userSettings = join(home, ".config", "rika", "settings.json")
    await writeFile(userSettings, "{")

    try {
      const snapshot = await Effect.runPromise(
        Settings.snapshot.pipe(Effect.provide(Settings.layerFromEnv({ HOME: home }, workspace))),
      )

      expect(snapshot.values).toEqual({
        orb: {
          template: "rika-orb",
          idleTimeoutSeconds: 300,
        },
        project: {},
        user: {
          name: userInfo().username,
        },
        mode: {
          default: "smart",
        },
        compaction: {},
        keymap: {},
        telemetry: {
          enabled: true,
          endpoint: "http://127.0.0.1:27686",
        },
      })
      expect(snapshot.sources).toMatchObject({
        "orb.template": "default",
        "orb.idleTimeoutSeconds": "default",
        "mode.default": "default",
        "telemetry.enabled": "default",
        "telemetry.endpoint": "default",
      })
      expect(snapshot.keymapSources).toEqual({})
      expect(snapshot.warnings).toHaveLength(1)
      expect(snapshot.warnings[0]).toMatchObject({
        path: userSettings,
        source: "user",
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("resolves general preference keys from env over workspace over user over defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-settings-general-"))
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
        "telemetry.endpoint": "http://user-otel.test",
      }),
    )
    await writeFile(
      join(workspace, ".rika", "settings.json"),
      JSON.stringify({
        "mode.default": "deep2",
        "compaction.reserved": 2_000,
        "compaction.prune": false,
        "telemetry.enabled": false,
      }),
    )

    try {
      const snapshot = await Effect.runPromise(
        Settings.snapshot.pipe(
          Effect.provide(
            Settings.layerFromEnv(
              {
                HOME: home,
                RIKA_MODE: "rush",
                RIKA_TELEMETRY_ENDPOINT: "http://env-otel.test/",
              },
              workspace,
            ),
          ),
        ),
      )

      expect(snapshot.values).toMatchObject({
        mode: { default: "rush" },
        compaction: {
          auto: true,
          reserved: 2_000,
          prune: false,
        },
        keymap: {},
        telemetry: {
          enabled: false,
          endpoint: "http://env-otel.test/",
        },
      })
      expect(snapshot.sources).toMatchObject({
        "mode.default": "env",
        "compaction.auto": "user",
        "compaction.reserved": "workspace",
        "compaction.prune": "workspace",
        "telemetry.enabled": "workspace",
        "telemetry.endpoint": "env",
      })
      expect(snapshot.keymapSources).toEqual({})
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("warns on unknown keys and wrong value types without rejecting the file", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-settings-validation-"))
    const home = join(root, "home")
    const workspace = join(root, "workspace")
    await mkdir(join(workspace, ".rika"), { recursive: true })
    const workspaceSettings = join(workspace, ".rika", "settings.json")
    await writeFile(
      workspaceSettings,
      JSON.stringify({
        "mode.default": "invalid-mode",
        "telemetry.enabled": "sometimes",
        "compaction.reserved": -1,
        "orb.template": "kept-template",
        mcpServers: {},
        "rika.mcpServers": {},
        "unknown.key": true,
      }),
    )

    try {
      const snapshot = await Effect.runPromise(
        Settings.snapshot.pipe(Effect.provide(Settings.layerFromEnv({ HOME: home }, workspace))),
      )

      expect(snapshot.values.orb.template).toBe("kept-template")
      expect(snapshot.values.mode.default).toBe("smart")
      expect(snapshot.values.compaction).toEqual({})
      expect(snapshot.values.telemetry.enabled).toBe(true)
      expect(snapshot.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: workspaceSettings, source: "workspace", key: "mode.default" }),
          expect.objectContaining({ path: workspaceSettings, source: "workspace", key: "telemetry.enabled" }),
          expect.objectContaining({ path: workspaceSettings, source: "workspace", key: "compaction.reserved" }),
          expect.objectContaining({ path: workspaceSettings, source: "workspace", key: "unknown.key" }),
        ]),
      )
      expect(snapshot.warnings.some((warning) => warning.key === "mcpServers")).toBe(false)
      expect(snapshot.warnings.some((warning) => warning.key === "rika.mcpServers")).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("resolves keymap entries with user entries overriding workspace entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-settings-keymap-"))
    const home = join(root, "home")
    const workspace = join(root, "workspace")
    await mkdir(join(home, ".config", "rika"), { recursive: true })
    await mkdir(join(workspace, ".rika"), { recursive: true })
    await writeFile(
      join(home, ".config", "rika", "settings.json"),
      JSON.stringify({
        keymap: {
          "palette.open": "ctrl+p",
          "mode.next": null,
        },
      }),
    )
    await writeFile(
      join(workspace, ".rika", "settings.json"),
      JSON.stringify({
        keymap: {
          "palette.open": "ctrl+o",
          "thread.newRemote": "ctrl+x u",
        },
      }),
    )

    try {
      const snapshot = await Effect.runPromise(
        Settings.snapshot.pipe(Effect.provide(Settings.layerFromEnv({ HOME: home }, workspace))),
      )

      expect(snapshot.values.keymap).toEqual({
        "palette.open": "ctrl+p",
        "mode.next": null,
        "thread.newRemote": "ctrl+x u",
      })
      expect(snapshot.keymapSources).toEqual({
        "palette.open": "user",
        "mode.next": "user",
        "thread.newRemote": "workspace",
      })
      expect(snapshot.warnings).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("warns on invalid keymap shapes without rejecting valid entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-settings-keymap-invalid-"))
    const home = join(root, "home")
    const workspace = join(root, "workspace")
    await mkdir(join(workspace, ".rika"), { recursive: true })
    const workspaceSettings = join(workspace, ".rika", "settings.json")
    await writeFile(
      workspaceSettings,
      JSON.stringify({
        keymap: {
          "palette.open": "ctrl+p",
          "mode.next": false,
        },
      }),
    )

    try {
      const snapshot = await Effect.runPromise(
        Settings.snapshot.pipe(Effect.provide(Settings.layerFromEnv({ HOME: home }, workspace))),
      )

      expect(snapshot.values.keymap).toEqual({ "palette.open": "ctrl+p" })
      expect(snapshot.keymapSources).toEqual({ "palette.open": "workspace" })
      expect(snapshot.warnings).toEqual([
        expect.objectContaining({ path: workspaceSettings, source: "workspace", key: "keymap.mode.next" }),
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
