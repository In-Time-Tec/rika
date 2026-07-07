import { describe, expect, test } from "bun:test"
import { Database, Migration, ThreadProjection } from "@rika/persistence"
import { Common, Event, Ids } from "@rika/schema"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { Args, Help, Output, Runtime } from "../src/index"

const runtimeNow = Common.TimestampMillis.make(1_965_000_000_000)

const threadCreated = (threadId: Ids.ThreadId, workspaceId: Ids.WorkspaceId): Event.ThreadCreated => ({
  id: Ids.EventId.make(`event_${threadId}_created`),
  thread_id: threadId,
  sequence: 1,
  version: 1,
  created_at: runtimeNow,
  type: "thread.created",
  data: { workspace_id: workspaceId },
})

const ConfigListReport = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      env: Schema.String,
      value: Schema.Unknown,
      source: Schema.String,
    }),
  ),
})

const expectOrbStoreMigrationsRepairUsage = (path: string, source: string) => {
  const violations = source
    .split("const storageLayer =")
    .slice(1)
    .flatMap((segment, index) => {
      const [storageBlock, migratedBlock = ""] = segment.split("const migratedStorageLayer =")

      return storageBlock?.includes("orbStoreLayer") === true &&
        !migratedBlock.slice(0, 600).includes("repairUsageIntervals")
        ? [`${path}: storageLayer ${index + 1}`]
        : []
    })

  expect(violations).toEqual([])
}

describe("CLI runtime", () => {
  const rawOutputLayer = (output: { stdout: Array<string>; stderr: Array<string> }) =>
    Layer.succeed(
      Output.Service,
      Output.Service.of({
        stdout: (line) =>
          Effect.sync(() => {
            output.stdout.push(`${line}\n`)
          }),
        stdoutRaw: (text) =>
          Effect.sync(() => {
            output.stdout.push(text)
          }),
        stderr: (line) =>
          Effect.sync(() => {
            output.stderr.push(`${line}\n`)
          }),
        stderrRaw: (text) =>
          Effect.sync(() => {
            output.stderr.push(text)
          }),
      }),
    )

  test("matches Amp's invalid -e shorthand error bytes", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const exitCode = await Effect.runPromise(
      Runtime.runProcess({ argv: ["-e"], env: {}, cwd: "/workspace/rika" }).pipe(
        Effect.provide(Output.memoryLayer(output)),
      ),
    )

    expect(exitCode).toBe(1)
    expect(output.stdout).toEqual([])
    expect(output.stderr).toEqual([Args.invalidExecuteAliasErrorText])
  })

  test("formats invalid settings env before live layer startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-runtime-invalid-settings-"))
    const home = join(root, "home")
    const cwd = join(root, "workspace")
    await mkdir(home, { recursive: true })
    await mkdir(cwd, { recursive: true })
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }

    try {
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({
          argv: ["-x", "hello"],
          env: {
            HOME: home,
            RIKA_COMPACTION_AUTO: "sometimes",
            RIKA_DATABASE_URL: "file::memory:",
            RIKA_TELEMETRY: "0",
          },
          cwd,
        }).pipe(Effect.provide(Output.memoryLayer(output))),
      )

      expect(exitCode).toBe(1)
      expect(output.stdout).toEqual([])
      expect(output.stderr).toEqual(["Rika failed: Invalid RIKA_COMPACTION_AUTO sometimes"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("formats invalid permission mode env before live layer startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-runtime-invalid-permission-"))
    const home = join(root, "home")
    const cwd = join(root, "workspace")
    await mkdir(home, { recursive: true })
    await mkdir(cwd, { recursive: true })
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }

    try {
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({
          argv: ["-x", "hello"],
          env: {
            HOME: home,
            RIKA_DATABASE_URL: "file::memory:",
            RIKA_PERMISSION_MODE: "bogus",
            RIKA_TELEMETRY: "0",
          },
          cwd,
        }).pipe(Effect.provide(Output.memoryLayer(output))),
      )

      expect(exitCode).toBe(1)
      expect(output.stdout).toEqual([])
      expect(output.stderr).toEqual(["Rika failed: Invalid RIKA_PERMISSION_MODE bogus"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("formats invalid model context window env before live layer startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-runtime-invalid-model-context-"))
    const home = join(root, "home")
    const cwd = join(root, "workspace")
    await mkdir(home, { recursive: true })
    await mkdir(cwd, { recursive: true })
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }

    try {
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({
          argv: ["-x", "hello"],
          env: {
            HOME: home,
            RIKA_DATABASE_URL: "file::memory:",
            RIKA_MODEL_CONTEXT_WINDOW: "1e3",
            RIKA_TELEMETRY: "0",
          },
          cwd,
        }).pipe(Effect.provide(Output.memoryLayer(output))),
      )

      expect(exitCode).toBe(1)
      expect(output.stdout).toEqual([])
      expect(output.stderr).toEqual(["Rika failed: Invalid RIKA_MODEL_CONTEXT_WINDOW 1e3"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("repairs orb usage intervals after migrations in every orb storage graph", async () => {
    expectOrbStoreMigrationsRepairUsage(
      "packages/cli/src/runtime.ts",
      await readFile(new URL("../src/runtime.ts", import.meta.url), "utf8"),
    )
    expectOrbStoreMigrationsRepairUsage(
      "apps/web/vite.config.ts",
      await readFile(new URL("../../../apps/web/vite.config.ts", import.meta.url), "utf8"),
    )
  })

  test("writes Amp's invalid -e shorthand error without a final newline", async () => {
    const output = { stdout: [] as Array<string>, stderr: [] as Array<string> }

    const exitCode = await Effect.runPromise(
      Runtime.runProcess({ argv: ["-e"], env: {}, cwd: "/workspace/rika" }).pipe(
        Effect.provide(rawOutputLayer(output)),
      ),
    )
    const stderr = output.stderr.join("")

    expect(exitCode).toBe(1)
    expect(output.stdout).toEqual([])
    expect(stderr).toBe(Args.invalidExecuteAliasErrorText)
    expect(stderr.endsWith("\n")).toBe(false)
  })

  test("rejects orb interactive mode until #49", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const exitCode = await Effect.runPromise(
      Runtime.runProcess({ argv: ["--orb"], env: {}, cwd: "/workspace/rika" }).pipe(
        Effect.provide(Output.memoryLayer(output)),
      ),
    )

    expect(exitCode).toBe(2)
    expect(output.stdout).toEqual([])
    expect(output.stderr).toEqual(["orb interactive mode arrives with #49"])
  })

  test("routes orb execute through orb project resolution", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rika-runtime-orb-"))
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }

    try {
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({
          argv: ["-ox", "hello"],
          env: { RIKA_DATA_DIR: join(workspace, ".rika") },
          cwd: workspace,
        }).pipe(Effect.provide(Output.memoryLayer(output))),
      )

      expect(exitCode).toBe(2)
      expect(output.stdout).toEqual([])
      expect(output.stderr).toEqual(["no project for this repo; run: rika project create <name> --repo <origin>"])
    } finally {
      await rm(workspace, { force: true, recursive: true })
    }
  })

  test("runs non-tournament thread commands without model credentials", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rika-runtime-threads-"))
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }

    try {
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({
          argv: ["threads", "list"],
          env: { RIKA_DATA_DIR: join(workspace, ".rika") },
          cwd: workspace,
        }).pipe(Effect.provide(Output.memoryLayer(output))),
      )

      expect(exitCode).toBe(0)
      expect(output.stderr).toEqual([])
    } finally {
      await rm(workspace, { force: true, recursive: true })
    }
  })

  test("writes Amp-compatible root help flags with raw stdout and reset stderr", async () => {
    for (const flag of ["--help", "-h"]) {
      const output = { stdout: [] as Array<string>, stderr: [] as Array<string> }
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({ argv: [flag], env: {}, cwd: "/workspace/rika" }).pipe(
          Effect.provide(rawOutputLayer(output)),
        ),
      )

      expect(exitCode).toBe(0)
      expect(output.stdout.join("")).toBe(Help.rootHelpStdoutText())
      expect(output.stderr.join("")).toBe(Help.terminalResetText)
      expect(output.stdout.join("").endsWith("\n\n\n")).toBe(true)
      expect(output.stderr.join("").endsWith("\n")).toBe(false)
    }
  })

  test("writes Amp-compatible version help flags with raw stdout and reset stderr", async () => {
    for (const flag of ["--help", "-h"]) {
      const output = { stdout: [] as Array<string>, stderr: [] as Array<string> }
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({ argv: ["version", flag], env: {}, cwd: "/workspace/rika" }).pipe(
          Effect.provide(rawOutputLayer(output)),
        ),
      )

      expect(exitCode).toBe(0)
      expect(output.stdout.join("")).toBe(Help.versionHelpStdoutText)
      expect(output.stderr.join("")).toBe(Help.terminalResetText)
      expect(output.stdout.join("").endsWith("\n")).toBe(true)
      expect(output.stderr.join("").endsWith("\n")).toBe(false)
    }
  })

  test("writes Amp-compatible logout help flags with raw stdout and reset stderr", async () => {
    for (const flag of ["--help", "-h"]) {
      const output = { stdout: [] as Array<string>, stderr: [] as Array<string> }
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({ argv: ["logout", flag], env: {}, cwd: "/workspace/rika" }).pipe(
          Effect.provide(rawOutputLayer(output)),
        ),
      )

      expect(exitCode).toBe(0)
      expect(output.stdout.join("")).toBe(Help.logoutHelpStdoutText())
      expect(output.stderr.join("")).toBe(Help.terminalResetText)
      expect(output.stdout.join("").endsWith("\n\n")).toBe(true)
      expect(output.stderr.join("").endsWith("\n")).toBe(false)
    }
  })

  test("writes Amp-compatible login help flags with raw stdout and reset stderr", async () => {
    for (const flag of ["--help", "-h"]) {
      const output = { stdout: [] as Array<string>, stderr: [] as Array<string> }
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({ argv: ["login", flag], env: {}, cwd: "/workspace/rika" }).pipe(
          Effect.provide(rawOutputLayer(output)),
        ),
      )

      expect(exitCode).toBe(0)
      expect(output.stdout.join("")).toBe(Help.loginHelpStdoutText())
      expect(output.stderr.join("")).toBe(Help.terminalResetText)
      expect(output.stdout.join("").endsWith("\n")).toBe(true)
      expect(output.stderr.join("").endsWith("\n")).toBe(false)
    }
  })

  test("writes Amp-compatible clone help flags with raw stdout and reset stderr", async () => {
    for (const flag of ["--help", "-h"]) {
      const output = { stdout: [] as Array<string>, stderr: [] as Array<string> }
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({ argv: ["clone", flag], env: {}, cwd: "/workspace/rika" }).pipe(
          Effect.provide(rawOutputLayer(output)),
        ),
      )

      expect(exitCode).toBe(0)
      expect(output.stdout.join("")).toBe(Help.cloneHelpStdoutText())
      expect(output.stderr.join("")).toBe(Help.terminalResetText)
      expect(output.stdout.join("").endsWith("\n\n")).toBe(true)
      expect(output.stderr.join("").endsWith("\n")).toBe(false)
    }
  })

  test("writes Amp-compatible top help flags with raw stdout and reset stderr", async () => {
    for (const flag of ["--help", "-h"]) {
      const output = { stdout: [] as Array<string>, stderr: [] as Array<string> }
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({ argv: ["top", flag], env: {}, cwd: "/workspace/rika" }).pipe(
          Effect.provide(rawOutputLayer(output)),
        ),
      )

      expect(exitCode).toBe(0)
      expect(output.stdout.join("")).toBe(Help.topHelpStdoutText())
      expect(output.stderr.join("")).toBe(Help.terminalResetText)
      expect(output.stdout.join("").endsWith("\n\n")).toBe(true)
      expect(output.stderr.join("").endsWith("\n")).toBe(false)
    }
  })

  test("writes Amp-compatible last help flags with raw stdout and reset stderr", async () => {
    for (const flag of ["--help", "-h"]) {
      const output = { stdout: [] as Array<string>, stderr: [] as Array<string> }
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({ argv: ["last", flag], env: {}, cwd: "/workspace/rika" }).pipe(
          Effect.provide(rawOutputLayer(output)),
        ),
      )

      expect(exitCode).toBe(0)
      expect(output.stdout.join("")).toBe(Help.lastHelpStdoutText())
      expect(output.stderr.join("")).toBe(Help.terminalResetText)
      expect(output.stdout.join("").endsWith("\n\n")).toBe(true)
      expect(output.stderr.join("").endsWith("\n")).toBe(false)
    }
  })

  test("writes Amp-compatible threads help flags with raw stdout and reset stderr", async () => {
    for (const flag of ["--help", "-h"]) {
      const output = { stdout: [] as Array<string>, stderr: [] as Array<string> }
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({ argv: ["threads", flag], env: {}, cwd: "/workspace/rika" }).pipe(
          Effect.provide(rawOutputLayer(output)),
        ),
      )

      expect(exitCode).toBe(0)
      expect(output.stdout.join("")).toBe(Help.threadsHelpStdoutText())
      expect(output.stderr.join("")).toBe(Help.terminalResetText)
      expect(output.stdout.join("").endsWith("\n\n")).toBe(true)
      expect(output.stderr.join("").endsWith("\n")).toBe(false)
    }
  })

  test("writes Amp-compatible threads new help flags with raw stdout and reset stderr", async () => {
    for (const flag of ["--help", "-h"]) {
      const output = { stdout: [] as Array<string>, stderr: [] as Array<string> }
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({ argv: ["threads", "new", flag], env: {}, cwd: "/workspace/rika" }).pipe(
          Effect.provide(rawOutputLayer(output)),
        ),
      )

      expect(exitCode).toBe(0)
      expect(output.stdout.join("")).toBe(Help.threadsNewHelpStdoutText())
      expect(output.stderr.join("")).toBe(Help.terminalResetText)
      expect(output.stdout.join("").endsWith("\n\n")).toBe(true)
      expect(output.stderr.join("").endsWith("\n")).toBe(false)
    }
  })

  test("writes Amp-compatible threads continue help flags with raw stdout and reset stderr", async () => {
    for (const flag of ["--help", "-h"]) {
      const output = { stdout: [] as Array<string>, stderr: [] as Array<string> }
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({ argv: ["threads", "continue", flag], env: {}, cwd: "/workspace/rika" }).pipe(
          Effect.provide(rawOutputLayer(output)),
        ),
      )

      expect(exitCode).toBe(0)
      expect(output.stdout.join("")).toBe(Help.threadsContinueHelpStdoutText())
      expect(output.stderr.join("")).toBe(Help.terminalResetText)
      expect(output.stdout.join("").endsWith("\n\n")).toBe(true)
      expect(output.stderr.join("").endsWith("\n")).toBe(false)
    }
  })

  test("writes Amp-compatible threads list help flags with raw stdout and reset stderr", async () => {
    for (const flag of ["--help", "-h"]) {
      const output = { stdout: [] as Array<string>, stderr: [] as Array<string> }
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({ argv: ["threads", "list", flag], env: {}, cwd: "/workspace/rika" }).pipe(
          Effect.provide(rawOutputLayer(output)),
        ),
      )

      expect(exitCode).toBe(0)
      expect(output.stdout.join("")).toBe(Help.threadsListHelpStdoutText())
      expect(output.stderr.join("")).toBe(Help.terminalResetText)
      expect(output.stdout.join("").endsWith("\n\n")).toBe(true)
      expect(output.stderr.join("").endsWith("\n")).toBe(false)
    }
  })

  test("writes Amp-compatible threads usage help flags with raw stdout and reset stderr", async () => {
    for (const flag of ["--help", "-h"]) {
      const output = { stdout: [] as Array<string>, stderr: [] as Array<string> }
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({ argv: ["threads", "usage", flag], env: {}, cwd: "/workspace/rika" }).pipe(
          Effect.provide(rawOutputLayer(output)),
        ),
      )

      expect(exitCode).toBe(0)
      expect(output.stdout.join("")).toBe(Help.threadsUsageHelpStdoutText())
      expect(output.stderr.join("")).toBe(Help.terminalResetText)
      expect(output.stdout.join("").endsWith("\n\n")).toBe(true)
      expect(output.stderr.join("").endsWith("\n")).toBe(false)
    }
  })

  test("writes Amp-compatible threads visibility help flags with raw stdout and reset stderr", async () => {
    for (const flag of ["--help", "-h"]) {
      const output = { stdout: [] as Array<string>, stderr: [] as Array<string> }
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({ argv: ["threads", "visibility", flag], env: {}, cwd: "/workspace/rika" }).pipe(
          Effect.provide(rawOutputLayer(output)),
        ),
      )

      expect(exitCode).toBe(0)
      expect(output.stdout.join("")).toBe(Help.threadsVisibilityHelpStdoutText())
      expect(output.stderr.join("")).toBe(Help.terminalResetText)
      expect(output.stdout.join("").endsWith("\n\n")).toBe(true)
      expect(output.stderr.join("").endsWith("\n")).toBe(false)
    }
  })

  test("writes Amp-compatible threads label help flags with raw stdout and reset stderr", async () => {
    for (const flag of ["--help", "-h"]) {
      const output = { stdout: [] as Array<string>, stderr: [] as Array<string> }
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({ argv: ["threads", "label", flag], env: {}, cwd: "/workspace/rika" }).pipe(
          Effect.provide(rawOutputLayer(output)),
        ),
      )

      expect(exitCode).toBe(0)
      expect(output.stdout.join("")).toBe(Help.threadsLabelHelpStdoutText())
      expect(output.stderr.join("")).toBe(Help.terminalResetText)
      expect(output.stdout.join("").endsWith("\n\n")).toBe(true)
      expect(output.stderr.join("").endsWith("\n")).toBe(false)
    }
  })

  test("writes Amp-compatible threads share help flags with raw stdout and reset stderr", async () => {
    for (const flag of ["--help", "-h"]) {
      const output = { stdout: [] as Array<string>, stderr: [] as Array<string> }
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({ argv: ["threads", "share", flag], env: {}, cwd: "/workspace/rika" }).pipe(
          Effect.provide(rawOutputLayer(output)),
        ),
      )

      expect(exitCode).toBe(0)
      expect(output.stdout.join("")).toBe(Help.threadsShareHelpStdoutText())
      expect(output.stderr.join("")).toBe(Help.terminalResetText)
      expect(output.stdout.join("").endsWith("\n\n")).toBe(true)
      expect(output.stderr.join("").endsWith("\n")).toBe(false)
    }
  })

  test("writes Amp-compatible threads search help flags with raw stdout and reset stderr", async () => {
    for (const flag of ["--help", "-h"]) {
      const output = { stdout: [] as Array<string>, stderr: [] as Array<string> }
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({ argv: ["threads", "search", flag], env: {}, cwd: "/workspace/rika" }).pipe(
          Effect.provide(rawOutputLayer(output)),
        ),
      )

      expect(exitCode).toBe(0)
      const stdout = output.stdout.join("")
      expect(stdout).toBe(Help.threadsSearchHelpStdoutText())
      expect(stdout).toContain("file:src/foo.ts after:7d archived:false project:backend")
      expect(stdout).not.toContain("repo:")
      expect(stdout).not.toContain("ref:")
      expect(output.stderr.join("")).toBe(Help.terminalResetText)
      expect(stdout.endsWith("\n\n")).toBe(true)
      expect(output.stderr.join("").endsWith("\n")).toBe(false)
    }
  })

  test("writes Amp-compatible config help flags with raw stdout and reset stderr", async () => {
    for (const flag of ["--help", "-h"]) {
      const output = { stdout: [] as Array<string>, stderr: [] as Array<string> }
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({ argv: ["config", flag], env: {}, cwd: "/workspace/rika" }).pipe(
          Effect.provide(rawOutputLayer(output)),
        ),
      )

      expect(exitCode).toBe(0)
      expect(output.stdout.join("")).toBe(Help.configHelpStdoutText())
      expect(output.stderr.join("")).toBe(Help.terminalResetText)
      expect(output.stdout.join("").endsWith("\n\n")).toBe(true)
      expect(output.stderr.join("").endsWith("\n")).toBe(false)
    }
  })

  test("writes Amp-compatible config keymap help flags with raw stdout and reset stderr", async () => {
    for (const flag of ["--help", "-h"]) {
      const output = { stdout: [] as Array<string>, stderr: [] as Array<string> }
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({ argv: ["config", "keymap", flag], env: {}, cwd: "/workspace/rika" }).pipe(
          Effect.provide(rawOutputLayer(output)),
        ),
      )

      expect(exitCode).toBe(0)
      expect(output.stdout.join("")).toBe(Help.configKeymapHelpStdoutText())
      expect(output.stderr.join("")).toBe(Help.terminalResetText)
      expect(output.stdout.join("").endsWith("\n\n")).toBe(true)
      expect(output.stderr.join("").endsWith("\n")).toBe(false)
    }
  })

  test("writes Amp-compatible config edit help flags with raw stdout and reset stderr", async () => {
    for (const flag of ["--help", "-h"]) {
      const output = { stdout: [] as Array<string>, stderr: [] as Array<string> }
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({ argv: ["config", "edit", flag], env: {}, cwd: "/workspace/rika" }).pipe(
          Effect.provide(rawOutputLayer(output)),
        ),
      )

      expect(exitCode).toBe(0)
      expect(output.stdout.join("")).toBe(Help.configEditHelpStdoutText())
      expect(output.stderr.join("")).toBe(Help.terminalResetText)
      expect(output.stdout.join("").endsWith("\n\n")).toBe(true)
      expect(output.stderr.join("").endsWith("\n")).toBe(false)
    }
  })

  test("runs config list through the process entrypoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-runtime-config-list-"))
    const home = join(root, "home")
    const workspace = join(root, "workspace")
    await mkdir(join(home, ".config", "rika"), { recursive: true })
    await mkdir(join(workspace, ".rika"), { recursive: true })
    await writeFile(
      join(home, ".config", "rika", "settings.json"),
      JSON.stringify({
        "mode.default": "deep1",
        "telemetry.endpoint": "http://user-otel.test",
      }),
    )
    await writeFile(
      join(workspace, ".rika", "settings.json"),
      JSON.stringify({
        "telemetry.enabled": false,
      }),
    )
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }

    try {
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({
          argv: ["config", "list"],
          env: { HOME: home, RIKA_WORKSPACE_ROOT: workspace, RIKA_MODE: "rush" },
          cwd: workspace,
        }).pipe(Effect.provide(Output.memoryLayer(output))),
      )

      const report = Schema.decodeUnknownSync(ConfigListReport)(JSON.parse(output.stdout[0] ?? "{}"))
      expect(exitCode).toBe(0)
      expect(output.stderr).toEqual([])
      expect(report.entries).toEqual(
        expect.arrayContaining([
          { key: "mode.default", env: "RIKA_MODE", value: "rush", source: "env" },
          { key: "telemetry.enabled", env: "RIKA_TELEMETRY", value: false, source: "workspace" },
          {
            key: "telemetry.endpoint",
            env: "RIKA_TELEMETRY_ENDPOINT",
            value: "http://user-otel.test",
            source: "user",
          },
        ]),
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("runs workspace config edit through the process entrypoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-runtime-config-edit-"))
    const home = join(root, "home")
    const workspace = join(root, "workspace")
    const editor = join(root, "fake-editor.sh")
    await mkdir(workspace, { recursive: true })
    await writeFile(
      editor,
      ["#!/usr/bin/env bash", "cat > \"$1\" <<'JSON'", '{"mode.default":"deep2","unknown.key":true}', "JSON", ""].join(
        "\n",
      ),
    )
    await chmod(editor, 0o755)
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }

    try {
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({
          argv: ["config", "edit", "--workspace"],
          env: { HOME: home, EDITOR: editor },
          cwd: workspace,
        }).pipe(Effect.provide(Output.memoryLayer(output))),
      )

      const target = join(workspace, ".rika", "settings.json")
      expect(exitCode).toBe(0)
      expect(JSON.parse(await readFile(target, "utf8"))).toEqual({
        "mode.default": "deep2",
        "unknown.key": true,
      })
      expect(output.stdout).toEqual([`edited ${target}`])
      expect(output.stderr).toEqual([expect.stringContaining("unknown.key")])
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("rejects foreign extension thread ids through the process entrypoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-runtime-extension-thread-"))
    const home = join(root, "home")
    const workspace = join(root, "workspace")
    const data = join(root, "data")
    const threadId = Ids.ThreadId.make("thread_runtime_extension_foreign")
    const otherWorkspaceId = Ids.WorkspaceId.make("workspace_runtime_extension_foreign")
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }

    try {
      await mkdir(workspace, { recursive: true })
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* Migration.migrate()
          yield* ThreadProjection.apply(threadCreated(threadId, otherWorkspaceId))
        }).pipe(
          Effect.provide(
            Layer.mergeAll(Database.layerFromPath(join(data, "rika.sqlite")), Migration.layer, ThreadProjection.layer),
          ),
        ),
      )

      const exitCode = await Effect.runPromise(
        Runtime.runProcess({
          argv: [
            "extensions",
            "create-plugin",
            "foreign-plugin",
            "--description",
            "Foreign plugin",
            "--thread",
            threadId,
          ],
          env: { HOME: home, RIKA_WORKSPACE_ROOT: workspace, RIKA_DATA_DIR: data },
          cwd: workspace,
        }).pipe(Effect.provide(Output.memoryLayer(output))),
      )

      expect(exitCode).toBe(1)
      expect(output.stdout).toEqual([])
      expect(output.stderr).toEqual([
        `Rika failed: Thread ${threadId} belongs to workspace ${otherWorkspaceId}, not ${workspace}`,
      ])
      const pluginWasWritten = await readFile(
        join(workspace, ".rika", "plugins", "foreign-plugin.ts.disabled"),
        "utf8",
      ).then(
        () => true,
        () => false,
      )
      expect(pluginWasWritten).toBe(false)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("writes Amp-compatible mcp help flags with raw stdout and reset stderr", async () => {
    for (const flag of ["--help", "-h"]) {
      const output = { stdout: [] as Array<string>, stderr: [] as Array<string> }
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({ argv: ["mcp", flag], env: {}, cwd: "/workspace/rika" }).pipe(
          Effect.provide(rawOutputLayer(output)),
        ),
      )

      expect(exitCode).toBe(0)
      expect(output.stdout.join("")).toBe(Help.mcpHelpStdoutText())
      expect(output.stderr.join("")).toBe(Help.terminalResetText)
      expect(output.stdout.join("").endsWith("\n\n")).toBe(true)
      expect(output.stderr.join("").endsWith("\n")).toBe(false)
    }
  })

  test("writes Amp-compatible mcp add help flags with raw stdout and reset stderr", async () => {
    for (const flag of ["--help", "-h"]) {
      const output = { stdout: [] as Array<string>, stderr: [] as Array<string> }
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({ argv: ["mcp", "add", flag], env: {}, cwd: "/workspace/rika" }).pipe(
          Effect.provide(rawOutputLayer(output)),
        ),
      )

      expect(exitCode).toBe(0)
      expect(output.stdout.join("")).toBe(Help.mcpAddHelpStdoutText())
      expect(output.stderr.join("")).toBe(Help.terminalResetText)
      expect(output.stdout.join("").endsWith("\n\n")).toBe(true)
      expect(output.stderr.join("").endsWith("\n")).toBe(false)
    }
  })

  test("writes Amp-compatible mcp list help flags with raw stdout and reset stderr", async () => {
    for (const flag of ["--help", "-h"]) {
      const output = { stdout: [] as Array<string>, stderr: [] as Array<string> }
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({ argv: ["mcp", "list", flag], env: {}, cwd: "/workspace/rika" }).pipe(
          Effect.provide(rawOutputLayer(output)),
        ),
      )

      expect(exitCode).toBe(0)
      expect(output.stdout.join("")).toBe(Help.mcpListHelpStdoutText())
      expect(output.stderr.join("")).toBe(Help.terminalResetText)
      expect(output.stdout.join("").endsWith("\n\n")).toBe(true)
      expect(output.stderr.join("").endsWith("\n")).toBe(false)
    }
  })

  test("writes Amp-compatible mcp doctor help flags with raw stdout and reset stderr", async () => {
    for (const flag of ["--help", "-h"]) {
      const output = { stdout: [] as Array<string>, stderr: [] as Array<string> }
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({ argv: ["mcp", "doctor", flag], env: {}, cwd: "/workspace/rika" }).pipe(
          Effect.provide(rawOutputLayer(output)),
        ),
      )

      expect(exitCode).toBe(0)
      expect(output.stdout.join("")).toBe(Help.mcpDoctorHelpStdoutText())
      expect(output.stderr.join("")).toBe(Help.terminalResetText)
      expect(output.stdout.join("").endsWith("\n\n")).toBe(true)
      expect(output.stderr.join("").endsWith("\n")).toBe(false)
    }
  })

  test("writes Amp-compatible mcp oauth help flags with raw stdout and no stderr", async () => {
    for (const flag of ["--help", "-h"]) {
      const output = { stdout: [] as Array<string>, stderr: [] as Array<string> }
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({ argv: ["mcp", "oauth", flag], env: {}, cwd: "/workspace/rika" }).pipe(
          Effect.provide(rawOutputLayer(output)),
        ),
      )

      expect(exitCode).toBe(0)
      expect(output.stdout.join("")).toBe(Help.mcpOauthHelpStdoutText)
      expect(output.stderr.join("")).toBe("")
      expect(output.stdout.join("").endsWith("\n")).toBe(true)
    }
  })

  test("writes Amp-compatible mcp oauth login help flags with raw stdout and no stderr", async () => {
    for (const flag of ["--help", "-h"]) {
      const output = { stdout: [] as Array<string>, stderr: [] as Array<string> }
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({ argv: ["mcp", "oauth", "login", flag], env: {}, cwd: "/workspace/rika" }).pipe(
          Effect.provide(rawOutputLayer(output)),
        ),
      )

      expect(exitCode).toBe(0)
      expect(output.stdout.join("")).toBe(Help.mcpOauthLoginHelpStdoutText)
      expect(output.stderr.join("")).toBe("")
      expect(output.stdout.join("").endsWith("\n")).toBe(true)
    }
  })

  test("writes Amp-compatible mcp oauth logout help flags with raw stdout and no stderr", async () => {
    for (const flag of ["--help", "-h"]) {
      const output = { stdout: [] as Array<string>, stderr: [] as Array<string> }
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({ argv: ["mcp", "oauth", "logout", flag], env: {}, cwd: "/workspace/rika" }).pipe(
          Effect.provide(rawOutputLayer(output)),
        ),
      )

      expect(exitCode).toBe(0)
      expect(output.stdout.join("")).toBe(Help.mcpOauthLogoutHelpStdoutText)
      expect(output.stderr.join("")).toBe("")
      expect(output.stdout.join("").endsWith("\n")).toBe(true)
    }
  })

  test("writes Amp-compatible mcp oauth status help flags with raw stdout and no stderr", async () => {
    for (const flag of ["--help", "-h"]) {
      const output = { stdout: [] as Array<string>, stderr: [] as Array<string> }
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({ argv: ["mcp", "oauth", "status", flag], env: {}, cwd: "/workspace/rika" }).pipe(
          Effect.provide(rawOutputLayer(output)),
        ),
      )

      expect(exitCode).toBe(0)
      expect(output.stdout.join("")).toBe(Help.mcpOauthStatusHelpStdoutText)
      expect(output.stderr.join("")).toBe("")
      expect(output.stdout.join("").endsWith("\n")).toBe(true)
    }
  })

  test("writes Amp-compatible mcp remove help flags with raw stdout and reset stderr", async () => {
    for (const flag of ["--help", "-h"]) {
      const output = { stdout: [] as Array<string>, stderr: [] as Array<string> }
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({ argv: ["mcp", "remove", flag], env: {}, cwd: "/workspace/rika" }).pipe(
          Effect.provide(rawOutputLayer(output)),
        ),
      )

      expect(exitCode).toBe(0)
      expect(output.stdout.join("")).toBe(Help.mcpRemoveHelpStdoutText())
      expect(output.stderr.join("")).toBe(Help.terminalResetText)
      expect(output.stdout.join("").endsWith("\n\n")).toBe(true)
      expect(output.stderr.join("").endsWith("\n")).toBe(false)
    }
  })

  test("writes Amp-compatible mcp approve help flags with raw stdout and reset stderr", async () => {
    for (const flag of ["--help", "-h"]) {
      const output = { stdout: [] as Array<string>, stderr: [] as Array<string> }
      const exitCode = await Effect.runPromise(
        Runtime.runProcess({ argv: ["mcp", "approve", flag], env: {}, cwd: "/workspace/rika" }).pipe(
          Effect.provide(rawOutputLayer(output)),
        ),
      )

      expect(exitCode).toBe(0)
      expect(output.stdout.join("")).toBe(Help.mcpApproveHelpStdoutText())
      expect(output.stderr.join("")).toBe(Help.terminalResetText)
      expect(output.stdout.join("").endsWith("\n\n")).toBe(true)
      expect(output.stderr.join("").endsWith("\n")).toBe(false)
    }
  })
})
