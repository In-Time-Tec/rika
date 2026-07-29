import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Data, Effect, FileSystem, Layer, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { validatePackageArchive } from "./archive-contract"

class ReleaseSmokeError extends Data.TaggedError("ReleaseSmokeError")<{
  readonly step: string
  readonly message: string
}> {}

const failure = (step: string, message: string) => new ReleaseSmokeError({ step, message })
const mapFailure = (step: string) =>
  Effect.mapError((error: { readonly message: string }) => failure(step, error.message))

const NamedItemsJson = Schema.fromJsonString(Schema.Array(Schema.Struct({ name: Schema.String })))
const ThreadsJson = Schema.fromJsonString(Schema.Array(Schema.Struct({ id: Schema.String })))
const UnknownJson = Schema.UnknownFromJsonString
const PackageManifestJson = Schema.fromJsonString(Schema.Struct({ version: Schema.String }))

const program = Effect.scoped(
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const root = yield* path.fromFileUrl(new URL("..", import.meta.url)).pipe(mapFailure("resolve project root"))
    const targetIndex = Bun.argv.indexOf("--target")
    const kernel = process.platform === "darwin" ? "darwin" : "linux"
    const architecture = process.arch === "x64" ? "x64" : "arm64"
    const target = targetIndex < 0 ? `${kernel}-${architecture}` : (Bun.argv[targetIndex + 1] ?? "")
    const manifestText = yield* fileSystem
      .readFileString(path.join(root, "apps", "rika", "package.json"))
      .pipe(mapFailure("read package version"))
    const manifest = yield* Schema.decodeUnknownEffect(PackageManifestJson)(manifestText).pipe(
      mapFailure("read package version"),
    )
    const archiveRoot = `rika-${manifest.version}-${target}`
    const archive = path.join(root, "artifacts", `${archiveRoot}.tar.gz`)
    if (!(yield* fileSystem.exists(archive).pipe(mapFailure("check archive"))))
      return yield* failure("check archive", `Archive not found: ${archive}. Run bun run package first.`)
    const inventory = yield* spawner
      .string(ChildProcess.make("tar", ["-tzf", archive]))
      .pipe(mapFailure("inspect archive"))
    const headers = yield* spawner
      .string(ChildProcess.make("tar", ["-tvzf", archive]))
      .pipe(mapFailure("inspect archive headers"))
    yield* Effect.try({
      try: () => validatePackageArchive(archiveRoot, inventory, headers),
      catch: (cause) => failure("inspect archive", String(cause)),
    })
    const temporary = yield* fileSystem
      .makeTempDirectoryScoped({ prefix: "rika-release-smoke-" })
      .pipe(mapFailure("create smoke directory"))
    const extracted = yield* spawner
      .exitCode(ChildProcess.make("tar", ["-xzf", archive, "-C", temporary]))
      .pipe(mapFailure("extract archive"))
    if (Number(extracted) !== 0) return yield* failure("extract archive", `tar exited with code ${extracted}`)
    const binary = path.join(temporary, archiveRoot, "bin", "rika")
    const performanceRuntime = path.join(temporary, archiveRoot, "bin", ".rika-performance")
    const interactiveRuntime = path.join(temporary, archiveRoot, "bin", ".rika-interactive")
    const workspace = path.join(temporary, "workspace")
    const home = path.join(temporary, "home")
    const state = path.join(temporary, "state")
    yield* Effect.forEach(
      [workspace, home, state],
      (directory) => fileSystem.makeDirectory(directory).pipe(mapFailure("create smoke workspace")),
      { discard: true },
    )
    yield* fileSystem
      .writeFileString(path.join(workspace, "smoke.txt"), "release-smoke-needle\n")
      .pipe(mapFailure("seed workspace"))
    const grepScript = yield* Schema.encodeUnknownEffect(UnknownJson)([
      {
        parts: [{ type: "toolCall", name: "grep", params: { pattern: "release-smoke-needle", regex: false } }],
      },
      { parts: [{ type: "text", text: "SMOKE_COMPLETE" }] },
    ]).pipe(mapFailure("encode model script"))
    const environment = {
      HOME: home,
      RIKA_DATABASE: path.join(state, "rika.db"),
      RIKA_EXECUTION_DATABASE: path.join(state, "execution.db"),
      RIKA_INTERNAL_RESIDENT_GRACE: "0",
      RIKA_TEST_MODEL_SCRIPT: grepScript,
    }
    const output = (
      command: ReadonlyArray<string>,
      extraEnvironment: Readonly<Record<string, string>> = {},
      executable = binary,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const step = `run ${command.join(" ")}`
          const handle = yield* spawner
            .spawn(
              ChildProcess.make(executable, command, {
                cwd: workspace,
                extendEnv: false,
                env: { ...environment, PATH: "/usr/bin:/bin", TERM: "xterm-256color", ...extraEnvironment },
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
    const version = yield* output(["--version"])
    if (!version.includes(manifest.version))
      return yield* failure("version", `Expected version ${manifest.version}, received: ${version}`)
    const help = yield* output(["--help"])
    const branded = [
      { command: "--version", text: version },
      { command: "--help", text: help },
    ].find(({ text }) => /relay/i.test(text))
    if (branded !== undefined)
      return yield* failure("branding", `${branded.command} output names an upstream framework: ${branded.text}`)
    if (Bun.argv.includes("--boot-only")) {
      yield* Effect.log(`Release boot smoke passed for ${target}`)
      return
    }
    const listed = yield* output(["tools", "list"])
    const tools = yield* Schema.decodeUnknownEffect(NamedItemsJson)(listed).pipe(mapFailure("decode tools list"))
    if (!tools.some((tool) => tool.name === "read"))
      return yield* failure("tools list", "Catalog does not contain the read tool")
    const nativeProbe = yield* output([], { RIKA_INTERNAL_OPENTUI_NATIVE_PROBE: "1" }, interactiveRuntime)
    if (!nativeProbe.includes("RIKA_OPENTUI_NATIVE_OK"))
      return yield* failure("OpenTUI native probe", `Missing native proof marker: ${nativeProbe}`)
    const performanceReport = yield* output([], {}, performanceRuntime)
    const decodedPerformance = yield* Schema.decodeUnknownEffect(UnknownJson)(performanceReport).pipe(
      mapFailure("decode performance report"),
    )
    if (
      typeof decodedPerformance !== "object" ||
      decodedPerformance === null ||
      !("schemaVersion" in decodedPerformance)
    )
      return yield* failure("performance runtime", "Packaged performance report is invalid")
    const executed = yield* output(["run", "find the needle"])
    if (!executed.includes("SMOKE_COMPLETE"))
      return yield* failure(
        "packaged run",
        `Deterministic packaged run did not complete a grep tool turn: ${executed.slice(0, 2_000)}`,
      )
    const threads = yield* output(["threads", "list"])
    const decoded = yield* Schema.decodeUnknownEffect(ThreadsJson)(threads).pipe(mapFailure("decode threads list"))
    if (decoded.length !== 1) return yield* failure("threads list", `Expected one thread, saw ${decoded.length}`)
    yield* Effect.log(`Release smoke passed for ${target}`)
  }),
)

BunRuntime.runMain(
  Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(program, context))),
)
