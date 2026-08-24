import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path, PlatformError, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { live } from "../support/platform"

const PackageManifest = Schema.Struct({ version: Schema.String })
const target = "install-test"

const collect = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (output, chunk) => output + chunk,
    ),
  )

const run = Effect.fn("LocalInstallProc.run")(function* (
  root: string,
  script: string,
  environment: Readonly<Record<string, string>>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const child = yield* spawner.spawn(
    ChildProcess.make("bun", ["run", script], {
      cwd: root,
      env: { ...process.env, ...environment },
    }),
  )
  const [exitCode, stdout, stderr] = yield* Effect.all([child.exitCode, collect(child.stdout), collect(child.stderr)], {
    concurrency: "unbounded",
  })
  if (Number(exitCode) !== 0) return yield* Effect.die(new Error(`${script} failed\n${stderr}\n${stdout}`))
})

const makeArchive = Effect.fn("LocalInstallProc.makeArchive")(function* (
  directory: string,
  archive: string,
  version: string,
  marker: string,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const payload = path.join(directory, `rika-${version}-${target}`)
  yield* fileSystem.makeDirectory(path.join(payload, "bin"), { recursive: true })
  yield* fileSystem.writeFileString(path.join(payload, "INSTALL"), "install fixture\n")
  yield* fileSystem.writeFileString(path.join(payload, "bin", "rika"), marker, { mode: 0o755 })
  const exitCode = yield* spawner.exitCode(
    ChildProcess.make("tar", ["-czf", archive, `rika-${version}-${target}`], { cwd: directory }),
  )
  expect(Number(exitCode)).toBe(0)
})

it.effect("installs, upgrades, and uninstalls the packaged runtimes without deleting state", () =>
  live(
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* path.fromFileUrl(new URL("../..", import.meta.url))
        const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PackageManifest))(
          yield* fileSystem.readFileString(path.join(root, "apps", "rika", "package.json")),
        )
        const archive = path.join(root, "artifacts", `rika-${manifest.version}-${target}.tar.gz`)
        yield* fileSystem.makeDirectory(path.dirname(archive), { recursive: true })
        yield* Effect.addFinalizer(() => fileSystem.remove(archive, { force: true }).pipe(Effect.ignore))
        const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-local-install-" })
        const installRoot = path.join(home, "install")
        const binDir = path.join(home, "bin")
        const stateDirectory = path.join(home, ".rika")
        const state = path.join(stateDirectory, "state")
        const environment = {
          HOME: home,
          RIKA_PACKAGE_TARGET: target,
          RIKA_INSTALL_ROOT: installRoot,
          RIKA_BIN_DIR: binDir,
        }
        yield* fileSystem.makeDirectory(stateDirectory, { recursive: true })
        yield* fileSystem.writeFileString(state, "preserve")

        yield* makeArchive(home, archive, manifest.version, "first")
        yield* run(root, "scripts/installation/install-local.ts", environment)
        expect(yield* fileSystem.readLink(path.join(binDir, "rika-dev"))).toBe(path.join(installRoot, "bin", "rika"))
        expect(yield* fileSystem.readFileString(path.join(installRoot, "bin", "rika"))).toBe("first")
        expect(yield* fileSystem.readDirectory(path.join(installRoot, "bin"))).toEqual(["rika"])

        yield* fileSystem.writeFileString(path.join(installRoot, "bin", ".rika-interactive"), "stale")
        yield* fileSystem.writeFileString(path.join(installRoot, "bin", ".rika-performance"), "stale")
        yield* fileSystem.writeFileString(path.join(installRoot, "bin", ".rika-kernel-runtime"), "stale")
        yield* makeArchive(home, archive, manifest.version, "second")
        yield* run(root, "scripts/installation/install-local.ts", environment)
        expect(yield* fileSystem.readFileString(path.join(installRoot, "bin", "rika"))).toBe("second")
        expect(yield* fileSystem.readDirectory(path.join(installRoot, "bin"))).toEqual(["rika"])
        expect(yield* fileSystem.readFileString(state)).toBe("preserve")

        yield* run(root, "scripts/installation/uninstall-local.ts", environment)
        expect(yield* fileSystem.exists(path.join(binDir, "rika-dev"))).toBe(false)
        expect(yield* fileSystem.exists(installRoot)).toBe(false)
        expect(yield* fileSystem.readFileString(state)).toBe("preserve")
      }),
    ),
  ),
)
