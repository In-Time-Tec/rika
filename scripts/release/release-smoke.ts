import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Data, Effect, FileSystem, Layer, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { runnerExecutorProcessRole, tuiControllerProcessRole } from "../../apps/rika/src/private-runtime-role"
import { validatePackageArchive } from "../packaging/archive-contract"

class ReleaseSmokeError extends Data.TaggedError("ReleaseSmokeError")<{
  readonly step: string
  readonly message: string
}> {}

const failure = (step: string, message: string) => new ReleaseSmokeError({ step, message })
const mapFailure = (step: string) =>
  Effect.mapError((error: { readonly message: string }) => failure(step, `${step}: ${error.message}`))

const program = Effect.scoped(
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const root = yield* path.fromFileUrl(new URL("../..", import.meta.url)).pipe(mapFailure("resolve project root"))
    const targetIndex = Bun.argv.indexOf("--target")
    const operatingSystem = process.platform === "darwin" ? "darwin" : "linux"
    const architecture = process.arch === "x64" ? "x64" : "arm64"
    const target = targetIndex < 0 ? `${operatingSystem}-${architecture}` : (Bun.argv[targetIndex + 1] ?? "")
    const version = (yield* fileSystem.readFileString(path.join(root, "apps", "rika", "package.json"))).match(
      /"version"\s*:\s*"([^"\n]+)"/,
    )?.[1]
    if (version === undefined) return yield* failure("read package version", "apps/rika/package.json has no version")
    const archiveRoot = `rika-${version}-${target}`
    const archive = path.join(root, "artifacts", `${archiveRoot}.tar.gz`)
    if (!(yield* fileSystem.exists(archive).pipe(mapFailure("check archive"))))
      return yield* failure("check archive", `Archive not found: ${archive}. Run bun run package first.`)
    const inventory = yield* spawner
      .string(ChildProcess.make("tar", ["-tzf", archive]))
      .pipe(mapFailure("inspect archive"))
    const headers = yield* spawner
      .string(ChildProcess.make("tar", ["-tvzf", archive]))
      .pipe(mapFailure("inspect archive"))
    yield* Effect.try({
      try: () => validatePackageArchive(archiveRoot, inventory, headers),
      catch: (cause) => failure("inspect archive", String(cause)),
    })
    if (inventory.split("\n").some((entry) => entry.includes("/.rika-") || entry.includes("/text-result.js")))
      return yield* failure("inspect archive", "Archive contains a hidden runtime artifact")

    const temporary = yield* fileSystem
      .makeTempDirectoryScoped({ prefix: "rika-release-smoke-" })
      .pipe(mapFailure("create smoke directory"))
    const extracted = yield* spawner
      .exitCode(ChildProcess.make("tar", ["-xzf", archive, "-C", temporary]))
      .pipe(mapFailure("extract archive"))
    if (Number(extracted) !== 0) return yield* failure("extract archive", `tar exited with code ${extracted}`)
    const binary = path.join(temporary, archiveRoot, "bin", "rika")
    const runBinary = (arguments_: ReadonlyArray<string>, environment: Readonly<Record<string, string>> = {}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const step = `run rika ${arguments_.join(" ")}`
          const handle = yield* spawner
            .spawn(
              ChildProcess.make(binary, arguments_, {
                cwd: temporary,
                extendEnv: false,
                env: { PATH: "/usr/bin:/bin", HOME: temporary, TERM: "dumb", ...environment },
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
              }),
            )
            .pipe(mapFailure(step))
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              Stream.mkString(Stream.decodeText(handle.stdout)),
              Stream.mkString(Stream.decodeText(handle.stderr)),
              handle.exitCode,
            ],
            { concurrency: 3 },
          ).pipe(mapFailure(step))
          if (Number(exitCode) !== 0)
            return yield* failure(step, `exit ${exitCode}\n${stderr.slice(0, 2_000)}\n${stdout.slice(0, 2_000)}`)
          return stdout
        }),
      )
    const versionOutput = yield* runBinary(["--version"])
    if (!versionOutput.includes(version))
      return yield* failure("version", `Expected ${version}, received: ${versionOutput}`)
    const helpOutput = yield* runBinary(["--help"])
    if (/relay/i.test(helpOutput) || !/rika/i.test(helpOutput))
      return yield* failure("help", `Unexpected public help output: ${helpOutput.slice(0, 2_000)}`)
    if (helpOutput.includes(tuiControllerProcessRole) || helpOutput.includes(runnerExecutorProcessRole))
      return yield* failure("help", "Internal process roles are exposed in public help")
    yield* runBinary([runnerExecutorProcessRole, "--help"], { RIKA_INTERNAL_LOCAL_EXECUTOR: "1" })
    const interactiveProbe = yield* runBinary([tuiControllerProcessRole], {
      RIKA_INTERNAL_CLIENT_RUNTIME: "1",
      RIKA_INTERNAL_OPENTUI_NATIVE_PROBE: "1",
    })
    if (!interactiveProbe.includes("RIKA_OPENTUI_NATIVE_OK"))
      return yield* failure("interactive runtime", "The packaged executable does not contain the OpenTUI runtime")
    yield* Effect.log(`Release smoke passed for ${target}: one public executable, no hidden runtime artifacts`)
  }),
)

BunRuntime.runMain(
  Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(program, context))),
)
