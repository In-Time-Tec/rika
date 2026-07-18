import * as BunServices from "@effect/platform-bun/BunServices"
import { Config, Effect, FileSystem, Layer, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { fileURLToPath } from "node:url"

type ModelPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | { readonly type: "toolCall"; readonly name: string; readonly params: unknown; readonly id?: string }

type ModelTurn =
  | { readonly parts: readonly [ModelPart, ...ReadonlyArray<ModelPart>]; readonly delayMs?: number }
  | { readonly object: unknown; readonly delayMs?: number }

type Action = {
  readonly after?: string
  readonly write?: string
  readonly checkRunning?: boolean
  readonly delayMs?: number
  readonly restartArguments?: ReadonlyArray<string>
  readonly resize?: { readonly width: number; readonly height: number }
  readonly files?: Readonly<Record<string, string | null>>
}

interface Options {
  readonly actions: ReadonlyArray<Action>
  readonly script?: readonly [ModelTurn, ...ReadonlyArray<ModelTurn>]
  readonly response?: string
  readonly globalSettings?: unknown
  readonly workspaceSettings?: unknown
  readonly workspace?: Readonly<Record<string, string>>
  readonly git?: boolean
  readonly terminal?: {
    readonly columns: number
    readonly rows: number
  }
}

class SceneError extends Schema.TaggedErrorClass<SceneError>()("SceneError", {
  message: Schema.String,
}) {}

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
  after: Schema.optionalKey(Schema.String),
  write: Schema.optionalKey(Schema.String),
  checkRunning: Schema.optionalKey(Schema.Boolean),
  delayMs: Schema.optionalKey(Schema.Int),
  restartArguments: Schema.optionalKey(Schema.Array(Schema.String)),
  resize: Schema.optionalKey(Schema.Struct({ width: Schema.Int, height: Schema.Int })),
  files: Schema.optionalKey(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
})
const PtyActions = Schema.fromJsonString(Schema.Array(PtyAction))
const UnknownJson = Schema.UnknownFromJsonString

const escape = String.fromCharCode(27)
const bell = String.fromCharCode(7)
const osc52Pattern = new RegExp(`${escape}\\]52;[^;]*;([^${bell}${escape}]*)?(?:${bell}|${escape}\\\\)`, "g")
const stripTerminalControl = (text: string) =>
  text
    .replaceAll(new RegExp(`${escape}\\][^${bell}]*(?:${bell}|${escape}\\\\)`, "g"), "")
    .replaceAll(new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, "g"), "")
    .replaceAll(new RegExp(`${escape}[@-_]`, "g"), "")

const waitUntil = <E, R>(condition: Effect.Effect<boolean, E, R>, timeout = 10_000) =>
  Effect.gen(function* () {
    const started = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
    while (!(yield* condition)) {
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
      if (now - started >= timeout) return yield* Effect.die("condition timed out")
      yield* Effect.sleep("20 millis")
    }
  })

const scenario = Effect.fn("Scene.run")(function* (options: Options) {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-scene-" })
  const home = `${root}/home`
  const workspace = `${root}/workspace`
  const state = `${root}/state`
  yield* Effect.forEach([home, workspace, state], (directory) => fs.makeDirectory(directory))
  if (options.globalSettings !== undefined) {
    yield* fs.makeDirectory(`${home}/.config/rika`, { recursive: true })
    const settings = yield* Schema.encodeUnknownEffect(UnknownJson)(options.globalSettings)
    yield* fs.writeFileString(`${home}/.config/rika/settings.json`, settings)
  }
  if (options.workspaceSettings !== undefined) {
    yield* fs.makeDirectory(`${workspace}/.rika`, { recursive: true })
    const settings = yield* Schema.encodeUnknownEffect(UnknownJson)(options.workspaceSettings)
    yield* fs.writeFileString(`${workspace}/.rika/settings.json`, settings)
  }
  yield* Effect.forEach(Object.entries(options.workspace ?? {}), ([path, contents]) =>
    fs.writeFileString(`${workspace}/${path}`, contents),
  )
  const testDirectory = fileURLToPath(new URL(".", import.meta.url))
  const appDirectory = testDirectory.replace(/\/test\/$/, "")
  const helper = `${testDirectory}/fixtures/interactive-pty.py`
  const path = yield* Config.string("PATH").pipe(
    Config.withDefault("/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"),
  )
  const modelEnvironment =
    options.script === undefined
      ? { RIKA_TEST_MODEL_RESPONSE: options.response ?? "completed" }
      : { RIKA_TEST_MODEL_SCRIPT: yield* Schema.encodeUnknownEffect(UnknownJson)(options.script) }
  const residentGrace = options.actions.some((action) => action.restartArguments !== undefined) ? "5000" : "100"
  const environment = yield* Schema.encodeUnknownEffect(UnknownJson)({
    HOME: home,
    PATH: path,
    TERM: "xterm-256color",
    RIKA_TEST_TERMINAL_COLUMNS: options.terminal?.columns,
    RIKA_TEST_TERMINAL_ROWS: options.terminal?.rows,
    RIKA_DATABASE: `${state}/rika.db`,
    RIKA_RELAY_DATABASE: `${state}/relay.db`,
    RIKA_INTERNAL_RESIDENT_GRACE: residentGrace,
    RIKA_INTERNAL_RESIDENT_STARTUP_HOLD: "0",
    ...modelEnvironment,
  })
  if (options.git === true) {
    const runGit = (args: ReadonlyArray<string>) =>
      Effect.scoped(
        spawner
          .spawn(
            ChildProcess.make("git", ["-C", workspace, ...args], {
              stdin: "ignore",
              stdout: "ignore",
              stderr: "pipe",
            }),
          )
          .pipe(
            Effect.flatMap((child) => child.exitCode),
            Effect.filterOrFail(
              (exitCode) => Number(exitCode) === 0,
              () => SceneError.make({ message: `git ${args[0]} failed` }),
            ),
          ),
      )
    yield* runGit(["init", "--quiet"])
    yield* runGit(["add", "."])
    yield* runGit([
      "-c",
      "user.name=Rika Scene",
      "-c",
      "user.email=scene@rika.invalid",
      "commit",
      "--quiet",
      "-m",
      "scene baseline",
    ])
  }
  const encodedActions = yield* Schema.encodeUnknownEffect(PtyActions)(options.actions)
  const handle = yield* spawner.spawn(
    ChildProcess.make(
      "python3",
      [helper, process.execPath, workspace, environment, encodedActions, `${appDirectory}/src/client-main.ts`],
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
  if (Number(helperExitCode) !== 0) return yield* Effect.die(stderr)
  const result = yield* Schema.decodeUnknownEffect(PtyResult)(stdout.trim())
  const terminalOutput = stripTerminalControl(Buffer.from(result.output, "base64").toString("utf8"))
  if (result.timedOut)
    return yield* SceneError.make({
      message: `Scene timed out after ${result.actionsCompleted} actions\n${terminalOutput}`,
    })
  if (result.actionsCompleted !== options.actions.length)
    return yield* SceneError.make({
      message: `Scene completed ${result.actionsCompleted} of ${options.actions.length} actions\n${terminalOutput}`,
    })
  if (result.exitCode !== 0)
    return yield* SceneError.make({ message: `Scene exited with code ${result.exitCode}\n${terminalOutput}` })
  if (result.runningChecks.some((running) => !running))
    return yield* SceneError.make({ message: "Scene exited before a running-process check" })
  yield* waitUntil(
    fs
      .readDirectory(`${state}/diagnostics`)
      .pipe(
        Effect.map((names) =>
          names.every(
            (name) => !name.endsWith(".open.jsonl") || (residentGrace !== "100" && name.startsWith("client-")),
          ),
        ),
      ),
  )
  const names = yield* fs.readDirectory(`${state}/diagnostics`)
  const logs = yield* Effect.forEach(
    names.filter((name) => name.endsWith(".jsonl") || name.endsWith(".open.jsonl")),
    (name) =>
      fs.readFileString(`${state}/diagnostics/${name}`).pipe(Effect.map((contents) => [name, contents] as const)),
  )
  const diagnostics = logs.map(([name, contents]) => `${name}\n${contents}`).join("\n")
  const workspaceNames = yield* fs.readDirectory(workspace)
  const workspaceContents: Record<string, string> = {}
  yield* Effect.forEach(
    workspaceNames.filter((name) => name !== ".rika" && name !== ".git"),
    (name) =>
      Effect.gen(function* () {
        const filename = `${workspace}/${name}`
        if ((yield* fs.stat(filename)).type === "File") workspaceContents[name] = yield* fs.readFileString(filename)
      }),
  )
  const rawOutput = Buffer.from(result.output, "base64").toString("utf8")
  const completed = {
    ...result,
    rawOutput,
    output: stripTerminalControl(rawOutput),
    clipboard: Array.from(rawOutput.matchAll(osc52Pattern), (match) =>
      Buffer.from(match[1] ?? "", "base64").toString("utf8"),
    ),
    clientLogs: logs
      .filter(([name]) => name.startsWith("client-"))
      .map(([, contents]) => contents)
      .join("\n"),
    diagnostics,
    names,
    workspaceContents,
  }
  const { Database } = yield* Effect.promise(() => import("bun:sqlite"))
  const database = new Database(`${state}/rika.db`, { readonly: true })
  const rawTurns = database
    .query<
      {
        readonly prompt: string
        readonly prompt_parts_json: string | null
        readonly status: string
        readonly execution_route_json: string
      },
      []
    >(
      "SELECT prompt, prompt_parts_json, status, execution_route_json FROM rika_turns ORDER BY created_at ASC, rowid ASC",
    )
    .all()
  database.close()
  const persistedTurns = rawTurns.map(({ prompt, prompt_parts_json }) => ({ prompt, prompt_parts_json }))
  const turns = rawTurns.map(({ prompt, status, execution_route_json }) => ({
    prompt,
    status,
    execution_route_json,
    executionRoute: JSON.parse(execution_route_json) as unknown,
  }))
  return { ...completed, persistedTurns, turns }
})

const run = (options: Options) =>
  Effect.runPromise(
    Effect.scoped(
      Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => scenario(options).pipe(Effect.provide(context)))),
    ),
  )

const withDelay = <A extends object>(value: A, delayMs?: number): A & { readonly delayMs?: number } =>
  delayMs === undefined ? value : { ...value, delayMs }

export const Scene = {
  run,
  action: {
    writeAfter: (after: string, write: string, delayMs?: number): Action => ({
      after,
      write,
      ...(delayMs === undefined ? {} : { delayMs }),
    }),
    checkRunningAfter: (after: string, write: string): Action => ({ after, write, checkRunning: true }),
    restartAfter: (after: string, ...restartArguments: ReadonlyArray<string>): Action => ({
      after,
      write: "",
      restartArguments,
    }),
    writeAfterDelay: (write: string, delayMs: number): Action => ({ write, delayMs }),
    resizeAfter: (after: string, width: number, height: number, write?: string): Action => ({
      after,
      resize: { width, height },
      ...(write === undefined ? {} : { write }),
    }),
    resizeAfterDelay: (width: number, height: number, delayMs: number, write?: string): Action => ({
      resize: { width, height },
      delayMs,
      ...(write === undefined ? {} : { write }),
    }),
    filesAfter: (after: string, files: Readonly<Record<string, string | null>>, write?: string): Action => ({
      after,
      files,
      ...(write === undefined ? {} : { write }),
    }),
  },
  model: {
    text: (text: string, delayMs?: number): ModelTurn =>
      withDelay({ parts: [{ type: "text" as const, text }] as const }, delayMs),
    object: (object: unknown, delayMs?: number): ModelTurn => withDelay({ object }, delayMs),
    turn: (parts: ReadonlyArray<ModelPart>, delayMs?: number): ModelTurn => {
      if (parts.length === 0) throw new Error("A deterministic model turn needs at least one part")
      return withDelay({ parts: parts as [ModelPart, ...Array<ModelPart>] }, delayMs)
    },
    textPart: (text: string): ModelPart => ({ type: "text", text }),
    reasoning: (text: string): ModelPart => ({ type: "reasoning", text }),
    toolCall: (name: string, params: unknown, id?: string): ModelPart => ({
      type: "toolCall",
      name,
      params,
      ...(id === undefined ? {} : { id }),
    }),
  },
} as const
