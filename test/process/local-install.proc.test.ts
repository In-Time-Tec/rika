import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"

const root = fileURLToPath(new URL("../..", import.meta.url))
const version: string = (await Bun.file(join(root, "apps", "rika", "package.json")).json()).version
const target = "install-test"
const archive = join(root, "artifacts", `rika-${version}-${target}.tar.gz`)

const run = async (script: string, environment: Readonly<Record<string, string>>) => {
  const child = Bun.spawn(["bun", "run", script], {
    cwd: root,
    env: { ...process.env, ...environment },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`${script} failed\n${stderr}\n${stdout}`)
}

const makeArchive = async (directory: string, marker: string) => {
  const payload = join(directory, `rika-${version}-${target}`)
  await mkdir(join(payload, "bin"), { recursive: true })
  await writeFile(join(payload, "INSTALL"), "install fixture\n")
  await writeFile(join(payload, "bin", "rika"), marker)
  await writeFile(join(payload, "bin", ".rika-performance"), `performance-${marker}`)
  await writeFile(join(payload, "bin", ".rika-interactive"), `interactive-${marker}`)
  await writeFile(join(payload, "bin", ".rika-server"), `server-${marker}`)
  await chmod(join(payload, "bin", "rika"), 0o755)
  await chmod(join(payload, "bin", ".rika-performance"), 0o755)
  await chmod(join(payload, "bin", ".rika-interactive"), 0o755)
  await chmod(join(payload, "bin", ".rika-server"), 0o755)
  const child = Bun.spawn(["tar", "-czf", archive, `rika-${version}-${target}`], { cwd: directory })
  expect(await child.exited).toBe(0)
}

test("installs, upgrades, and uninstalls a versioned split-runtime package without deleting state", async () => {
  const home = await mkdtemp(join(tmpdir(), "rika-local-install-"))
  const installRoot = join(home, "install")
  const binDir = join(home, "bin")
  const state = join(home, ".rika", "state")
  const environment = {
    HOME: home,
    RIKA_PACKAGE_TARGET: target,
    RIKA_INSTALL_ROOT: installRoot,
    RIKA_BIN_DIR: binDir,
  }
  await mkdir(join(root, "artifacts"), { recursive: true })
  await mkdir(join(home, ".rika"), { recursive: true })
  await writeFile(state, "preserve")
  try {
    await makeArchive(home, "first")
    await run("scripts/installation/install-local.ts", environment)
    expect(await readlink(join(binDir, "rika-dev"))).toBe(join(installRoot, "bin", "rika"))
    expect(await readFile(join(installRoot, "bin", "rika"), "utf8")).toBe("first")
    expect(await readFile(join(installRoot, "bin", ".rika-performance"), "utf8")).toBe("performance-first")
    expect(await readFile(join(installRoot, "bin", ".rika-interactive"), "utf8")).toBe("interactive-first")
    expect(await readFile(join(installRoot, "bin", ".rika-server"), "utf8")).toBe("server-first")

    await makeArchive(home, "second")
    await run("scripts/installation/install-local.ts", environment)
    expect(await readFile(join(installRoot, "bin", "rika"), "utf8")).toBe("second")
    expect(await readFile(state, "utf8")).toBe("preserve")

    await run("scripts/installation/uninstall-local.ts", environment)
    await expect(stat(join(binDir, "rika-dev"))).rejects.toThrow()
    await expect(stat(installRoot)).rejects.toThrow()
    expect(await readFile(state, "utf8")).toBe("preserve")
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(archive, { force: true })
  }
})
