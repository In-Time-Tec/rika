import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Console, Data, Effect, FileSystem, Function, Layer, Option, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { probePtyFrameAndInterrupt } from "../benchmark/packaged-startup"
import { validatePackageArchive } from "../packaging/archive-contract"

class ReleaseSmokeError extends Data.TaggedError("ReleaseSmokeError")<{
  readonly step: string
  readonly message: string
}> {}

const failure = (step: string, message: string) => new ReleaseSmokeError({ step, message })
const mapFailure = (step: string) =>
  Effect.mapError((error: { readonly message: string }) => failure(step, `${step}: ${error.message}`))

const smokeInvocations = [
  { purpose: "version", arguments: ["--version"] },
  { purpose: "public help", arguments: ["--help"] },
  { purpose: "in-process client PTY", arguments: [] },
  { purpose: "public runner unauthenticated", arguments: ["--no-tui"] },
] as const

const probeTimeoutMilliseconds = 15_000

class ProbeError extends Data.TaggedError("ProbeError")<{
  readonly message: string
}> {}

const runBoundedProbeEffect = (
  binary: string,
  arguments_: ReadonlyArray<string>,
  cwd: string,
  timeoutMilliseconds = probeTimeoutMilliseconds,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const child = yield* spawner.spawn(
      ChildProcess.make(binary, arguments_, {
        cwd,
        env: { PATH: "/usr/bin:/bin", HOME: cwd, TERM: "dumb" },
        killSignal: "SIGKILL",
      }),
    )
    return yield* Effect.all([
      Stream.mkString(Stream.decodeText(child.stdout)),
      Stream.mkString(Stream.decodeText(child.stderr)),
      child.exitCode,
    ]).pipe(
      Effect.timeoutOption(timeoutMilliseconds),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            new ProbeError({ message: `${arguments_.join("/")} probe timed out after ${timeoutMilliseconds}ms` }),
          onSome: Effect.succeed,
        }),
      ),
      Effect.map(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode: Number(exitCode) })),
      Effect.mapError((error) => (error instanceof ProbeError ? error : new ProbeError({ message: String(error) }))),
    )
  })

const runBoundedProbeImpl = (
  binary: string,
  arguments_: ReadonlyArray<string>,
  cwd: string,
  timeoutMilliseconds = probeTimeoutMilliseconds,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(Layer.build(BunServices.layer), (context) =>
        Effect.provide(runBoundedProbeEffect(binary, arguments_, cwd, timeoutMilliseconds), context),
      ),
    ),
  )

export const runBoundedProbe: {
  (
    binary: string,
    arguments_: ReadonlyArray<string>,
    cwd: string,
    timeoutMilliseconds?: number,
  ): ReturnType<typeof runBoundedProbeImpl>
  (
    arguments_: ReadonlyArray<string>,
    cwd: string,
    timeoutMilliseconds?: number,
  ): (binary: string) => ReturnType<typeof runBoundedProbeImpl>
} = Function.dual((arguments_) => typeof arguments_[0] === "string", runBoundedProbeImpl)

const runBehavioralProbesEffect = (binary: string, emptyHome: string) =>
  Effect.gen(function* () {
    const clientHome = `${emptyHome}/interactive-client`
    const runnerHome = `${emptyHome}/unauthenticated-runner`
    const fileSystem = yield* FileSystem.FileSystem
    yield* fileSystem.makeDirectory(clientHome, { recursive: true })
    yield* fileSystem.makeDirectory(runnerHome, { recursive: true })
    const client = yield* Effect.tryPromise(() =>
      probePtyFrameAndInterrupt(binary, {
        timeoutMilliseconds: probeTimeoutMilliseconds,
        environment: {
          HOME: clientHome,
          XDG_CONFIG_HOME: `${clientHome}/.config`,
          XDG_DATA_HOME: `${clientHome}/.local/share`,
          XDG_STATE_HOME: `${clientHome}/.local/state`,
        },
        interrupt: "foreground-process-group-sigint",
      }),
    )
    if (client.exitCode !== 0 && client.exitCode !== 130)
      return yield* new ProbeError({
        message: `PTY client exited with undocumented code ${client.exitCode} after SIGINT`,
      })
    const runner = yield* runBoundedProbeEffect(binary, ["--no-tui"], runnerHome)
    const output = `${runner.stderr}\n${runner.stdout}`
    if (runner.exitCode !== 1 || !/Run rika auth login first/i.test(output))
      return yield* new ProbeError({
        message: `Expected unauthenticated Runner exit 1, received exit ${runner.exitCode}: ${output.slice(0, 2_000)}`,
      })
    return { client, runner }
  })

const runBehavioralProbesImpl = (binary: string, emptyHome: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(Layer.build(BunServices.layer), (context) =>
        Effect.provide(runBehavioralProbesEffect(binary, emptyHome), context),
      ),
    ),
  )

export const runBehavioralProbes: {
  (binary: string, emptyHome: string): ReturnType<typeof runBehavioralProbesImpl>
  (emptyHome: string): (binary: string) => ReturnType<typeof runBehavioralProbesImpl>
} = Function.dual(2, runBehavioralProbesImpl)

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
    const runBinary = (arguments_: ReadonlyArray<string>) =>
      runBoundedProbeEffect(binary, arguments_, temporary).pipe(
        mapFailure(`run rika ${arguments_.join(" ")}`),
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.succeed(result.stdout)
            : Effect.fail(
                failure(
                  `run rika ${arguments_.join(" ")}`,
                  `exit ${result.exitCode}\n${result.stderr.slice(0, 2_000)}\n${result.stdout.slice(0, 2_000)}`,
                ),
              ),
        ),
      )
    const versionOutput = yield* runBinary(smokeInvocations[0].arguments)
    if (!versionOutput.includes(version))
      return yield* failure("version", `Expected ${version}, received: ${versionOutput}`)
    const helpOutput = yield* runBinary(smokeInvocations[1].arguments)
    if (/relay/i.test(helpOutput) || !/rika/i.test(helpOutput))
      return yield* failure("help", `Unexpected public help output: ${helpOutput.slice(0, 2_000)}`)
    yield* runBehavioralProbesEffect(binary, temporary).pipe(mapFailure("behavioral probes"))
    yield* Effect.log(`Release smoke passed for ${target}: one public executable, no hidden runtime artifacts`)
  }),
)

if (import.meta.main) {
  if (Bun.argv.includes("--dry-run")) BunRuntime.runMain(Console.log(JSON.stringify(smokeInvocations)))
  else
    BunRuntime.runMain(
      Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(program, context))),
    )
}
