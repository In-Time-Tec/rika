import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = new URL("../..", import.meta.url).pathname
const temporary = await mkdtemp(join(tmpdir(), "rika-local-install-"))
const installRoot = join(temporary, "install", "current")
const binDir = join(temporary, "bin")
const home = join(temporary, "home")
const state = join(temporary, "state")
const env = { ...process.env, HOME: home, RIKA_INSTALL_ROOT: installRoot, RIKA_BIN_DIR: binDir }
const runScript = (name: string) => Bun.spawnSync(["bun", "run", `scripts/${name}.ts`], { cwd: root, env })
const runRika = (args: string[]) =>
  Bun.spawnSync(["rika", ...args], {
    cwd: temporary,
    env: {
      ...env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      RIKA_DATABASE: join(state, "rika.db"),
      RIKA_RELAY_DATABASE: join(state, "relay.db"),
      RIKA_TEST_MODEL_RESPONSE: "deterministic response",
    },
  })

beforeEach(async () => {
  await rm(installRoot, { recursive: true, force: true })
  await rm(binDir, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
  await mkdir(home, { recursive: true })
})

afterAll(async () => {
  await rm(temporary, { recursive: true, force: true })
})

describe("local packaged installation", () => {
  test("installs, runs by PATH name, reinstalls, and uninstalls idempotently", async () => {
    const installed = runScript("install-local")
    expect(installed.exitCode, installed.stderr.toString()).toBe(0)
    expect((await lstat(join(binDir, "rika"))).isSymbolicLink()).toBe(true)
    expect(await readlink(join(binDir, "rika"))).toBe(join(installRoot, "bin", "rika"))
    expect((await lstat(join(installRoot, "bin", "node_modules"))).isDirectory()).toBe(true)
    for (const args of [["--version"], ["--help"], ["tools", "list"]]) {
      const result = runRika(args)
      expect(result.exitCode, `${args.join(" ")}\n${result.stderr}`).toBe(0)
    }
    const executed = runRika(["run", "--ephemeral", "say hi"])
    expect(executed.exitCode, executed.stderr.toString()).toBe(0)
    expect(executed.stdout.toString()).toContain("deterministic response")
    expect(executed.stderr.toString()).not.toContain("TypeError: members.map is not a function")
    expect(executed.stderr.toString()).not.toContain("requires Crypto")
    const reinstalled = runScript("install-local")
    expect(reinstalled.exitCode, reinstalled.stderr.toString()).toBe(0)
    expect(runScript("uninstall-local").exitCode).toBe(0)
    expect(runScript("uninstall-local").exitCode).toBe(0)
    expect(await lstat(installRoot).catch(() => undefined)).toBeUndefined()
  }, 30_000)

  test("does not overwrite a foreign command", async () => {
    await mkdir(binDir, { recursive: true })
    const foreign = join(temporary, "foreign-rika")
    await writeFile(foreign, "foreign")
    await symlink(foreign, join(binDir, "rika"))
    const result = runScript("install-local")
    expect(result.exitCode).not.toBe(0)
    expect(await readlink(join(binDir, "rika"))).toBe(foreign)
    await rm(join(binDir, "rika"))
  })

  test("replaces the previous packaged Rika launcher", async () => {
    await mkdir(binDir, { recursive: true })
    await writeFile(
      join(binDir, "rika"),
      '#!/usr/bin/env sh\nSCRIPT_DIR=$(dirname "$0")\nSHARE_DIR="$SCRIPT_DIR/../share/rika"\nexec "$SCRIPT_DIR/rika-darwin-arm64.bin" "$@"\n',
      { mode: 0o755 },
    )
    const result = runScript("install-local")
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect((await lstat(join(binDir, "rika"))).isSymbolicLink()).toBe(true)
    expect(runScript("uninstall-local").exitCode).toBe(0)
  })
})
