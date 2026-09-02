import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Config, Effect, FileSystem, Layer, Logger, Option, Path, Random, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const Tool = Schema.Struct({
  args: Schema.Array(Schema.String),
  command: Schema.String,
  expect: Schema.optional(Schema.String),
  name: Schema.String,
})
const AptPackage = Schema.Struct({ name: Schema.String, version: Schema.String })
const Manifest = Schema.Struct({
  aptPackages: Schema.Array(AptPackage),
  image: Schema.String,
  schemaVersion: Schema.Finite,
  tools: Schema.Array(Tool),
})
const decodeManifest = Schema.decodeEffect(Schema.fromJsonString(Manifest))
const Result = Schema.Struct({
  buildId: Schema.NullOr(Schema.String),
  checks: Schema.Array(Schema.Struct({ detail: Schema.String, name: Schema.String, ok: Schema.Boolean })),
  image: Schema.String,
  manifestPackageCount: Schema.Finite,
  manifestSchemaVersion: Schema.Finite,
  manifestSha256: Schema.String,
  manifestToolCount: Schema.Finite,
  ok: Schema.Boolean,
})
const encodeResult = Schema.encodeEffect(Schema.fromJsonString(Result))
const successfulExitCode = 0
const socketMode = 0o660

type Check = { readonly detail: string; readonly name: string; readonly ok: boolean }

const bunBoundary = {
  listen: (socketPath: string) =>
    Bun.listen({
      socket: {
        data(socket, data) {
          let response = ""
          if (new TextDecoder().decode(data).trim() === "readiness") {
            response = "broker-ready"
          }
          socket.end(response)
        },
      },
      unix: socketPath,
    }),
}

class DoctorError extends Schema.TaggedError<DoctorError>()("DoctorError", { message: Schema.String }) {}

const program = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const manifestPath = yield* Config.string("RIKA_IMAGE_MANIFEST").pipe(
    Config.withDefault("/opt/rika/tool-manifest.json"),
  )
  const workspace = yield* Config.string("RIKA_EXECUTOR_WORKSPACE").pipe(
    Config.withDefault("/home/rika-workspace/workspace/repo"),
  )
  const executorHome = yield* Config.string("HOME").pipe(Config.withDefault("/home/rika-executor"))
  const executablePath = yield* Config.string("PATH").pipe(Config.withDefault(""))
  const ghConfigDirectory = yield* Config.string("GH_CONFIG_DIR").pipe(Config.withDefault(""))
  const networkUrl = yield* Config.string("RIKA_DOCTOR_NETWORK_URL").pipe(Config.withDefault("https://example.com/"))
  const buildId = yield* Config.option(Config.string("RIKA_EXECUTOR_TEMPLATE_BUILD_ID"))
  const manifestText = yield* fileSystem.readFileString(manifestPath)
  const manifest = yield* decodeManifest(manifestText)
  const workspaceParent = path.dirname(workspace)
  const tempId = yield* Random.nextInt
  const temp = path.join(workspaceParent, `.rika-doctor-${tempId}`)
  const checks: Array<Check> = []
  const command = Effect.fn("doctor.command")(function* (parts: ReadonlyArray<string>) {
    const child = yield* spawner.spawn(
      ChildProcess.make(parts[0] ?? "", parts.slice(1), {
        cwd: executorHome,
        env: process.env,
        stderr: "pipe",
        stdout: "pipe",
      }),
    )
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        Stream.mkString(Stream.decodeText(child.stdout)),
        Stream.mkString(Stream.decodeText(child.stderr)),
        child.exitCode,
      ],
      { concurrency: 3 },
    )
    if (Number(exitCode) !== successfulExitCode) {
      return yield* DoctorError.make({
        message: `${parts[successfulExitCode]} exited ${exitCode}: ${stderr.trim()}`,
      })
    }
    return `${stdout}${stderr}`.trim().split("\n")[successfulExitCode] ?? ""
  })
  const check = <Error, Requirements>(name: string, run: Effect.Effect<string, Error, Requirements>) =>
    Effect.matchEffect(run, {
      onFailure: (error) => Effect.sync(() => checks.push({ detail: String(error), name, ok: false })),
      onSuccess: (detail) => Effect.sync(() => checks.push({ detail, name, ok: true })),
    })

  yield* Effect.forEach(
    manifest.tools,
    (tool) =>
      check(
        `tool:${tool.name}`,
        command([tool.command, ...tool.args]).pipe(
          Effect.filterOrFail(
            (output) => tool.expect === undefined || output.includes(tool.expect),
            (output) => DoctorError.make({ message: `expected ${tool.expect}, got ${output}` }),
          ),
        ),
      ),
    { concurrency: 1, discard: true },
  )
  yield* Effect.forEach(
    manifest.aptPackages,
    (installed) =>
      check(
        `package:${installed.name}`,
        command(["dpkg-query", "--showformat=${Version}", "--show", installed.name]).pipe(
          Effect.filterOrFail(
            (output) => output === installed.version,
            (output) => DoctorError.make({ message: `expected ${installed.version}, got ${output}` }),
          ),
        ),
      ),
    { concurrency: 1, discard: true },
  )
  yield* check(
    "workspace:ready",
    command([
      "sudo",
      "-n",
      "-u",
      "rika-workspace",
      "env",
      `PATH=${executablePath}`,
      `GH_CONFIG_DIR=${ghConfigDirectory}`,
      "sh",
      "-ceu",
      '[ "$(id -un)" = rika-workspace ]\n[ "$HOME" = /home/rika-workspace ]\ncase "$PATH" in /run/rika/bin:*) ;; *) exit 1 ;; esac\n[ "$GH_CONFIG_DIR" = /run/rika/gh ]\n[ -r "$1" ] && [ -w "$1" ] && [ -x "$1" ]\ninstall -d -m 0770 "$2"\ntouch "$2/write"\nprintf workspace-ready',
      "sh",
      workspaceParent,
      temp,
    ]).pipe(
      Effect.filterOrFail(
        (output) => output === "workspace-ready",
        (output) => DoctorError.make({ message: `unexpected workspace probe: ${output}` }),
      ),
    ),
  )
  yield* check(
    "native-tool:workspace-user",
    Effect.gen(function* () {
      const existingFile = path.join(temp, "existing.txt")
      const createdFile = path.join(temp, "created.txt")
      yield* command(["sudo", "-n", "-u", "rika-workspace", "sh", "-c", `printf before > '${existingFile}'`])
      yield* command(["test", "!", "-w", existingFile])
      const output = yield* command([
        "bun",
        "run",
        "/opt/rika/packages/remote-execution/src/host/machinery/native-tool-doctor.ts",
        temp,
      ])
      if (output !== "rika-workspace:native-tool-environment")
        return yield* DoctorError.make({ message: `unexpected native tool probe: ${output}` })
      if ((yield* fileSystem.readFileString(existingFile)) !== "after")
        return yield* DoctorError.make({ message: "native tool did not edit workspace file" })
      if ((yield* fileSystem.readFileString(createdFile)) !== "created-by-native-tool")
        return yield* DoctorError.make({ message: "native tool did not create workspace file" })
      const owner = yield* command(["stat", "-c", "%U", createdFile])
      if (owner !== "rika-workspace")
        return yield* DoctorError.make({ message: "native tool file has the wrong owner" })
      return output
    }),
  )
  yield* check("typescript:execute", command(["bun", "-e", "const value: number = 42; console.log(value)"]))
  yield* check("python:pillow", command(["python", "-c", "from PIL import Image; print(Image.new('RGB',(1,1)).size)"]))
  yield* check(
    "media:transcode",
    command(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=size=2x2", "-frames:v", "1", "-f", "null", "-"]),
  )
  yield* check(
    "browser:headless",
    command([
      "chromium",
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--dump-dom",
      "data:text/html,<title>rika</title>",
    ]),
  )
  yield* check(
    "network:outbound",
    command(["curl", "--fail", "--silent", "--show-error", "--max-time", "10", networkUrl]),
  )
  yield* check(
    "credentials:absent",
    Effect.gen(function* () {
      const environment = yield* Config.all({ home: Config.string("HOME").pipe(Config.withDefault("")) })
      const forbidden = Object.keys(process.env).filter(
        (key) => /^(?:.*_)?(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY)$/u.test(key) && !key.startsWith("RIKA_DOCTOR_"),
      )
      if (forbidden.length > successfulExitCode) {
        return yield* DoctorError.make({ message: `credential-like environment keys: ${forbidden.join(",")}` })
      }
      const credentialPaths = [path.join(environment.home, ".git-credentials"), path.join(environment.home, ".netrc")]
      const existing = yield* Effect.filter(credentialPaths, (credentialPath) => fileSystem.exists(credentialPath))
      if (existing.length > successfulExitCode) {
        return yield* DoctorError.make({ message: `credential file exists: ${existing[successfulExitCode]}` })
      }
      return "no credential environment keys or files"
    }),
  )
  yield* check(
    "credentials:broker-ready",
    Effect.gen(function* () {
      const socketId = yield* Random.nextInt
      const socketPath = path.join("/run/rika", `.rika-doctor-${socketId}.sock`)
      const listener = yield* Effect.sync<ReturnType<typeof bunBoundary.listen>>(() => bunBoundary.listen(socketPath))
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => listener.stop(true)).pipe(
          Effect.andThen(fileSystem.remove(socketPath, { force: true })),
          Effect.orDie,
        ),
      )
      yield* fileSystem.chmod(socketPath, socketMode)
      const output = yield* command([
        "sudo",
        "-n",
        "-u",
        "rika-workspace",
        "bun",
        "-e",
        'let response = ""\nawait new Promise((resolve, reject) => {\n  const timeout = setTimeout(() => reject(new Error("credential broker timed out")), 5000)\n  void Bun.connect({\n    unix: process.argv[1],\n    socket: {\n      open(socket) { socket.write("readiness") },\n      data(_socket, data) { response += new TextDecoder().decode(data) },\n      close() { clearTimeout(timeout); resolve() },\n      error() { clearTimeout(timeout); reject(new Error("credential broker connection failed")) },\n    },\n  }).catch(reject)\n})\nif (response !== "broker-ready") process.exit(1)\nconsole.log(response)',
        socketPath,
      ])
      if (output !== "broker-ready") {
        return yield* DoctorError.make({ message: `unexpected credential broker probe: ${output}` })
      }
      return output
    }).pipe(Effect.scoped),
  )
  yield* check(
    "source:git-roundtrip",
    command(["sudo", "-n", "-u", "rika-workspace", "git", "-C", temp, "init", "--quiet"]).pipe(
      Effect.andThen(
        command(["sudo", "-n", "-u", "rika-workspace", "sh", "-c", `printf rika > '${path.join(temp, "tracked")}'`]),
      ),
      Effect.andThen(command(["sudo", "-n", "-u", "rika-workspace", "git", "-C", temp, "add", "tracked"])),
      Effect.as("repository initialized and indexed"),
    ),
  )
  yield* check(
    "data:sqlite-roundtrip",
    command([
      "sudo",
      "-n",
      "-u",
      "rika-workspace",
      "sqlite3",
      path.join(temp, "doctor.db"),
      "create table probe(value text); insert into probe values('rika'); select value from probe;",
    ]),
  )
  yield* check(
    "coding:search",
    command(["sudo", "-n", "-u", "rika-workspace", "rg", "rika", path.join(temp, "tracked")]),
  )
  yield* check("process:workspace-user", command(["sudo", "-n", "-u", "rika-workspace", "id", "-un"]))
  yield* check(
    "workspace:cleanup",
    fileSystem
      .remove(path.join(temp, "native-tools"), { force: true, recursive: true })
      .pipe(
        Effect.andThen(command(["sudo", "-n", "-u", "rika-workspace", "rm", "-rf", temp])),
        Effect.as("workspace probe removed"),
      ),
  )

  const digest = new Bun.CryptoHasher("sha256").update(yield* fileSystem.readFile(manifestPath)).digest("hex")
  const result = {
    buildId: Option.getOrNull(buildId),
    checks,
    image: manifest.image,
    manifestPackageCount: manifest.aptPackages.length,
    manifestSchemaVersion: manifest.schemaVersion,
    manifestSha256: digest,
    manifestToolCount: manifest.tools.length,
    ok: checks.every((item) => item.ok),
  }
  yield* Effect.log(yield* encodeResult(result))
  if (!result.ok) {
    process.exitCode = 1
  }
})

const outputLogger = Logger.make(({ message }) => Bun.write(Bun.stdout, `${String(message)}\n`))
const applicationLayer = Layer.merge(BunServices.layer, Logger.layer([Effect.succeed(outputLogger)]))

BunRuntime.runMain(
  Effect.scoped(Effect.flatMap(Layer.build(applicationLayer), (context) => Effect.provide(program, context))),
)
