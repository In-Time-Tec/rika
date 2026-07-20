import * as BunServices from "@effect/platform-bun/BunServices"
import type { StartedHost } from "@rika/app/resident-service"
import { Config, Effect, FileSystem, Layer, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { rmSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { afterAll } from "vitest"
import * as ResidentProcessStartup from "../src/resident-process-startup"

type ModelPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | { readonly type: "toolCall"; readonly name: string; readonly params: unknown; readonly id?: string }

type ModelTurn =
  | {
      readonly parts: readonly [ModelPart, ...ReadonlyArray<ModelPart>]
      readonly delayMs?: number
      readonly usage?: ModelUsage
    }
  | { readonly object: unknown; readonly delayMs?: number; readonly usage?: ModelUsage }
  | { readonly failure: string; readonly delayMs?: number; readonly usage?: ModelUsage }

interface ModelUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
}

type Action = {
  readonly after?: string
  readonly childStatus?: string
  readonly childCount?: number
  readonly write?: string
  readonly checkRunning?: boolean
  readonly delayMs?: number
  readonly restartArguments?: ReadonlyArray<string>
  readonly resize?: { readonly width: number; readonly height: number }
  readonly resizes?: ReadonlyArray<{ readonly width: number; readonly height: number }>
  readonly files?: Readonly<Record<string, string | null>>
  readonly queueCount?: number
  readonly queuePrompt?: string
  readonly queueRevision?: number
  readonly turnPrompt?: string
  readonly turnStatus?: string
  readonly timeoutMs?: number
  readonly visible?: boolean
}

type SceneSymlink = {
  readonly path: string
  readonly target: string
  readonly outside?: boolean
}

type SceneExecutable = {
  readonly name: string
  readonly exitCode?: number
  readonly waitForInput?: boolean
}

interface Options {
  readonly actions: ReadonlyArray<Action>
  readonly files?: ReadonlyArray<{ readonly path: string; readonly bytes: Uint8Array; readonly executable?: boolean }>
  readonly arguments?: ReadonlyArray<string>
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
  readonly editorContent?: string
  readonly mediaAnalyzer?: { readonly response: string } | { readonly error: string }
  readonly toolApprovals?: ReadonlyArray<string>
  readonly inspectPaths?: ReadonlyArray<string>
  readonly outsideFiles?: Readonly<Record<string, string>>
  readonly symlinks?: ReadonlyArray<SceneSymlink>
  readonly environment?: Readonly<Record<string, string | null>>
  readonly executable?: SceneExecutable
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
    blockedAction: Schema.Unknown,
    finalWidth: Schema.Int,
    finalHeight: Schema.Int,
  }),
)
const PtyAction = Schema.Struct({
  after: Schema.optionalKey(Schema.String),
  childStatus: Schema.optionalKey(Schema.String),
  childCount: Schema.optionalKey(Schema.Int),
  write: Schema.optionalKey(Schema.String),
  checkRunning: Schema.optionalKey(Schema.Boolean),
  delayMs: Schema.optionalKey(Schema.Int),
  restartArguments: Schema.optionalKey(Schema.Array(Schema.String)),
  resize: Schema.optionalKey(Schema.Struct({ width: Schema.Int, height: Schema.Int })),
  resizes: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        width: Schema.Int,
        height: Schema.Int,
      }),
    ),
  ),
  files: Schema.optionalKey(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
  queueCount: Schema.optionalKey(Schema.Int),
  queuePrompt: Schema.optionalKey(Schema.String),
  queueRevision: Schema.optionalKey(Schema.Int),
  turnPrompt: Schema.optionalKey(Schema.String),
  turnStatus: Schema.optionalKey(Schema.String),
  timeoutMs: Schema.optionalKey(Schema.Int),
  visible: Schema.optionalKey(Schema.Boolean),
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

interface WarmResident {
  readonly root: string
  readonly home: string
  readonly state: string
  readonly modelScriptFile: string
  readonly handle: StartedHost
  readonly startupLogs: ReadonlyMap<string, string>
}

let warmResident: WarmResident | undefined
let modelScriptRevision = 0

const stopWarmResident = async () => {
  const current = warmResident
  warmResident = undefined
  if (current === undefined) return
  try {
    process.kill(current.handle.pid, "SIGTERM")
  } catch {}
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline && (await Effect.runPromise(ResidentProcessStartup.processIsAlive(current.handle.pid))))
    await Bun.sleep(20)
  if (await Effect.runPromise(ResidentProcessStartup.processIsAlive(current.handle.pid)))
    await Effect.runPromise(current.handle.abort)
  rmSync(current.root, { recursive: true, force: true })
}

afterAll(stopWarmResident)

const diagnosticProcessRunning = (name: string) => {
  if (!name.endsWith(".open.jsonl")) return false
  const pid = Number.parseInt(name.slice(0, -".open.jsonl".length).split("-").at(-1) ?? "", 10)
  if (!Number.isInteger(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const readDiagnosticLogs = Effect.fn("Scene.readDiagnosticLogs")(function* (state: string) {
  const fs = yield* FileSystem.FileSystem
  const names = yield* fs.readDirectory(`${state}/diagnostics`).pipe(Effect.orElseSucceed(() => []))
  const logs = yield* Effect.forEach(
    names.filter((name) => name.endsWith(".jsonl") || name.endsWith(".open.jsonl")),
    (name) =>
      fs.readFileString(`${state}/diagnostics/${name}`).pipe(Effect.map((contents) => [name, contents] as const)),
  )
  return new Map(logs)
})

const currentDiagnosticLogs = (
  logs: ReadonlyMap<string, string>,
  baseline: ReadonlyMap<string, string>,
  startup: ReadonlyMap<string, string>,
) => {
  const presentationStartup = new Map(startup)
  for (const [name, contents] of baseline) {
    if (!name.startsWith("resident-")) continue
    const configured = contents
      .split("\n")
      .filter((line) => line.includes('"message":"model.backend.configured"'))
      .join("\n")
    if (configured.length > 0 && !(presentationStartup.get(name) ?? "").includes(configured))
      presentationStartup.set(name, `${presentationStartup.get(name) ?? ""}${configured}\n`)
  }
  return Array.from(logs, ([name, contents]) => {
    const initial = presentationStartup.get(name) ?? ""
    const offset = baseline.get(name)?.length ?? 0
    return [name, `${initial}${contents.slice(offset)}`] as const
  }).filter(([, contents]) => contents.length > 0)
}

const waitUntil = <E, R>(condition: Effect.Effect<boolean, E, R>, timeout = 10_000) =>
  Effect.gen(function* () {
    const started = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
    while (!(yield* condition)) {
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
      if (now - started >= timeout) return yield* Effect.die("condition timed out")
      yield* Effect.sleep("20 millis")
    }
  })

const scenario = Effect.fn("Scene.run")(function* (options: Options, warm: boolean) {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-scene-" })
  let home = `${root}/home`
  const workspace = `${root}/workspace`
  const outside = `${root}/outside`
  let state = `${root}/state`
  const bin = `${root}/bin`
  yield* Effect.forEach([home, workspace, outside, state, bin], (directory) => fs.makeDirectory(directory))
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
    fs
      .makeDirectory(`${workspace}/${path.split("/").slice(0, -1).join("/")}`, { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(`${workspace}/${path}`, contents))),
  )
  yield* Effect.forEach(
    options.files ?? [],
    (file) =>
      fs
        .makeDirectory(`${workspace}/${file.path.split("/").slice(0, -1).join("/")}`, { recursive: true })
        .pipe(
          Effect.andThen(fs.writeFile(`${workspace}/${file.path}`, file.bytes)),
          Effect.andThen(file.executable === true ? fs.chmod(`${workspace}/${file.path}`, 0o700) : Effect.void),
        ),
    { discard: true },
  )
  yield* Effect.forEach(Object.entries(options.outsideFiles ?? {}), ([name, contents]) =>
    fs.writeFileString(`${outside}/${name}`, contents),
  )
  yield* Effect.forEach(options.symlinks ?? [], (link) =>
    fs.symlink(`${link.outside === true ? outside : workspace}/${link.target}`, `${workspace}/${link.path}`),
  )
  const openLog = `${state}/opens.jsonl`
  if (options.executable !== undefined) {
    const executable = `${bin}/${options.executable.name}`
    const source = [
      "#!/usr/bin/env python3",
      "import json, os, sys",
      'with open(os.environ["RIKA_SCENE_OPEN_LOG"], "a") as stream:',
      "    stream.write(json.dumps(sys.argv[1:]) + '\\n')",
      ...(options.executable.waitForInput === true
        ? ['print("EDITOR ACTIVE", flush=True)', "sys.stdin.readline()"]
        : []),
      `sys.exit(${options.executable.exitCode ?? 0})`,
      "",
    ].join("\n")
    yield* fs.writeFileString(executable, source, { mode: 0o755 })
  }
  const testDirectory = fileURLToPath(new URL(".", import.meta.url))
  const appDirectory = testDirectory.replace(/\/test\/$/, "")
  const helper = `${testDirectory}/fixtures/interactive-pty.py`
  const editor = `${testDirectory}/fixtures/composer-editor.sh`
  const path = yield* Config.string("PATH").pipe(
    Config.withDefault("/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"),
  )
  let modelScriptFile = `${state}/test-model-script.json`
  if (warm) {
    if (warmResident === undefined) {
      const warmRoot = yield* fs.makeTempDirectory({ prefix: "rika-scene-warm-" })
      home = `${warmRoot}/home`
      state = `${warmRoot}/state`
      modelScriptFile = `${state}/test-model-script.json`
      yield* Effect.forEach([home, state], (directory) => fs.makeDirectory(directory), { discard: true })
    } else {
      home = warmResident.home
      state = warmResident.state
      modelScriptFile = warmResident.modelScriptFile
    }
  }
  const modelScript =
    options.script ??
    Array.from({ length: 4 }, () => ({ parts: [{ type: "text", text: options.response ?? "completed" }] }))
  modelScriptRevision += 1
  const encodedModelScript = yield* Schema.encodeUnknownEffect(UnknownJson)(modelScript)
  yield* fs.writeFileString(modelScriptFile, `${encodedModelScript}\n${" ".repeat(modelScriptRevision)}`)
  const modelEnvironment = { RIKA_TEST_MODEL_SCRIPT_FILE: modelScriptFile }
  const restartsClient = options.actions.some((action) => action.restartArguments !== undefined)
  const residentGrace = restartsClient ? "5000" : "100"
  let clientEntrypoint = `${appDirectory}/src/main.ts`
  if (restartsClient) clientEntrypoint = `${appDirectory}/src/client-main.ts`
  let editorEnvironment: Readonly<Record<string, string>>
  if (options.editorContent !== undefined) {
    editorEnvironment = { EDITOR: editor, VISUAL: editor, RIKA_TEST_EDITOR_CONTENT: options.editorContent }
  } else if (options.executable === undefined) {
    editorEnvironment = { EDITOR: "/usr/bin/false", VISUAL: "/usr/bin/false" }
  } else {
    editorEnvironment = { EDITOR: `${bin}/${options.executable.name}`, VISUAL: `${bin}/${options.executable.name}` }
  }
  let mediaAnalyzerEnvironment: Readonly<Record<string, string>> = {}
  if (options.mediaAnalyzer !== undefined) {
    mediaAnalyzerEnvironment =
      "response" in options.mediaAnalyzer
        ? { RIKA_TEST_MEDIA_ANALYZER_RESPONSE: options.mediaAnalyzer.response }
        : { RIKA_TEST_MEDIA_ANALYZER_ERROR: options.mediaAnalyzer.error }
  }
  const processEnvironment = {
    HOME: home,
    PATH: `${workspace}/bin:${options.executable === undefined ? "" : `${bin}:`}${path}`,
    TERM: "xterm-256color",
    RIKA_TEST_TERMINAL_COLUMNS: options.terminal?.columns,
    RIKA_TEST_TERMINAL_ROWS: options.terminal?.rows,
    RIKA_DATABASE: `${state}/rika.db`,
    RIKA_RELAY_DATABASE: `${state}/relay.db`,
    RIKA_INTERNAL_RESIDENT_STARTUP_HOLD: "0",
    RELAY_EVENT_POLL_INTERVAL_MILLIS: "10",
    RELAY_EVENT_POLL_IDLE_INTERVAL_MILLIS: "10",
    RELAY_SCHEDULER_POLL_INTERVAL_MILLIS: "10",
    ...editorEnvironment,
    ...mediaAnalyzerEnvironment,
    ...(options.toolApprovals === undefined ? {} : { RIKA_TEST_APPROVAL_TOOLS: options.toolApprovals.join(",") }),
    ...(options.executable === undefined ? {} : { RIKA_SCENE_OPEN_LOG: openLog }),
    ...options.environment,
    ...modelEnvironment,
  }
  const residentEnvironment = Object.fromEntries(
    Object.entries(processEnvironment).flatMap(([name, value]) =>
      value === undefined || value === null ? [] : [[name, String(value)] as const],
    ),
  )
  let resident: StartedHost
  let startupLogs: ReadonlyMap<string, string>
  if (warm && warmResident !== undefined) {
    resident = warmResident.handle
    startupLogs = warmResident.startupLogs
  } else {
    resident = yield* ResidentProcessStartup.spawn({
      executable: process.execPath,
      arguments: [`${appDirectory}/src/main.ts`],
      environment: {
        ...residentEnvironment,
        RIKA_INTERNAL_RESIDENT_HOST: "1",
        RIKA_INTERNAL_RESIDENT_PROFILE: "default",
        RIKA_INTERNAL_RESIDENT_DATA_ROOT: state,
        RIKA_INTERNAL_RESIDENT_GRACE: "60000",
      },
    })
    yield* resident.startup
    yield* waitUntil(
      readDiagnosticLogs(state).pipe(
        Effect.map((logs) =>
          Array.from(logs.values()).some((contents) => contents.includes("resident.listener.ready")),
        ),
      ),
    )
    startupLogs = yield* readDiagnosticLogs(state)
    if (warm) {
      yield* resident.detach
      const warmRoot = state.slice(0, -"/state".length)
      warmResident = { root: warmRoot, home, state, modelScriptFile, handle: resident, startupLogs }
    } else {
      yield* Effect.addFinalizer(() => resident.abort)
    }
  }
  const diagnosticBaseline = yield* readDiagnosticLogs(state)
  const { Database } = yield* Effect.promise(() => import("bun:sqlite"))
  let turnBaseline = 0
  if (yield* fs.exists(`${state}/rika.db`)) {
    const rikaDatabase = new Database(`${state}/rika.db`, { readonly: true })
    turnBaseline =
      rikaDatabase.query<{ readonly rowid: number }, []>("SELECT max(rowid) AS rowid FROM rika_turns").get()?.rowid ?? 0
    rikaDatabase.close()
  }
  let childBaseline = 0
  if (yield* fs.exists(`${state}/relay.db`)) {
    const relayDatabase = new Database(`${state}/relay.db`, { readonly: true })
    childBaseline =
      relayDatabase.query<{ readonly rowid: number }, []>("SELECT max(rowid) AS rowid FROM relay_executions").get()
        ?.rowid ?? 0
    relayDatabase.close()
  }
  const environment = yield* Schema.encodeUnknownEffect(UnknownJson)({
    ...processEnvironment,
    RIKA_INTERNAL_RESIDENT_GRACE: residentGrace,
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
  const encodedActions = yield* Schema.encodeUnknownEffect(PtyActions)(
    options.actions.map((action) => ({
      ...action,
      ...(action.write === undefined ? {} : { write: action.write.replaceAll("{workspace}", workspace) }),
    })),
  )
  const handle = yield* spawner.spawn(
    ChildProcess.make(
      "python3",
      [
        helper,
        process.execPath,
        workspace,
        environment,
        encodedActions,
        clientEntrypoint,
        ...(options.arguments ?? []),
      ],
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
      duration: "50 seconds",
      orElse: () =>
        handle
          .kill({ killSignal: "SIGTERM" })
          .pipe(Effect.ignore, Effect.andThen(Effect.die("PTY helper did not exit"))),
    }),
  )
  if (!warm) {
    yield* Effect.sync(() => {
      try {
        process.kill(resident.pid, "SIGTERM")
      } catch {}
    })
    yield* waitUntil(
      ResidentProcessStartup.processIsAlive(resident.pid).pipe(Effect.map((alive) => !alive)),
      2_000,
    ).pipe(Effect.catchCause(() => resident.abort))
  }
  if (Number(helperExitCode) !== 0) return yield* Effect.die(stderr)
  const result = yield* Schema.decodeUnknownEffect(PtyResult)(stdout.trim())
  const terminalOutput = stripTerminalControl(Buffer.from(result.output, "base64").toString("utf8"))
  if (result.timedOut)
    return yield* SceneError.make({
      message: `Scene timed out after ${result.actionsCompleted} actions while waiting for ${JSON.stringify(result.blockedAction)}\n${terminalOutput}`,
    })
  if (result.actionsCompleted !== options.actions.length)
    return yield* SceneError.make({
      message: `Scene completed ${result.actionsCompleted} of ${options.actions.length} actions\n${terminalOutput}`,
    })
  if (result.exitCode !== 0)
    return yield* SceneError.make({ message: `Scene exited with code ${result.exitCode}\n${terminalOutput}` })
  if (result.runningChecks.some((running) => !running))
    return yield* SceneError.make({ message: "Scene exited before a running-process check" })
  if (warm)
    yield* waitUntil(
      Effect.sync(() => {
        const database = new Database(`${state}/rika.db`, { readonly: true })
        const counts = database
          .query<
            { readonly total: number; readonly unsettled: number },
            [number]
          >("SELECT count(*) AS total, sum(CASE WHEN status IN ('queued', 'running') THEN 1 ELSE 0 END) AS unsettled FROM rika_turns WHERE rowid > ?")
          .get(turnBaseline)
        database.close()
        return counts !== null && counts.total > 0 && counts.unsettled === 0
      }),
    )
  yield* waitUntil(
    fs
      .readDirectory(`${state}/diagnostics`)
      .pipe(
        Effect.map((names) =>
          names.every((name) => name.endsWith(`-${resident.pid}.open.jsonl`) || !diagnosticProcessRunning(name)),
        ),
      ),
  ).pipe(
    Effect.catchDefect(() =>
      Effect.gen(function* () {
        const names = yield* fs.readDirectory(`${state}/diagnostics`).pipe(Effect.orElseSucceed(() => []))
        const leaked = names.filter(
          (name) => !name.endsWith(`-${resident.pid}.open.jsonl`) && diagnosticProcessRunning(name),
        )
        for (const name of leaked) {
          const pid = Number.parseInt(name.slice(0, -".open.jsonl".length).split("-").at(-1) ?? "", 10)
          if (Number.isInteger(pid))
            yield* Effect.sync(() => {
              try {
                process.kill(pid, "SIGKILL")
              } catch {}
            })
        }
        return yield* SceneError.make({ message: `Scene leaked running processes: ${leaked.join(", ")}` })
      }),
    ),
  )
  const allLogs = yield* readDiagnosticLogs(state)
  const logs = currentDiagnosticLogs(allLogs, diagnosticBaseline, startupLogs)
  const names = logs.map(([name]) => name)
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
  const workspaceFiles = Object.fromEntries(
    yield* Effect.forEach(options.inspectPaths ?? [], (name) =>
      fs.readFileString(`${workspace}/${name}`).pipe(
        Effect.map((content) => [name, content] as const),
        Effect.orElseSucceed(() => [name, null] as const),
      ),
    ),
  )
  const inspectedPaths = Object.fromEntries(
    Object.entries(workspaceFiles).map(([name, contents]) => [name, contents !== null]),
  )
  const opens = yield* fs.readFileString(openLog).pipe(
    Effect.map((contents) =>
      contents
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => Schema.decodeUnknownSync(UnknownJson)(line) as ReadonlyArray<string>),
    ),
    Effect.orElseSucceed(() => [] as ReadonlyArray<ReadonlyArray<string>>),
  )
  const childExecutions = (yield* fs.exists(`${state}/relay.db`))
    ? yield* Effect.acquireUseRelease(
        Effect.sync(() => new Database(`${state}/relay.db`, { readonly: true })),
        (relayDatabase) =>
          Effect.sync(() =>
            relayDatabase
              .query<
                { readonly id: string; readonly status: string },
                [number]
              >("select id, status from relay_executions where id like 'child:%' and rowid > ? order by id")
              .all(childBaseline),
          ),
        (connection) => Effect.sync(() => connection.close()),
      )
    : []
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
    residentLogs: logs
      .filter(([name]) => name.startsWith("resident-"))
      .map(([, contents]) => contents)
      .join("\n"),
    diagnostics,
    opens,
    names,
    workspaceContents,
    workspaceFiles,
    inspectedPaths,
    childExecutions,
  }
  const database = new Database(`${state}/rika.db`, { readonly: true })
  const rawTurns = database
    .query<
      {
        readonly prompt: string
        readonly prompt_parts_json: string | null
        readonly status: string
        readonly execution_route_json: string
      },
      [number]
    >(
      "SELECT prompt, prompt_parts_json, status, execution_route_json FROM rika_turns WHERE rowid > ? ORDER BY created_at ASC, rowid ASC",
    )
    .all(turnBaseline)
  database.close()
  const persistedTurns = rawTurns.map(({ prompt, prompt_parts_json }) => ({ prompt, prompt_parts_json }))
  const turns = rawTurns.map(({ prompt, status, execution_route_json }) => ({
    prompt,
    status,
    execution_route_json,
    executionRoute: Schema.decodeUnknownSync(UnknownJson)(execution_route_json),
  }))
  const pastedDirectory = `${workspace}/.rika/pasted`
  const pastedFiles = (yield* fs.readDirectory(pastedDirectory).pipe(Effect.orElseSucceed(() => []))).toSorted()
  return { ...completed, persistedTurns, turns, pastedFiles }
})

const runWithProfile = (options: Options, warm: boolean) =>
  Effect.runPromise(
    Effect.scoped(
      Layer.build(BunServices.layer).pipe(
        Effect.flatMap((context) => scenario(options, warm).pipe(Effect.provide(context))),
      ),
    ),
  )

const run = (options: Options) => runWithProfile(options, false)
const runWarm = (options: Options) => runWithProfile(options, true)

const withOptions = <A extends object>(
  value: A,
  delayMs?: number,
  usage?: ModelUsage,
): A & { readonly delayMs?: number; readonly usage?: ModelUsage } => ({
  ...value,
  ...(delayMs === undefined ? {} : { delayMs }),
  ...(usage === undefined ? {} : { usage }),
})

const mouseClick = (column: number, row: number): string =>
  `${escape}[<0;${column};${row}M${escape}[<0;${column};${row}m`

export const Scene = {
  run,
  runWarm,
  action: {
    writeAfter: (after: string, write: string, delayMs?: number): Action => ({
      after,
      write,
      ...(delayMs === undefined ? {} : { delayMs }),
    }),
    writeAfterVisible: (after: string, write: string, delayMs?: number): Action => ({
      after,
      write,
      visible: true,
      ...(delayMs === undefined ? {} : { delayMs }),
    }),
    writeWhenQueued: (queueCount: number, write: string, delayMs?: number): Action => ({
      write,
      queueCount,
      ...(delayMs === undefined ? {} : { delayMs }),
    }),
    writeWhenQueueRevision: (queuePrompt: string, queueRevision: number, write: string): Action => ({
      write,
      queuePrompt,
      queueRevision,
    }),
    writeWhenTurnStatus: (turnPrompt: string, turnStatus: string, write: string, delayMs?: number): Action => ({
      turnPrompt,
      turnStatus,
      write,
      ...(delayMs === undefined ? {} : { delayMs }),
    }),
    writeAfterVisibleWhenQueued: (after: string, queueCount: number, write: string): Action => ({
      after,
      write,
      queueCount,
      visible: true,
    }),
    writeAfterChildExecutions: (childStatus: string, childCount: number, write: string, delayMs?: number): Action => ({
      childStatus,
      childCount,
      write,
      ...(delayMs === undefined ? {} : { delayMs }),
    }),
    checkRunningAfter: (after: string, write: string): Action => ({ after, write, checkRunning: true }),
    restartAfter: (after: string, ...restartArguments: ReadonlyArray<string>): Action => ({
      after,
      write: "",
      restartArguments,
    }),
    restartWhenTurn: (turnPrompt: string, turnStatus: string, ...restartArguments: ReadonlyArray<string>): Action => ({
      turnPrompt,
      turnStatus,
      restartArguments,
    }),
    reconnectAfter: (after: string, write = ""): Action => ({
      after,
      write,
      restartArguments: ["threads", "continue", "--last"],
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
    clickAfter: (after: string, column: number, row: number): Action => ({
      after,
      write: mouseClick(column, row),
    }),
    clickRowsAfter: (after: string, column: number, rows: ReadonlyArray<number>): Action => ({
      after,
      write: rows.map((row) => mouseClick(column, row)).join(""),
    }),
    clickGridAfter: (after: string, columns: ReadonlyArray<number>, rows: ReadonlyArray<number>): Action => ({
      after,
      write: rows.flatMap((row) => columns.map((column) => mouseClick(column, row))).join(""),
    }),
    resizeBurstAfter: (
      after: string,
      resizes: ReadonlyArray<{ readonly width: number; readonly height: number }>,
      write = "",
      delayMs = 150,
    ): Action => ({ after, write, resizes, delayMs, checkRunning: true }),
  },
  model: {
    text: (text: string, delayMs?: number, usage?: ModelUsage): ModelTurn =>
      withOptions({ parts: [{ type: "text" as const, text }] as const }, delayMs, usage),
    object: (object: unknown, delayMs?: number, usage?: ModelUsage): ModelTurn =>
      withOptions({ object }, delayMs, usage),
    failure: (message: string, delayMs?: number, usage?: ModelUsage): ModelTurn =>
      withOptions({ failure: message }, delayMs, usage),
    turn: (parts: ReadonlyArray<ModelPart>, delayMs?: number, usage?: ModelUsage): ModelTurn => {
      if (parts.length === 0) throw new Error("A deterministic model turn needs at least one part")
      return withOptions({ parts: parts as [ModelPart, ...Array<ModelPart>] }, delayMs, usage)
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
