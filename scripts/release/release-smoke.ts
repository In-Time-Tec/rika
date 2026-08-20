import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Data, Effect, FileSystem, Layer, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { validatePackageArchive } from "../packaging/archive-contract"

class ReleaseSmokeError extends Data.TaggedError("ReleaseSmokeError")<{
  readonly step: string
  readonly message: string
}> {}

const failure = (step: string, message: string) => new ReleaseSmokeError({ step, message })
const mapFailure = (step: string) =>
  Effect.mapError((error: { readonly message: string }) => failure(step, `${step}: ${error.message}`))

const NamedItemsJson = Schema.fromJsonString(Schema.Array(Schema.Struct({ name: Schema.String })))
const ThreadsJson = Schema.fromJsonString(Schema.Array(Schema.Struct({ id: Schema.String })))
const UnknownJson = Schema.fromJsonString(Schema.Unknown)
const PackageManifestJson = Schema.fromJsonString(Schema.Struct({ version: Schema.String }))

const commandSurfaces: ReadonlyArray<ReadonlyArray<string>> = [
  [],
  ["run"],
  ["review"],
  ...[
    "new",
    "continue",
    "list",
    "search",
    "rename",
    "label",
    "pin",
    "archive",
    "unarchive",
    "delete",
    "usage",
    "fork",
    "export",
  ].map((command) => ["thread", command]),
  ["last"],
  ["top"],
  ...["list", "edit", "keymap"].map((command) => ["config", command]),
  ...["list", "use", "invite"].map((command) => ["org", command]),
  ...["login", "status", "logout", "devices", "revoke-device"].map((command) => ["auth", command]),
  ...["set", "list", "rotate", "revoke"].map((command) => ["credential", command]),
  ...["path", "status", "export", "performance"].map((command) => ["diagnostics", command]),
  ...["list", "show"].map((command) => ["tools", command]),
  ...["list", "inspect", "add", "remove"].map((command) => ["skills", command]),
  ...["list", "add", "remove", "enable", "disable", "doctor"].map((command) => ["mcp", command]),
  ...["login", "logout", "status"].map((command) => ["mcp", "oauth", command]),
  ...["list", "create-skill", "create-plugin", "enable", "disable", "rollback"].map((command) => [
    "extensions",
    command,
  ]),
  ["doctor"],
  ["update"],
  ["version"],
]

const program = Effect.scoped(
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const root = yield* path.fromFileUrl(new URL("../..", import.meta.url)).pipe(mapFailure("resolve project root"))
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
    const serverSidecar = path.join(temporary, archiveRoot, "bin", ".rika-server")
    if (yield* fileSystem.exists(serverSidecar))
      return yield* failure("serverless package", `Unexpected server sidecar: ${serverSidecar}`)
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
    /**
     * A cell is the only tool a model is given, and it runs in a kernel the packaged binary has to
     * spawn as a file. Reading the seeded workspace through one is what proves the packaged product
     * can do its own work, rather than only start.
     */
    const cellScript = yield* Schema.encodeUnknownEffect(UnknownJson)([
      {
        parts: [
          {
            type: "toolCall",
            name: "typescript",
            params: {
              code: [
                `const seeded = await rika.workspace.read({"path":"smoke.txt"})`,
                `seeded.text.includes("release-smoke-needle") ? 6 * 7 : 0`,
              ].join("\n"),
            },
          },
        ],
      },
      { parts: [{ type: "text", text: "SMOKE_COMPLETE" }] },
    ]).pipe(mapFailure("encode model script"))
    const environment = {
      HOME: home,
      RIKA_DATABASE: path.join(state, "rika.db"),
      RIKA_INTERNAL_SERVER_GRACE: "0",
      RIKA_TEST_MODEL_SCRIPT: cellScript,
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
    yield* Effect.forEach(commandSurfaces, (command) => output([...command, "--help"]), {
      concurrency: 4,
      discard: true,
    })
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
    const executed = yield* output(["run", "--stream-json", "find the needle"])
    /**
     * The seeded line proves the cell RAN: a model that answers without its kernel still reaches its
     * own final text, so the answer alone says nothing about whether any work happened.
     */
    /**
     * The value is computed inside the cell from what it read, so it appears nowhere in the source
     * the stream echoes back. A kernel that never starts cannot produce it.
     */
    if (!executed.includes(`"result":"42"`))
      return yield* failure("packaged cell", `Packaged run did not execute a cell: ${executed.slice(0, 2_000)}`)
    if (!executed.includes("SMOKE_COMPLETE"))
      return yield* failure(
        "packaged run",
        `Deterministic packaged run did not complete a cell turn: ${executed.slice(0, 2_000)}`,
      )
    /**
     * A refinement a cell makes is read once per Server, so proving it reached anything needs two
     * runs: one that writes it and a second whose prompt carries it. The packaged binary is the only
     * place this shows, because a harness that never reaches a prompt still stores and reads back
     * exactly like one that does.
     */
    const refineScript = yield* Schema.encodeUnknownEffect(UnknownJson)([
      {
        parts: [
          {
            type: "toolCall",
            name: "typescript",
            params: {
              code: [
                `const pinned = await rika.harness.snapshot({"scope":"global"})`,
                `const content = ["RELEASE", "SMOKE", "HARNESS", "MARKER"].join("_")`,
                `await rika.harness.createMemory({"id":"release-smoke","title":"Release smoke","content":content,"baseSnapshot":pinned.snapshotId,"scope":"global"})`,
                `"refined"`,
              ].join("\n"),
            },
          },
        ],
      },
      { parts: [{ type: "text", text: "SMOKE_COMPLETE" }] },
    ]).pipe(mapFailure("encode refinement script"))
    /**
     * A Server outlives the `run` that started it and keeps the script it booted with, so these two
     * runs need a home of their own: sharing the one above would replay that run's script instead of
     * these, and the second assertion would pass against the wrong cell entirely.
     */
    const harnessHome = path.join(temporary, "harness-home")
    yield* fileSystem.makeDirectory(harnessHome, { recursive: true }).pipe(mapFailure("seed harness home"))
    /**
     * The two runs need separate durable journals, which live under the home rather than at
     * RIKA_DATABASE: sharing one replays the first run's turn and the second assertion passes
     * against a cell that never ran. Copying the harness store between the two homes is what leaves
     * the refinement, and only the refinement, carried across.
     */
    const recallHome = path.join(temporary, "recall-home")
    yield* fileSystem.makeDirectory(recallHome, { recursive: true }).pipe(mapFailure("seed recall home"))
    const refined = yield* output(["run", "--stream-json", "refine"], {
      HOME: harnessHome,
      RIKA_DATABASE: path.join(harnessHome, "rika.db"),
      RIKA_TEST_MODEL_SCRIPT: refineScript,
    })
    if (!refined.includes(`"result":"refined"`))
      return yield* failure("packaged harness", `Packaged run did not refine its harness: ${refined.slice(-2_000)}`)
    const recallScript = yield* Schema.encodeUnknownEffect(UnknownJson)([
      {
        parts: [
          {
            type: "toolCall",
            name: "typescript",
            params: {
              code: [
                `const pinned = await rika.harness.snapshot({"scope":"global"})`,
                `pinned.entries.memory.some((entry) => entry.content === ["RELEASE", "SMOKE", "HARNESS", "MARKER"].join("_")) ? "carried" : "lost"`,
              ].join("\n"),
            },
          },
        ],
      },
      { parts: [{ type: "text", text: "SMOKE_COMPLETE" }] },
    ]).pipe(mapFailure("encode recall script"))
    yield* fileSystem
      .copy(path.join(harnessHome, ".config"), path.join(recallHome, ".config"))
      .pipe(mapFailure("carry the harness store"))
    const carried = yield* output(["run", "--stream-json", "recall"], {
      HOME: recallHome,
      RIKA_DATABASE: path.join(recallHome, "rika.db"),
      RIKA_TEST_MODEL_SCRIPT: recallScript,
    })
    const stored = yield* fileSystem.exists(path.join(harnessHome, ".config", "rika", "harness", "global.json"))
    if (!carried.includes(`"result":"carried"`))
      return yield* failure(
        "packaged harness",
        `A refinement one run stored was not readable by the next: ${carried.slice(-2_000)} stored=${stored} carriedTail=${carried.slice(-600)}`,
      )
    const threads = yield* output(["thread", "list"])
    const decoded = yield* Schema.decodeUnknownEffect(ThreadsJson)(threads).pipe(mapFailure("decode threads list"))
    if (decoded.length !== 1) return yield* failure("threads list", `Expected one thread, saw ${decoded.length}`)
    yield* Effect.log(`Release smoke passed for ${target}`)
  }),
)

BunRuntime.runMain(
  Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(program, context))),
)
