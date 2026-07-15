import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, test } from "bun:test"
import { Effect, FileSystem, Path, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const Result = Schema.Struct({
  capture: Schema.String,
  exited: Schema.Boolean,
  exitCode: Schema.NullOr(Schema.Finite),
  paletteVisible: Schema.Boolean,
  quitSelected: Schema.Boolean,
  fallbackSignalUsed: Schema.Boolean,
  termiosRestored: Schema.Boolean,
})

const program = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const root = path.resolve(import.meta.dir, "../..")
  const kernel = (yield* spawner.string(ChildProcess.make("uname", ["-s"]))).trim().toLowerCase()
  const machine = (yield* spawner.string(ChildProcess.make("uname", ["-m"]))).trim()
  const architecture = machine === "x86_64" ? "x64" : "arm64"
  const archive = path.join(root, "artifacts", `rika-${kernel}-${architecture}.tar.gz`)
  const temporary = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-palette-quit-" })
  const home = path.join(temporary, "home")
  const workspace = path.join(temporary, "workspace")
  const state = path.join(temporary, "state")
  yield* Effect.all(
    [fileSystem.makeDirectory(home), fileSystem.makeDirectory(workspace), fileSystem.makeDirectory(state)],
    { concurrency: 3 },
  )
  const extracted = yield* spawner.exitCode(ChildProcess.make("tar", ["-xzf", archive, "-C", temporary]))
  expect(Number(extracted)).toBe(0)
  const binary = path.join(temporary, `rika-${kernel}-${architecture}`, "bin", "rika")
  const helper = path.join(import.meta.dir, "native-pty.py")
  const environment = {
    HOME: home,
    PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    RIKA_DATABASE: path.join(state, "rika.db"),
    RIKA_RELAY_DATABASE: path.join(state, "relay.db"),
    RIKA_TEST_MODEL_RESPONSE: "deterministic response",
  }
  const output = yield* spawner.string(
    ChildProcess.make("python3", [helper, binary, workspace, JSON.stringify(environment), "palette-quit"], {
      cwd: workspace,
    }),
  )
  const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Result))(output.trim())
  const capture = yield* Schema.decodeUnknownEffect(Schema.StringFromBase64)(result.capture)
  expect(result.paletteVisible).toBe(true)
  expect(result.quitSelected).toBe(true)
  expect(result.exited).toBe(true)
  expect(result.exitCode).toBe(0)
  expect(result.fallbackSignalUsed).toBe(false)
  expect(result.termiosRestored).toBe(true)
  for (const label of ["switch", "change mode", "toggle fast mode", "quit"]) expect(capture).toContain(label)
  for (const label of ["run prompt", "show context and cost", "review workspace changes", "changed files", "reasoning"])
    expect(capture).not.toContain(label)
}).pipe(Effect.scoped, Effect.provide(BunServices.layer))

test("the packaged command palette exposes four commands and quits cleanly", () => Effect.runPromise(program), 20_000)
