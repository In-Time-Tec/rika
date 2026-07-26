import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"

const root = fileURLToPath(new URL("../..", import.meta.url))
const installer = join(root, "install.sh")

const target = (() => {
  const operatingSystem = process.platform === "darwin" ? "darwin" : "linux"
  const architecture = process.arch === "arm64" ? "arm64" : "x64"
  return `${operatingSystem}-${architecture}`
})()

const run = async (environment: Readonly<Record<string, string>>) => {
  const child = Bun.spawn(["sh", installer], {
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
  return { exitCode, stdout, stderr }
}

const publish = async (releases: string, version: string, marker: string, tamper: boolean) => {
  const payloadRoot = `rika-${version}-${target}`
  const stage = join(releases, "stage")
  const payload = join(stage, payloadRoot)
  await rm(stage, { recursive: true, force: true })
  await mkdir(join(payload, "bin"), { recursive: true })
  await writeFile(join(payload, "INSTALL"), "install fixture\n")
  await writeFile(join(payload, "bin", "rika"), marker)
  await writeFile(join(payload, "bin", ".rika-runtime"), `runtime-${marker}`)
  await chmod(join(payload, "bin", "rika"), 0o755)
  await chmod(join(payload, "bin", ".rika-runtime"), 0o755)
  const archiveFile = `rika-${version}-${target}.tar.gz`
  const archivePath = join(releases, archiveFile)
  const child = Bun.spawn(["tar", "-czf", archivePath, payloadRoot], { cwd: stage })
  expect(await child.exited).toBe(0)
  const bytes = new Uint8Array(await Bun.file(archivePath).arrayBuffer())
  const honest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  const digest = tamper ? "0".repeat(64) : honest
  await writeFile(join(releases, "SHA256SUMS"), `${digest}  ${archiveFile}\n`)
  await writeFile(join(releases, "latest.json"), `{"tag_name": "v${version}"}\n`)
  await rm(stage, { recursive: true, force: true })
}

const strays = async (directory: string) => (await readdir(directory)).filter((entry) => entry.startsWith(".rika-"))

test("re-running the installer upgrades in place, verifies checksums, and never adopts a foreign command", async () => {
  const home = await mkdtemp(join(tmpdir(), "rika-install-upgrade-"))
  const releases = join(home, "releases")
  const installRoot = join(home, "share", "rika", "current")
  const binDir = join(home, "bin")
  const command = join(binDir, "rika")
  const environment = {
    HOME: home,
    RIKA_INSTALL_ROOT: installRoot,
    RIKA_BIN_DIR: binDir,
    RIKA_RELEASE_BASE_URL: `file://${releases}`,
    RIKA_RELEASE_API_URL: `file://${join(releases, "latest.json")}`,
  }
  await mkdir(releases, { recursive: true })
  try {
    await publish(releases, "1.0.0", "first", false)
    const fresh = await run(environment)
    expect(fresh.stderr).toBe("")
    expect(fresh.exitCode).toBe(0)
    expect(await readlink(command)).toBe(join(installRoot, "bin", "rika"))
    expect(await readFile(command, "utf8")).toBe("first")

    await publish(releases, "1.0.1", "second", false)
    const upgrade = await run(environment)
    expect(upgrade.stderr).toBe("")
    expect(upgrade.exitCode).toBe(0)
    expect(await readFile(command, "utf8")).toBe("second")
    expect(await readFile(join(installRoot, "bin", ".rika-runtime"), "utf8")).toBe("runtime-second")
    expect(await strays(dirname(installRoot))).toEqual([])
    expect(await strays(binDir)).toEqual([])

    await publish(releases, "1.0.2", "tampered", true)
    const rejected = await run(environment)
    expect(rejected.exitCode).not.toBe(0)
    expect(rejected.stderr).toContain("checksum mismatch")
    expect(await readFile(command, "utf8")).toBe("second")
    expect(await readFile(join(installRoot, "bin", "rika"), "utf8")).toBe("second")
    expect(await strays(dirname(installRoot))).toEqual([])

    await publish(releases, "1.0.3", "third", false)
    await rm(command)
    await writeFile(command, "a rika from somewhere else")
    const refused = await run(environment)
    expect(refused.exitCode).not.toBe(0)
    expect(refused.stderr).toContain("was not installed by this script")
    expect(await readFile(command, "utf8")).toBe("a rika from somewhere else")

    const forced = await run({ ...environment, RIKA_FORCE_LINK: "1" })
    expect(forced.stderr).toBe("")
    expect(forced.exitCode).toBe(0)
    expect(await readlink(command)).toBe(join(installRoot, "bin", "rika"))
    expect(await readFile(command, "utf8")).toBe("third")
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
