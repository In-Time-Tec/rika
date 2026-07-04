import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname } from "node:path"
import { Config, Settings } from "@rika/core"
import * as Keymap from "@rika/tui/keymap"
import { Context, Effect, Layer, Option, Schema } from "effect"
import * as Args from "./args"
import * as Output from "./output"

export interface Input {
  readonly env: Record<string, string | undefined>
  readonly cwd: string
  readonly home?: string
  readonly system?: System
}

export interface System {
  readonly readText: (path: string) => Effect.Effect<string, unknown>
  readonly writeText: (path: string, content: string) => Effect.Effect<void, unknown>
  readonly makeDirectory: (path: string) => Effect.Effect<void, unknown>
  readonly runEditor: (
    command: ReadonlyArray<string>,
    path: string,
    input: { readonly cwd: string; readonly env: Record<string, string | undefined> },
  ) => Effect.Effect<void, unknown>
}

export class ConfigCommandError extends Schema.TaggedErrorClass<ConfigCommandError>()("ConfigCommandError", {
  message: Schema.String,
  action: Args.ConfigAction,
  path: Schema.optional(Schema.String),
}) {}

export type RunError = ConfigCommandError | Config.ConfigError

export interface Interface {
  readonly executeCommand: (command: Args.ConfigCommand) => Effect.Effect<number, RunError, Output.Service>
}

export class Service extends Context.Service<Service, Interface>()("@rika/cli/Config") {}

export const layerFromInput = (input: Input) =>
  Layer.succeed(
    Service,
    Service.of({
      executeCommand: Effect.fn("Cli.Config.executeCommand.layer")(function* (command: Args.ConfigCommand) {
        const output = yield* Output.Service
        const system = input.system ?? liveSystem
        if (command.action === "list") return yield* executeList(input, output)
        if (command.action === "edit") return yield* executeEdit(command, input, output, system)
        return yield* executeKeymap(input, output)
      }),
    }),
  )

export const executeCommand = Effect.fn("Cli.Config.executeCommand")(function* (command: Args.ConfigCommand) {
  const service = Option.getOrUndefined(yield* Effect.serviceOption(Service))
  if (service === undefined) {
    return yield* new ConfigCommandError({ message: "Config service is required", action: command.action })
  }
  return yield* service.executeCommand(command)
})

export const formatError = (error: RunError) => {
  if (error instanceof ConfigCommandError) return error.message
  if (error instanceof Error) return `Rika failed: ${error.message}`
  return `Rika failed: ${String(error)}`
}

const executeList = (input: Input, output: Output.Interface): Effect.Effect<number, Config.ConfigError> =>
  Effect.gen(function* () {
    const workspaceRoot = input.env.RIKA_WORKSPACE_ROOT ?? input.cwd
    const snapshot = yield* Settings.loadSnapshotFromEnv(input.env, workspaceRoot)
    const config = yield* Config.valuesFromEnv(input.env, workspaceRoot)
    const entries = [
      runtimeEntry("workspace.root", "RIKA_WORKSPACE_ROOT", config.workspace_root, input.env.RIKA_WORKSPACE_ROOT),
      runtimeEntry("data.dir", "RIKA_DATA_DIR", config.data_dir, input.env.RIKA_DATA_DIR),
      runtimeEntry("database.url", "RIKA_DATABASE_URL", config.database_url ?? null, input.env.RIKA_DATABASE_URL),
      runtimeEntry("backend.id", "RIKA_BACKEND_ID", config.backend_id ?? null, input.env.RIKA_BACKEND_ID),
      runtimeEntry(
        "subagent.tools",
        "RIKA_SUBAGENT_TOOLS",
        Config.subagentTools(config),
        input.env.RIKA_SUBAGENT_TOOLS,
      ),
      ...Settings.entries(snapshot),
    ]
    yield* output.stdout(formatJson({ entries, warnings: snapshot.warnings }))
    return 0
  })

const executeKeymap = (input: Input, output: Output.Interface): Effect.Effect<number> =>
  Effect.gen(function* () {
    const workspaceRoot = input.env.RIKA_WORKSPACE_ROOT ?? input.cwd
    const snapshot = yield* Settings.loadSnapshotFromEnv(input.env, workspaceRoot)
    const keymap = Keymap.effectiveKeymap({ entries: snapshot.values.keymap, sources: snapshot.keymapSources })
    yield* output.stdout(formatJson({ entries: keymap.entries, warnings: [...snapshot.warnings, ...keymap.warnings] }))
    return 0
  })

const executeEdit = (
  command: Args.ConfigCommand,
  input: Input,
  output: Output.Interface,
  system: System,
): Effect.Effect<number, ConfigCommandError> =>
  Effect.gen(function* () {
    const source = command.workspace ? "workspace" : "user"
    const path = targetSettingsPath(source, input)
    yield* ensureSettingsFile(system, path, command.action)
    const editor = yield* editorCommand(input, command.action)
    yield* system
      .runEditor(editor, path, { cwd: input.cwd, env: input.env })
      .pipe(Effect.mapError((cause) => commandError(cause, command.action, path)))
    const content = yield* system
      .readText(path)
      .pipe(Effect.mapError((cause) => commandError(cause, command.action, path)))
    const warnings = Settings.validateSettingsText(content, path, source)
    for (const warning of warnings) {
      yield* output.stderr(formatWarning(warning))
    }
    yield* output.stdout(`edited ${path}`)
    return 0
  })

const ensureSettingsFile = (
  system: System,
  path: string,
  action: Args.ConfigAction,
): Effect.Effect<void, ConfigCommandError> =>
  Effect.gen(function* () {
    yield* system.makeDirectory(dirname(path)).pipe(Effect.mapError((cause) => commandError(cause, action, path)))
    const existing = yield* Effect.result(system.readText(path))
    if (existing._tag === "Success") return
    if (isNotFound(existing.failure)) {
      yield* system.writeText(path, "{}\n").pipe(Effect.mapError((cause) => commandError(cause, action, path)))
      return
    }
    yield* commandError(existing.failure, action, path)
  })

const targetSettingsPath = (source: "user" | "workspace", input: Input) =>
  source === "workspace"
    ? Settings.workspaceSettingsPath(input.env.RIKA_WORKSPACE_ROOT ?? input.cwd)
    : Settings.userSettingsPath(input.home ?? input.env.HOME ?? homedir())

const editorCommand = (
  input: Input,
  action: Args.ConfigAction,
): Effect.Effect<ReadonlyArray<string>, ConfigCommandError> =>
  Effect.gen(function* () {
    const editor = input.env.EDITOR ?? input.env.VISUAL
    if (editor === undefined || editor.trim().length === 0) {
      return yield* new ConfigCommandError({ message: "EDITOR is required for rika config edit", action })
    }
    return editor.trim().split(/\s+/)
  })

const runtimeEntry = (key: string, env: string, value: Settings.SettingValue, envValue: string | undefined) => ({
  key,
  env,
  value,
  source: envValue === undefined || envValue.length === 0 ? "default" : "env",
})

const formatWarning = (warning: Settings.Warning) =>
  warning.key === undefined
    ? `warning: ${warning.path}: ${warning.message}`
    : `warning: ${warning.path}: ${warning.key}: ${warning.message}`

const formatJson = (value: unknown) => JSON.stringify(value, null, 2)

const liveSystem: System = {
  readText: (path) =>
    Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (cause) => cause,
    }),
  writeText: (path, content) =>
    Effect.tryPromise({
      try: () => writeFile(path, content),
      catch: (cause) => cause,
    }),
  makeDirectory: (path) =>
    Effect.tryPromise({
      try: () => mkdir(path, { recursive: true }),
      catch: (cause) => cause,
    }),
  runEditor: (command, path, input) =>
    Effect.tryPromise({
      try: async () => {
        const subprocess = Bun.spawn([...command, path], {
          cwd: input.cwd,
          env: definedEnv(input.env),
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        })
        const exitCode = await subprocess.exited
        if (exitCode !== 0) throw new Error(`EDITOR exited with status ${exitCode}`)
      },
      catch: (cause) => cause,
    }),
}

const definedEnv = (env: Record<string, string | undefined>) => {
  const output: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) output[key] = value
  }
  return output
}

const commandError = (cause: unknown, action: Args.ConfigAction, path?: string) =>
  new ConfigCommandError({ message: errorMessage(cause), action, ...(path === undefined ? {} : { path }) })

const isNotFound = (cause: unknown) =>
  isRecord(cause) && "code" in cause && typeof cause.code === "string" && cause.code === "ENOENT"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const errorMessage = (cause: unknown) => {
  if (cause instanceof Error) return cause.message
  return String(cause)
}
