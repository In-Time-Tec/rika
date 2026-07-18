import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, test } from "vitest"
import { fileURLToPath } from "node:url"
import { Config, Effect, FileSystem, Layer, Schema, Scope, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices | Scope.Scope>) =>
  Effect.runPromise(
    Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context)))),
  )

const waitUntil = <E, R>(condition: Effect.Effect<boolean, E, R>, timeout = 10_000) =>
  Effect.gen(function* () {
    const started = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
    while (!(yield* condition)) {
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
      if (now - started >= timeout) return yield* Effect.die("condition timed out")
      yield* Effect.sleep("20 millis")
    }
  })

const PtyResult = Schema.fromJsonString(
  Schema.Struct({
    output: Schema.String,
    exitCode: Schema.Int,
    actionsCompleted: Schema.Int,
    runningChecks: Schema.Array(Schema.Boolean),
    timedOut: Schema.Boolean,
  }),
)
const PtyAction = Schema.Struct({
  after: Schema.String,
  write: Schema.String,
  checkRunning: Schema.optionalKey(Schema.Boolean),
})
const PtyActions = Schema.fromJsonString(Schema.Array(PtyAction))
const UnknownJson = Schema.UnknownFromJsonString

const escape = String.fromCharCode(27)
const bell = String.fromCharCode(7)
const stripTerminalControl = (text: string) =>
  text
    .replaceAll(new RegExp(`${escape}\\][^${bell}]*(?:${bell}|${escape}\\\\)`, "g"), "")
    .replaceAll(new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, "g"), "")
    .replaceAll(new RegExp(`${escape}[@-_]`, "g"), "")

const interactivePty = Effect.fn("ClientMainTest.interactivePty")(function* (
  actions: ReadonlyArray<{ readonly after: string; readonly write: string; readonly checkRunning?: boolean }>,
  modelScript?: string,
) {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-client-main-" })
  const home = `${root}/home`
  const workspace = `${root}/workspace`
  const state = `${root}/state`
  yield* Effect.forEach([home, workspace, state], (directory) => fs.makeDirectory(directory))
  const directory = fileURLToPath(new URL(".", import.meta.url))
  const helper = `${directory}/fixtures/interactive-pty.py`
  const path = yield* Config.string("PATH").pipe(
    Config.withDefault("/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"),
  )
  const environment = yield* Schema.encodeUnknownEffect(UnknownJson)({
    HOME: home,
    PATH: path,
    TERM: "xterm-256color",
    RIKA_DATABASE: `${state}/rika.db`,
    RIKA_RELAY_DATABASE: `${state}/relay.db`,
    RIKA_INTERNAL_RESIDENT_GRACE: "100",
    ...(modelScript === undefined
      ? { RIKA_TEST_MODEL_RESPONSE: "completed" }
      : { RIKA_TEST_MODEL_SCRIPT: modelScript }),
  })
  const encodedActions = yield* Schema.encodeUnknownEffect(PtyActions)(actions)
  const handle = yield* spawner.spawn(
    ChildProcess.make(
      "python3",
      [helper, process.execPath, directory.replace(/\/test\/$/, ""), environment, encodedActions],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    ),
  )
  const [stdout, stderr, helperExitCode] = yield* Effect.all(
    [
      Stream.mkString(Stream.decodeText(handle.stdout)),
      Stream.mkString(Stream.decodeText(handle.stderr)),
      handle.exitCode,
    ],
    { concurrency: 3 },
  ).pipe(
    Effect.timeoutOrElse({
      duration: "35 seconds",
      orElse: () =>
        handle
          .kill({ killSignal: "SIGTERM" })
          .pipe(Effect.ignore, Effect.andThen(Effect.die("PTY helper did not exit"))),
    }),
  )
  expect(Number(helperExitCode), stderr).toBe(0)
  const result = yield* Schema.decodeUnknownEffect(PtyResult)(stdout.trim())
  yield* waitUntil(
    fs
      .readDirectory(`${state}/diagnostics`)
      .pipe(Effect.map((names) => names.every((name) => !name.endsWith(".open.jsonl")))),
  )
  const names = yield* fs.readDirectory(`${state}/diagnostics`)
  const clientLogs = yield* Effect.forEach(
    names.filter((name) => name.startsWith("client-") && name.endsWith(".jsonl")),
    (name) => fs.readFileString(`${state}/diagnostics/${name}`),
  )
  return {
    ...result,
    output: stripTerminalControl(Buffer.from(result.output, "base64").toString("utf8")),
    clientLogs: clientLogs.join("\n"),
    names,
  }
})

test(
  "exits cleanly when Ctrl+C quits the idle interactive TUI",
  () =>
    run(
      Effect.gen(function* () {
        const result = yield* interactivePty([{ after: "Welcome to Rika", write: "\u0003" }])
        expect(result.timedOut, result.output).toBe(false)
        expect(result.actionsCompleted).toBe(1)
        expect(result.exitCode, result.output).toBe(0)
        expect(result.output).toContain(".#*+:")
        expect(result.output).not.toContain("Rika interactive runtime exited with code")
        expect(result.clientLogs).not.toContain('"message":"process.failed"')
        expect(result.names.filter((name) => name.endsWith(".open.jsonl"))).toEqual([])
      }),
    ),
  45_000,
)

test(
  "cancels a busy turn on Ctrl+C and keeps the interactive TUI running",
  () =>
    run(
      Effect.gen(function* () {
        const script = yield* Schema.encodeUnknownEffect(UnknownJson)(
          Array.from({ length: 4 }, () => ({
            parts: [{ type: "text", text: "too late" }],
            delayMs: 8_000,
          })),
        )
        const result = yield* interactivePty(
          [
            { after: "Welcome to Rika", write: "cancel this turn\r" },
            { after: "Waiting", write: "\u0003" },
            { after: "⊘", write: "\u0003", checkRunning: true },
          ],
          script,
        )
        expect(result.timedOut, result.output).toBe(false)
        expect(result.actionsCompleted).toBe(3)
        expect(result.runningChecks).toEqual([true])
        expect(result.exitCode, result.output).toBe(0)
        expect(result.output).toContain("⊘")
        expect(result.output).toContain(".#*+:")
        expect(result.clientLogs).not.toContain('"message":"process.failed"')
        expect(result.names.filter((name) => name.endsWith(".open.jsonl"))).toEqual([])
      }),
    ),
  60_000,
)
