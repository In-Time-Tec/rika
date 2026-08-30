import { Effect, FileSystem, Path, PlatformError, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { expect, test } from "vitest"
import { live } from "../support/platform"
import {
  kernelRuntime,
  kernelWorker,
  packageBinEntries,
  packageExecutable,
} from "../../scripts/packaging/package-contract"

const rootUrl = new URL("../..", import.meta.url)

const target = (() => {
  const operatingSystem = process.platform === "darwin" ? "darwin" : "linux"
  const architecture = process.arch === "arm64" ? "arm64" : "x64"
  return `${operatingSystem}-${architecture}`
})()

const collect = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (output, chunk) => output + chunk,
    ),
  )

const run = Effect.fn("installUpgrade.run")(function* (
  root: string,
  installer: string,
  environment: Readonly<Record<string, string>>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const child = yield* spawner.spawn(
    ChildProcess.make("sh", [installer], {
      cwd: root,
      env: { ...process.env, ...environment },
      stdout: "pipe",
      stderr: "pipe",
    }),
  )
  const [exitCode, stdout, stderr] = yield* Effect.all([child.exitCode, collect(child.stdout), collect(child.stderr)], {
    concurrency: "unbounded",
  })
  return { exitCode: Number(exitCode), stdout, stderr }
})

const publish = Effect.fn("installUpgrade.publish")(function* (
  releases: string,
  version: string,
  marker: string,
  tamper: boolean,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const payloadRoot = `rika-${version}-${target}`
  const stage = path.join(releases, "stage")
  const payload = path.join(stage, payloadRoot)
  yield* fileSystem.remove(stage, { recursive: true, force: true })
  yield* fileSystem.makeDirectory(path.join(payload, "bin"), { recursive: true })
  yield* fileSystem.writeFileString(path.join(payload, "INSTALL"), "install fixture\n")
  yield* Effect.forEach(
    packageBinEntries,
    (entry) =>
      fileSystem.writeFileString(
        path.join(payload, "bin", entry),
        entry === packageExecutable ? marker : `${entry} ${marker}`,
      ),
    { concurrency: "unbounded", discard: true },
  )
  yield* fileSystem.chmod(path.join(payload, "bin", packageExecutable), 0o755)
  yield* fileSystem.chmod(path.join(payload, "bin", kernelRuntime), 0o755)
  const archiveFile = `rika-${version}-${target}.tar.gz`
  const archivePath = path.join(releases, archiveFile)
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const exitCode = yield* spawner.exitCode(ChildProcess.make("tar", ["-czf", archivePath, payloadRoot], { cwd: stage }))
  expect(Number(exitCode)).toBe(0)
  const bytes = yield* fileSystem.readFile(archivePath)
  const honest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  const digest = tamper ? "0".repeat(64) : honest
  yield* fileSystem.writeFileString(path.join(releases, "SHA256SUMS"), `${digest}  ${archiveFile}\n`)
  yield* fileSystem.writeFileString(path.join(releases, "latest.json"), `{"tag_name": "v${version}"}\n`)
  yield* fileSystem.remove(stage, { recursive: true, force: true })
})

const strays = Effect.fn("installUpgrade.strays")(function* (directory: string) {
  const fileSystem = yield* FileSystem.FileSystem
  return (yield* fileSystem.readDirectory(directory)).filter((entry) => entry.startsWith(".rika-"))
})

const acceptance = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* path.fromFileUrl(rootUrl)
  const installer = path.join(root, "install.sh")
  const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-install-upgrade-" })
  const releases = path.join(home, "releases")
  const installRoot = path.join(home, "share", "rika", "current")
  const binDir = path.join(home, "bin")
  const command = path.join(binDir, "rika")
  const environment = {
    HOME: home,
    RIKA_INSTALL_ROOT: installRoot,
    RIKA_BIN_DIR: binDir,
    RIKA_RELEASE_BASE_URL: `file://${releases}`,
    RIKA_RELEASE_API_URL: `file://${path.join(releases, "latest.json")}`,
  }
  yield* fileSystem.makeDirectory(releases, { recursive: true })
  yield* publish(releases, "1.0.0", "first", false)
  const fresh = yield* run(root, installer, environment)
  expect(fresh.stderr).toBe("")
  expect(fresh.exitCode).toBe(0)
  expect(yield* fileSystem.readLink(command)).toBe(path.join(installRoot, "bin", "rika"))
  expect(yield* fileSystem.readFileString(command)).toBe("first")

  yield* fileSystem.writeFileString(path.join(installRoot, "bin", ".rika-interactive"), "stale interactive")
  yield* fileSystem.writeFileString(path.join(installRoot, "bin", ".rika-performance"), "stale performance")
  yield* fileSystem.writeFileString(path.join(installRoot, "bin", ".rika-kernel-runtime"), "stale runtime")
  yield* fileSystem.writeFileString(path.join(installRoot, "bin", ".rika-kernel-worker.js"), "stale worker")
  yield* publish(releases, "1.0.1", "second", false)
  const upgrade = yield* run(root, installer, environment)
  expect(upgrade.stderr).toBe("")
  expect(upgrade.exitCode).toBe(0)
  expect(yield* fileSystem.readFileString(command)).toBe("second")
  expect(yield* fileSystem.readFileString(path.join(installRoot, "bin", kernelRuntime))).toBe(`${kernelRuntime} second`)
  expect(yield* fileSystem.readFileString(path.join(installRoot, "bin", kernelWorker))).toBe(`${kernelWorker} second`)
  for (const stale of [".rika-interactive", ".rika-performance", ".rika-server"]) {
    expect(yield* fileSystem.exists(path.join(installRoot, "bin", stale))).toBe(false)
  }
  expect(yield* strays(path.dirname(installRoot))).toEqual([])
  expect(yield* strays(binDir)).toEqual([])

  yield* publish(releases, "1.0.2", "tampered", true)
  const rejected = yield* run(root, installer, environment)
  expect(rejected.exitCode).not.toBe(0)
  expect(rejected.stderr).toContain("checksum mismatch")
  expect(yield* fileSystem.readFileString(command)).toBe("second")
  expect(yield* fileSystem.readFileString(path.join(installRoot, "bin", "rika"))).toBe("second")
  expect(yield* strays(path.dirname(installRoot))).toEqual([])

  yield* publish(releases, "1.0.3", "third", false)
  yield* fileSystem.remove(command)
  yield* fileSystem.writeFileString(command, "a rika from somewhere else")
  const refused = yield* run(root, installer, environment)
  expect(refused.exitCode).not.toBe(0)
  expect(refused.stderr).toContain("was not installed by this script")
  expect(yield* fileSystem.readFileString(command)).toBe("a rika from somewhere else")

  const forced = yield* run(root, installer, { ...environment, RIKA_FORCE_LINK: "1" })
  expect(forced.stderr).toBe("")
  expect(forced.exitCode).toBe(0)
  expect(yield* fileSystem.readLink(command)).toBe(path.join(installRoot, "bin", "rika"))
  expect(yield* fileSystem.readFileString(command)).toBe("third")
})

test("re-running the installer upgrades in place, verifies checksums, and never adopts a foreign command", () =>
  Effect.runPromise(live(acceptance)))
