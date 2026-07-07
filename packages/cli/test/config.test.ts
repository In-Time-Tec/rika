import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { CliConfig, Output } from "../src/index"

const ConfigListReport = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      env: Schema.optional(Schema.String),
      value: Schema.Unknown,
      source: Schema.String,
    }),
  ),
  warnings: Schema.Array(Schema.Unknown),
})

const ConfigKeymapReport = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      chord: Schema.NullOr(Schema.String),
      description: Schema.String,
      source: Schema.String,
    }),
  ),
  warnings: Schema.Array(Schema.Unknown),
})

describe("CLI config commands", () => {
  test("prints the effective Rika keymap with settings override sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-cli-config-keymap-"))
    const home = join(root, "home")
    const workspace = join(root, "workspace")
    await mkdir(join(home, ".config", "rika"), { recursive: true })
    await mkdir(join(workspace, ".rika"), { recursive: true })
    await writeFile(
      join(home, ".config", "rika", "settings.json"),
      JSON.stringify({
        keymap: {
          "palette.open": "ctrl+p",
        },
      }),
    )
    await writeFile(
      join(workspace, ".rika", "settings.json"),
      JSON.stringify({
        keymap: {
          "thread.newRemote": "ctrl+x u",
        },
      }),
    )
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }

    try {
      const exitCode = await Effect.runPromise(
        CliConfig.executeCommand({ type: "config", action: "keymap" }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Output.memoryLayer(output),
              CliConfig.layerFromInput({
                env: { HOME: home },
                cwd: workspace,
              }),
            ),
          ),
        ),
      )

      expect(exitCode).toBe(0)
      expect(output.stderr).toEqual([])
      const report = Schema.decodeUnknownSync(ConfigKeymapReport)(JSON.parse(output.stdout[0] ?? "{}"))
      expect(report.entries.find((entry) => entry.id === "palette.open")).toMatchObject({
        chord: "ctrl+p",
        source: "user",
      })
      expect(report.entries.find((entry) => entry.id === "thread.newRemote")).toMatchObject({
        chord: "ctrl+x u",
        source: "workspace",
      })
      expect(report.warnings).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("prints effective config snapshot with sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-cli-config-list-"))
    const home = join(root, "home")
    const workspace = join(root, "workspace")
    await mkdir(join(home, ".config", "rika"), { recursive: true })
    await mkdir(join(workspace, ".rika"), { recursive: true })
    await writeFile(
      join(home, ".config", "rika", "settings.json"),
      JSON.stringify({
        "mode.default": "deep1",
        "compaction.auto": true,
        "telemetry.endpoint": "http://user-otel.test",
      }),
    )
    await writeFile(
      join(workspace, ".rika", "settings.json"),
      JSON.stringify({
        "compaction.reserved": 4096,
        "telemetry.enabled": false,
      }),
    )
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }

    try {
      const exitCode = await Effect.runPromise(
        CliConfig.executeCommand({ type: "config", action: "list" }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Output.memoryLayer(output),
              CliConfig.layerFromInput({
                env: {
                  HOME: home,
                  RIKA_MODE: "rush",
                  RIKA_USER: "config-user",
                  RIKA_TELEMETRY_ENDPOINT: "http://env-otel.test",
                },
                cwd: workspace,
              }),
            ),
          ),
        ),
      )

      const report = Schema.decodeUnknownSync(ConfigListReport)(JSON.parse(output.stdout[0] ?? "{}"))
      expect(exitCode).toBe(0)
      expect(output.stderr).toEqual([])
      expect(report).toEqual({
        entries: [
          { key: "workspace.root", env: "RIKA_WORKSPACE_ROOT", value: workspace, source: "default" },
          { key: "data.dir", env: "RIKA_DATA_DIR", value: `${home}/.rika`, source: "default" },
          { key: "database.url", env: "RIKA_DATABASE_URL", value: null, source: "default" },
          { key: "backend.id", env: "RIKA_BACKEND_ID", value: null, source: "default" },
          { key: "subagent.tools", env: "RIKA_SUBAGENT_TOOLS", value: "readonly", source: "default" },
          { key: "orb.template", env: "RIKA_ORB_TEMPLATE", value: "rika-orb", source: "default" },
          { key: "orb.idleTimeoutSeconds", env: "RIKA_ORB_IDLE_TIMEOUT", value: 300, source: "default" },
          { key: "project.default", env: "RIKA_ORB_PROJECT", value: null, source: "default" },
          { key: "user.name", env: "RIKA_USER", value: "config-user", source: "env" },
          { key: "mode.default", env: "RIKA_MODE", value: "rush", source: "env" },
          { key: "compaction.auto", env: "RIKA_COMPACTION_AUTO", value: true, source: "user" },
          { key: "compaction.reserved", env: "RIKA_COMPACTION_RESERVED", value: 4096, source: "workspace" },
          { key: "compaction.prune", env: "RIKA_COMPACTION_PRUNE", value: null, source: "default" },
          {
            key: "compaction.pruneProtect",
            env: "RIKA_COMPACTION_PRUNE_PROTECT",
            value: null,
            source: "default",
          },
          {
            key: "compaction.pruneMinimum",
            env: "RIKA_COMPACTION_PRUNE_MINIMUM",
            value: null,
            source: "default",
          },
          { key: "memory.autoContext", env: "RIKA_MEMORY_AUTO_CONTEXT", value: false, source: "default" },
          { key: "telemetry.enabled", env: "RIKA_TELEMETRY", value: false, source: "workspace" },
          { key: "telemetry.endpoint", env: "RIKA_TELEMETRY_ENDPOINT", value: "http://env-otel.test", source: "env" },
        ],
        warnings: [],
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("opens user settings in EDITOR by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-cli-config-edit-user-"))
    const home = join(root, "home")
    const workspace = join(root, "workspace")
    const editor = join(root, "fake-editor.sh")
    await mkdir(workspace, { recursive: true })
    await writeFile(
      editor,
      [
        "#!/usr/bin/env bash",
        "cat > \"$1\" <<'JSON'",
        '{"mode.default":"deep3","telemetry.enabled":false}',
        "JSON",
        "",
      ].join("\n"),
    )
    await chmod(editor, 0o755)
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }

    try {
      const exitCode = await Effect.runPromise(
        CliConfig.executeCommand({ type: "config", action: "edit" }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Output.memoryLayer(output),
              CliConfig.layerFromInput({
                env: {
                  HOME: home,
                  EDITOR: editor,
                },
                cwd: workspace,
              }),
            ),
          ),
        ),
      )

      const target = join(home, ".config", "rika", "settings.json")
      expect(exitCode).toBe(0)
      expect(JSON.parse(await readFile(target, "utf8"))).toEqual({
        "mode.default": "deep3",
        "telemetry.enabled": false,
      })
      expect(output.stdout).toEqual([`edited ${target}`])
      expect(output.stderr).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("opens workspace settings in EDITOR and reports validation warnings after exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-cli-config-edit-"))
    const home = join(root, "home")
    const workspace = join(root, "workspace")
    const editor = join(root, "fake-editor.sh")
    await mkdir(workspace, { recursive: true })
    await writeFile(
      editor,
      [
        "#!/usr/bin/env bash",
        "cat > \"$1\" <<'JSON'",
        '{"mode.default":1,"orb.template":"edited-template","unknown.key":true}',
        "JSON",
        "",
      ].join("\n"),
    )
    await chmod(editor, 0o755)
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }

    try {
      const exitCode = await Effect.runPromise(
        CliConfig.executeCommand({ type: "config", action: "edit", workspace: true }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Output.memoryLayer(output),
              CliConfig.layerFromInput({
                env: {
                  HOME: home,
                  EDITOR: editor,
                },
                cwd: workspace,
              }),
            ),
          ),
        ),
      )

      const target = join(workspace, ".rika", "settings.json")
      expect(exitCode).toBe(0)
      expect(JSON.parse(await readFile(target, "utf8"))).toEqual({
        "mode.default": 1,
        "orb.template": "edited-template",
        "unknown.key": true,
      })
      expect(output.stdout).toEqual([`edited ${target}`])
      expect(output.stderr).toEqual(
        expect.arrayContaining([expect.stringContaining("mode.default"), expect.stringContaining("unknown.key")]),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
