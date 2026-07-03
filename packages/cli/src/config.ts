import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname } from "node:path"
import { Config, Settings } from "@rika/core"
import { Context, Effect, Layer, Option, Schema } from "effect"
import * as Args from "./args"
import * as Output from "./output"

export const keymapText = [
  "{",
  '  "leader": "ctrl+x", // Leader key for <leader> shortcuts',
  '  "amp.disconnect": null, // Disconnect the active thread without reconnecting',
  '  "amp.endCredits": null, // Roll the full-screen Amp credits',
  '  "amp.help": null, // Show help & keymaps',
  '  "amp.quit": "ctrl+c ctrl+c", // Quit',
  '  "amp.reconnect": null, // Disconnect and reconnect the active thread',
  '  "amp.relaunch": null, // Quit, reopen Amp, and resume active threads',
  '  "amp.showVersion": null, // Show current Amp version',
  '  "amp.showWelcome": null, // Show the welcome message again',
  '  "feedback.sendReportWithDiagnostics": null, // Generate and send a diagnostic report for Amp support',
  '  "ide.connect": null, // Connect to an IDE',
  '  "label.add": null, // Add label to thread',
  '  "label.remove": null, // Remove label from thread',
  '  "mcp.authenticate": null, // Retry OAuth authentication for an MCP server',
  '  "mcp.info": null, // Show MCP servers and tools',
  '  "mode.toggle": "ctrl+s", // Switch to the next available mode',
  '  "mode.toggleReasoningEffort": "alt+d", // Cycle reasoning effort for the active model',
  '  "mode.use.deep1": null, // Enable deep1 mode',
  '  "mode.use.deep2": null, // Enable deep2 mode',
  '  "mode.use.deep3": null, // Enable deep3 mode',
  '  "mode.use.large": null, // Enable large mode',
  '  "mode.use.nostromo": null, // Enable nostromo mode',
  '  "mode.use.review": null, // Enable review mode',
  '  "mode.use.rush": null, // Enable rush mode',
  '  "mode.use.smart": null, // Enable smart mode',
  '  "news.open": null, // Open Amp Chronicle in browser',
  '  "plugins.activity": null, // Show recent plugin activity triggered by hooks',
  '  "plugins.list": null, // List all loaded plugins',
  '  "plugins.reload": null, // Reload all plugins',
  '  "prompt.clear": null, // Clear input',
  '  "prompt.copySelection": null, // Copy selection',
  '  "prompt.dequeue": null, // Dequeue prompts',
  '  "prompt.history": "ctrl+r", // Restore a previous prompt',
  '  "prompt.openInEditor": "ctrl+g", // Edit prompt in $EDITOR',
  '  "prompt.pasteImageFromClipboard": "ctrl+v", // Paste image from clipboard',
  '  "prompt.steerQueuedMessage": null, // Steer with the next queued prompt',
  '  "settings.openInEditor": null, // Open CLI settings in $EDITOR',
  '  "skills.list": null, // List available skills for this thread',
  '  "speed.toggleFast": "alt+r", // Toggle fast speed for this thread',
  '  "thread.analyzeContext": null, // Show token usage by prompt section for this thread',
  '  "thread.archive": "ctrl+c ctrl+n", // Archive and new thread',
  '  "thread.archiveAndQuit": "ctrl+c ctrl+e", // Archive and quit',
  '  "thread.archiveSelectedInSidebar": "mod+shift+e", // Archive the selected sidebar thread',
  '  "thread.copyID": null, // Copy thread ID',
  '  "thread.copyMarkdown": null, // Copy thread as Markdown',
  '  "thread.copyURL": null, // Copy thread URL',
  '  "thread.mention": null, // Mention a thread',
  '  "thread.new": null, // Start new thread',
  '  "thread.newRemote": "<leader>r", // Toggle remote sandbox mode for the next thread',
  '  "thread.openInBrowser": null, // Open thread in browser',
  '  "thread.rename": null, // Rename thread title',
  '  "thread.selectRemoteExecutor": null, // Choose whether the next remote thread runs in the Orb or a daemon',
  '  "thread.selectRemoteProject": null, // Choose the project for the next remote thread',
  '  "thread.showCost": null, // Show usage cost and entitlement for the active thread',
  '  "thread.showHideSidebar": null, // Show or hide the thread sidebar',
  '  "thread.switch": null, // Switch to existing thread',
  '  "thread.switchToNext": null, // Switch to next thread',
  '  "thread.switchToNextInSidebar": "ctrl+alt+down", // Switch to next thread in sidebar',
  '  "thread.switchToPrevious": null, // Switch to previous thread',
  '  "thread.switchToPreviousInSidebar": "ctrl+alt+up", // Switch to previous thread in sidebar',
  '  "thread.toggleDetails": "alt+t", // Expand or collapse tool and activity details',
  '  "thread.toggleOutline": null, // Toggle the outline for the visible assistant response',
  '  "thread.toggleSidebar": "alt+s", // Show, focus, or hide the thread sidebar',
  '  "threadStatus.toggleVisibility": null // Toggle thread status tab visibility',
  "}",
].join("\n")

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
        yield* output.stdout(keymapText)
        return 0
      }),
    }),
  )

export const executeCommand = Effect.fn("Cli.Config.executeCommand")(function* (command: Args.ConfigCommand) {
  if (command.action === "keymap") {
    yield* Output.stdout(keymapText)
    return 0
  }
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
      ...Settings.entries(snapshot),
    ]
    yield* output.stdout(formatJson({ entries, warnings: snapshot.warnings }))
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
