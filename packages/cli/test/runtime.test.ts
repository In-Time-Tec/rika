import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { Args, Help, Output, Runtime } from "../src/index"

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
      expect(output.stdout.join("")).toBe(Help.threadsSearchHelpStdoutText())
      expect(output.stderr.join("")).toBe(Help.terminalResetText)
      expect(output.stdout.join("").endsWith("\n\n")).toBe(true)
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
