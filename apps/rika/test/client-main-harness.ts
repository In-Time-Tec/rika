import * as BunServices from "@effect/platform-bun/BunServices"
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import { expect } from "vitest"
import { fileURLToPath } from "node:url"
import { Cause, Config, Duration, Effect, FileSystem, Function, Layer, Schema, Scope, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices | Scope.Scope>) =>
  Effect.runPromise(
    Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context)))),
  )

export const waitUntil: {
  <E, R>(condition: Effect.Effect<boolean, E, R>, timeout?: number): Effect.Effect<undefined, E, R>
  (timeout?: number): <E, R>(condition: Effect.Effect<boolean, E, R>) => Effect.Effect<undefined, E, R>
} = Function.dual(
  (args) => Effect.isEffect(args[0]),
  <E, R>(condition: Effect.Effect<boolean, E, R>, timeout = 10_000): Effect.Effect<undefined, E, R> =>
    Effect.gen(function* () {
      const started = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
      while (!(yield* condition)) {
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
        if (now - started >= timeout) return yield* Effect.die("condition timed out")
        yield* Effect.sleep("20 millis")
      }
    }),
)

export const PtyResult = Schema.fromJsonString(
  Schema.Struct({
    output: Schema.String,
    exitCode: Schema.Int,
    actionsCompleted: Schema.Int,
    runningChecks: Schema.Array(Schema.Boolean),
    timedOut: Schema.Boolean,
  }),
)
export const PtyAction = Schema.Struct({
  after: Schema.String,
  write: Schema.String,
  checkRunning: Schema.optionalKey(Schema.Boolean),
  signal: Schema.optionalKey(Schema.Literals(["SIGINT", "SIGTERM", "SIGKILL", "SIGHUP"])),
  closePty: Schema.optionalKey(Schema.Boolean),
  turnPrompt: Schema.optionalKey(Schema.String),
  turnStatus: Schema.optionalKey(Schema.String),
  timeoutMs: Schema.optionalKey(Schema.Int),
})
export const PtyActions = Schema.fromJsonString(Schema.Array(PtyAction))
export const UnknownJson = Schema.UnknownFromJsonString

export const escape = String.fromCharCode(27)
export const bell = String.fromCharCode(7)
export const stripTerminalControl = (text: string) =>
  text
    .replaceAll(new RegExp(`${escape}\\][^${bell}]*(?:${bell}|${escape}\\\\)`, "g"), "")
    .replaceAll(new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, "g"), "")
    .replaceAll(new RegExp(`${escape}[@-_]`, "g"), "")

export const interactivePty = Effect.fn("ClientMainTest.interactivePty")(function* (
  actions: ReadonlyArray<{
    readonly after: string
    readonly write: string
    readonly checkRunning?: boolean
    readonly signal?: "SIGINT" | "SIGTERM" | "SIGKILL" | "SIGHUP"
    readonly closePty?: boolean
    readonly turnPrompt?: string
    readonly turnStatus?: string
    readonly timeoutMs?: number
  }>,
  modelScript?: string,
  toolApprovals?: ReadonlyArray<string>,
  residentEnvironment?: Readonly<Record<string, string>>,
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
    RIKA_EXECUTION_DATABASE: `${state}/execution.db`,
    RIKA_INTERNAL_RESIDENT_GRACE: "100",
    RELAY_EVENT_POLL_INTERVAL_MILLIS: "50",
    RELAY_EVENT_POLL_IDLE_INTERVAL_MILLIS: "250",
    RELAY_SCHEDULER_POLL_INTERVAL_MILLIS: "100",
    ...residentEnvironment,
    ...(toolApprovals === undefined ? {} : { RIKA_TEST_APPROVAL_TOOLS: toolApprovals.join(",") }),
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
      duration: Duration.millis(
        Math.max(35_000, actions.reduce((total, action) => total + (action.timeoutMs ?? 10_000), 0) + 13_000),
      ),
      orElse: () =>
        handle
          .kill({ killSignal: "SIGTERM" })
          .pipe(Effect.ignore, Effect.andThen(Effect.die("PTY helper did not exit"))),
    }),
  )
  expect(Number(helperExitCode), stderr).toBe(0)
  const result = yield* Schema.decodeUnknownEffect(PtyResult)(stdout.trim())
  const settlesDiagnostics = residentEnvironment === undefined && !actions.some((action) => action.signal !== undefined)
  if (settlesDiagnostics)
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
    database: `${state}/rika.db`,
  }
})

export const turnStatus = Effect.fn("ClientMainTest.turnStatus")(function* (database: string, prompt: string) {
  const reactivity = yield* Reactivity.make
  const client = yield* SqliteClient.make({ filename: database, readonly: true }).pipe(
    Effect.provideService(Reactivity.Reactivity, reactivity),
  )
  const rows = yield* client<{ readonly status: string }>`SELECT status FROM rika_turns WHERE prompt = ${prompt}`
  return rows[0]?.status
})

export const awaitTurnStatus = Effect.fn("ClientMainTest.awaitTurnStatus")(function* (
  database: string,
  prompt: string,
  status: string,
  timeout = 30_000,
) {
  let observed = "unread"
  yield* waitUntil(
    Effect.gen(function* () {
      observed = yield* turnStatus(database, prompt).pipe(
        Effect.map((value) => value ?? "absent"),
        Effect.catchCause((cause) => Effect.succeed(Cause.pretty(cause))),
      )
      return observed === status
    }).pipe(Effect.scoped),
    timeout,
  ).pipe(
    Effect.catchCause(() =>
      Effect.die(`turn "${prompt}" settled as ${observed} instead of ${status} within ${timeout}ms`),
    ),
  )
})
