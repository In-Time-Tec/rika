import { PermissionPolicy, ToolExecutor, ToolRegistry } from "@rika/agent"
import { Config } from "@rika/core"
import { Common } from "@rika/schema"
import { Call, Result } from "@rika/schema/tool"
import { Tool } from "effect/unstable/ai"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { readdir } from "node:fs/promises"
import { basename, join } from "node:path"
import { pathToFileURL } from "node:url"
import * as Api from "./api"
import * as PluginUi from "./plugin-ui"

export interface PluginSource {
  readonly name: string
  readonly path: string
  readonly entrypoint: Api.PluginEntrypoint
}

interface PluginCandidate {
  readonly name: string
  readonly path: string
  readonly entrypoint?: Api.PluginEntrypoint
  readonly error?: string
}

export interface LoadError extends Schema.Schema.Type<typeof LoadError> {}
export const LoadError = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  message: Schema.String,
}).annotate({ identifier: "Rika.Plugin.LoadError" })

export interface LoadReport extends Schema.Schema.Type<typeof LoadReport> {}
export const LoadReport = Schema.Struct({
  loaded: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      path: Schema.String,
    }),
  ),
  errors: Schema.Array(LoadError),
  trust: Schema.Struct({
    model: Schema.Literal("trusted-local"),
    sandboxed: Schema.Boolean,
    description: Schema.String,
  }),
}).annotate({ identifier: "Rika.Plugin.LoadReport" })

export class PluginHostError extends Schema.TaggedErrorClass<PluginHostError>()("PluginHostError", {
  message: Schema.String,
  operation: Schema.String,
  plugin: Schema.optional(Schema.String),
}) {}

export type RunError = PluginHostError | PluginUi.PluginUiError

export interface Interface {
  readonly reload: Effect.Effect<LoadReport, RunError>
  readonly report: Effect.Effect<LoadReport>
  readonly toolDefinitions: Effect.Effect<ReadonlyArray<ToolRegistry.Definition>>
  readonly commands: Effect.Effect<ReadonlyArray<Api.CommandRegistration>>
  readonly modes: Effect.Effect<ReadonlyArray<Api.ModeRegistration>>
  readonly subagents: Effect.Effect<ReadonlyArray<Api.SubagentRegistration>>
  readonly runCommand: (name: string) => Effect.Effect<void, RunError>
  readonly decideToolCall: (call: Call) => Effect.Effect<PermissionPolicy.Decision, RunError>
  readonly decideToolCallOverride: (
    call: Call,
  ) => Effect.Effect<Option.Option<PermissionPolicy.Decision>, RunError>
  readonly hasToolCallHooks: Effect.Effect<boolean>
  readonly observeToolResult: (result: Result) => Effect.Effect<Result, RunError>
  readonly emitSessionStart: (event: Api.SessionStartEvent) => Effect.Effect<void, RunError>
  readonly emitAgentStart: (event: Api.AgentStartEvent) => Effect.Effect<void, RunError>
  readonly emitAgentEnd: (event: Api.AgentEndEvent) => Effect.Effect<ReadonlyArray<Api.AgentContinue>, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/plugin/PluginHost") {}

interface LoadedPlugin {
  readonly name: string
  readonly path: string
}

interface MutableLoadReport {
  readonly loaded: Array<LoadedPlugin>
  readonly errors: Array<LoadError>
  readonly trust: typeof trust
}

interface HandlerRecord<Event, Result = unknown> {
  readonly plugin: Api.PluginSummary
  readonly handler: (event: Event, ctx: Api.PluginContext) => Api.MaybePromise<Result>
}

interface State {
  report: MutableLoadReport
  tools: Array<Api.ToolRegistration>
  commands: Array<Api.CommandRegistrationState>
  modes: Array<Api.ModeRegistration>
  subagents: Array<Api.SubagentRegistration>
  sessionStartHandlers: Array<HandlerRecord<Api.SessionStartEvent, void>>
  agentStartHandlers: Array<HandlerRecord<Api.AgentStartEvent, void>>
  agentEndHandlers: Array<HandlerRecord<Api.AgentEndEvent, Api.AgentContinue | void>>
  toolCallHandlers: Array<HandlerRecord<Api.ToolCallEvent, PermissionPolicy.Decision | void>>
  toolResultHandlers: Array<HandlerRecord<Api.ToolResultEvent, Result | void>>
  logs: Array<string>
}

type CandidateLoader = () => Effect.Effect<ReadonlyArray<PluginCandidate>, RunError>

const trust = {
  model: "trusted-local" as const,
  sandboxed: false,
  description: "MVP plugins are trusted local TypeScript modules. They are not sandboxed.",
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const ui = yield* PluginUi.Service
    return yield* makeService(ui, () =>
      Effect.gen(function* () {
        const values = yield* config.get
        return yield* discoverLocalPlugins(values.workspace_root)
      }),
    )
  }),
)

export const layerFromSources = (sources: ReadonlyArray<PluginSource>) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const ui = yield* PluginUi.Service
      return yield* makeService(ui, () => Effect.succeed(sources.map((source): PluginCandidate => ({ ...source }))))
    }),
  )

export const emptyLayer = layerFromSources([]).pipe(Layer.provide(PluginUi.silentLayer))

export const toolDefinitions = Effect.fn("PluginHost.toolDefinitions.call")(function* () {
  const host = yield* Service
  return yield* host.toolDefinitions
})

export const commands = Effect.fn("PluginHost.commands.call")(function* () {
  const host = yield* Service
  return yield* host.commands
})

export const runCommand = Effect.fn("PluginHost.runCommand.call")(function* (name: string) {
  const host = yield* Service
  return yield* host.runCommand(name)
})

export const permissionPolicyLayer = Layer.effect(
  PermissionPolicy.Service,
  Effect.gen(function* () {
    const host = yield* Service
    return PermissionPolicy.Service.of({
      mode: Effect.gen(function* () {
        const hasToolCallHooks = yield* host.hasToolCallHooks
        return hasToolCallHooks ? "plugin" : "allow-all"
      }),
      decide: Effect.fn("PluginHost.PermissionPolicy.decide")(function* (call: Call) {
        return yield* host.decideToolCall(call).pipe(
          Effect.mapError(
            (error) =>
              new PermissionPolicy.PermissionPolicyError({
                message: error.message,
                details: { plugin_host_operation: "tool.call" },
              }),
          ),
        )
      }),
    })
  }),
)

export const permissionPolicyLayerFromConfig = (
  config: PermissionPolicy.PermissionConfig = PermissionPolicy.defaultConfig,
) =>
  Layer.effect(
    PermissionPolicy.Service,
    Effect.gen(function* () {
      const host = yield* Service
      return PermissionPolicy.Service.of({
        mode: Effect.gen(function* () {
          const hasToolCallHooks = yield* host.hasToolCallHooks
          if (hasToolCallHooks) return "plugin"
          return config.mode
        }),
        decide: Effect.fn("PluginHost.PermissionPolicy.decide.configured")(function* (call: Call) {
          const override = yield* host.decideToolCallOverride(call).pipe(
            Effect.mapError(
              (error) =>
                new PermissionPolicy.PermissionPolicyError({
                  message: error.message,
                  details: { plugin_host_operation: "tool.call" },
                }),
            ),
          )
          if (Option.isSome(override)) return override.value
          return yield* PermissionPolicy.decideFromConfig(config, call)
        }),
      })
    }),
  )

export const toolResultExecutorLayer = Layer.effect(
  ToolExecutor.Service,
  Effect.gen(function* () {
    const host = yield* Service
    const base = yield* ToolExecutor.Service
    return ToolExecutor.Service.of({
      tools: base.tools,
      describe: base.describe,
      execute: Effect.fn("PluginHost.ToolExecutor.execute")(function* (call: Call) {
        const result = yield* base.execute(call)
        return yield* host.observeToolResult(result).pipe(Effect.catch(() => Effect.succeed(result)))
      }),
    })
  }),
)

const makeService = (ui: PluginUi.Interface, loadCandidates: CandidateLoader) =>
  Effect.gen(function* () {
    const state = emptyState()
    const decideToolCallOverride = Effect.fn("PluginHost.decideToolCallOverride")(function* (call: Call) {
      for (const record of state.toolCallHandlers) {
        const result = yield* invokeUnknown(
          () => record.handler({ tool: call.name, call }, contextFor(record.plugin, ui)),
          record.plugin,
          "tool.call",
        )
        if (isPolicyDecision(result)) return Option.some(result)
      }
      return Option.none()
    })
    const service = Service.of({
      reload: reloadState(state, loadCandidates),
      report: Effect.sync(() => state.report),
      toolDefinitions: Effect.sync(() => state.tools.map((registration) => toolDefinition(registration, ui))),
      commands: Effect.sync(() =>
        state.commands.map((command) => ({
          name: command.name,
          descriptor: { ...command.descriptor, availability: command.availability },
        })),
      ),
      modes: Effect.sync(() => [...state.modes]),
      subagents: Effect.sync(() => [...state.subagents]),
      hasToolCallHooks: Effect.sync(() => state.toolCallHandlers.length > 0),
      runCommand: Effect.fn("PluginHost.runCommand")(function* (name: string) {
        const command = state.commands.find((candidate) => candidate.name === name)
        if (command === undefined) {
          return yield* new PluginHostError({ message: `No plugin command named ${name}`, operation: "runCommand" })
        }
        if (command.availability.type === "hidden") {
          return yield* new PluginHostError({ message: `Plugin command ${name} is hidden`, operation: "runCommand" })
        }
        if (command.availability.type === "disabled") {
          return yield* new PluginHostError({
            message: `Plugin command ${name} is disabled: ${command.availability.reason}`,
            operation: "runCommand",
          })
        }
        return yield* invokeVoid(() => command.handler(contextFor(command.plugin, ui)), command.plugin, "runCommand")
      }),
      decideToolCallOverride,
      decideToolCall: Effect.fn("PluginHost.decideToolCall")(function* (call: Call) {
        const override = yield* decideToolCallOverride(call)
        return Option.getOrElse(override, () => PermissionPolicy.allow)
      }),
      observeToolResult: Effect.fn("PluginHost.observeToolResult")(function* (result: Result) {
        let current = result
        for (const record of state.toolResultHandlers) {
          const next = yield* invokeUnknown(
            () => record.handler({ tool: current.name, result: current }, contextFor(record.plugin, ui)),
            record.plugin,
            "tool.result",
          )
          if (isToolResult(next)) current = next
        }
        return current
      }),
      emitSessionStart: emitVoidHandlers(state.sessionStartHandlers, ui, "session.start"),
      emitAgentStart: emitVoidHandlers(state.agentStartHandlers, ui, "agent.start"),
      emitAgentEnd: Effect.fn("PluginHost.emitAgentEnd")(function* (event: Api.AgentEndEvent) {
        const continues: Array<Api.AgentContinue> = []
        for (const record of state.agentEndHandlers) {
          const result = yield* invokeUnknown(
            () => record.handler(event, contextFor(record.plugin, ui)),
            record.plugin,
            "agent.end",
          )
          if (isAgentContinue(result)) continues.push(result)
        }
        return continues
      }),
    })
    yield* service.reload
    return service
  })

const reloadState = (state: State, loadCandidates: CandidateLoader) =>
  Effect.gen(function* () {
    resetState(state)
    const candidates = yield* loadCandidates()
    for (const candidate of candidates) {
      const entrypoint = candidate.entrypoint
      if (candidate.error !== undefined || entrypoint === undefined) {
        state.report.errors.push({
          name: candidate.name,
          path: candidate.path,
          message: candidate.error ?? "Missing plugin entrypoint",
        })
        continue
      }
      const plugin = { name: candidate.name, path: candidate.path }
      const result = yield* invokeVoid(() => entrypoint(apiFor(plugin, state)), plugin, "load").pipe(Effect.result)
      if (result._tag === "Failure") {
        state.report.errors.push({ name: candidate.name, path: candidate.path, message: result.failure.message })
      } else {
        state.report.loaded.push(plugin)
      }
    }
    return state.report
  })

const apiFor = (plugin: Api.PluginSummary, state: State): Api.PluginAPI => {
  const logger = loggerFor(plugin, state)
  function on(event: "session.start", handler: Api.SessionStartHandler): void
  function on(event: "agent.start", handler: Api.AgentStartHandler): void
  function on(event: "agent.end", handler: Api.AgentEndHandler): void
  function on(event: "tool.call", handler: Api.ToolCallHandler): void
  function on(event: "tool.result", handler: Api.ToolResultHandler): void
  function on(event: Api.EventName, handler: unknown): void {
    if (typeof handler !== "function") return
    switch (event) {
      case "session.start":
        state.sessionStartHandlers.push({ plugin, handler: (nextEvent, ctx) => handler(nextEvent, ctx) })
        return
      case "agent.start":
        state.agentStartHandlers.push({ plugin, handler: (nextEvent, ctx) => handler(nextEvent, ctx) })
        return
      case "agent.end":
        state.agentEndHandlers.push({ plugin, handler: (nextEvent, ctx) => handler(nextEvent, ctx) })
        return
      case "tool.call":
        state.toolCallHandlers.push({ plugin, handler: (nextEvent, ctx) => handler(nextEvent, ctx) })
        return
      case "tool.result":
        state.toolResultHandlers.push({ plugin, handler: (nextEvent, ctx) => handler(nextEvent, ctx) })
        return
    }
  }

  return {
    logger,
    on,
    registerTool: (name: string, options: Api.RegisterToolOptions, execute: Api.ToolHandler) => {
      state.tools.push({
        plugin,
        descriptor: {
          name,
          description: options.description,
          ...(options.inputSchema === undefined ? {} : { inputSchema: options.inputSchema }),
        },
        execute,
      })
    },
    registerCommand: (name: string, descriptor: Api.CommandDescriptor, execute: Api.CommandHandler) => {
      const stateCommand: Api.CommandRegistrationState = {
        plugin,
        name,
        descriptor,
        handler: execute,
        availability: descriptor.availability ?? { type: "enabled" },
      }
      state.commands.push(stateCommand)
      return {
        setAvailability: (availability: Api.CommandAvailability) => {
          stateCommand.availability = availability
        },
      }
    },
    registerMode: (mode: Api.ModeRegistration) => {
      state.modes.push(mode)
    },
    registerSubagent: (subagent: Api.SubagentRegistration) => {
      state.subagents.push(subagent)
    },
  }
}

const toolDefinition = (registration: Api.ToolRegistration, ui: PluginUi.Interface): ToolRegistry.Definition => ({
  tool: pluginTool(registration.descriptor),
  execute: Effect.fn(`PluginHost.tool.${registration.descriptor.name}`)(function* (call: Call) {
    const output = yield* invokeUnknown(
      () => registration.execute(call, contextFor(registration.plugin, ui)),
      registration.plugin,
      "tool",
    ).pipe(
      Effect.mapError(
        (error) =>
          new ToolRegistry.ToolRegistryError({
            message: error.message,
            name: call.name,
            retryable: false,
          }),
      ),
    )
    const decoded = Schema.decodeUnknownOption(Common.JsonValue)(output)
    if (decoded._tag === "None") {
      return yield* new ToolRegistry.ToolRegistryError({
        message: `Plugin tool ${call.name} returned a non-JSON value`,
        name: call.name,
        retryable: false,
      })
    }
    return decoded.value
  }),
})

const pluginTool = (descriptor: Api.ToolDescriptor) => {
  if (descriptor.inputSchema === undefined) {
    return Tool.make(descriptor.name, {
      description: descriptor.description,
      parameters: Tool.EmptyParams,
      success: Schema.Json,
      failure: Schema.Json,
      failureMode: "return",
    })
  }
  return Tool.dynamic(descriptor.name, {
    description: descriptor.description,
    parameters: Schema.Json,
    success: Schema.Json,
    failure: Schema.Json,
    failureMode: "return",
  }).annotate(Tool.Strict, false)
}

const emitVoidHandlers = <Event>(
  handlers: Array<HandlerRecord<Event, void>>,
  ui: PluginUi.Interface,
  operation: string,
) =>
  Effect.fn(`PluginHost.${operation}`)(function* (event: Event) {
    for (const record of handlers) {
      yield* invokeUnknown(() => record.handler(event, contextFor(record.plugin, ui)), record.plugin, operation)
    }
  })

const discoverLocalPlugins = (workspaceRoot: string): Effect.Effect<ReadonlyArray<PluginCandidate>, RunError> =>
  Effect.gen(function* () {
    const directory = join(workspaceRoot, ".rika", "plugins")
    const names = yield* Effect.tryPromise({
      try: () => readdir(directory),
      catch: (cause) => cause,
    }).pipe(
      Effect.catchIf(
        (cause) => cause instanceof Error && "code" in cause && cause.code === "ENOENT",
        () => Effect.succeed<ReadonlyArray<string>>([]),
      ),
      Effect.mapError(
        (cause) =>
          new PluginHostError({
            message: cause instanceof Error ? cause.message : String(cause),
            operation: "discover",
          }),
      ),
    )
    const pluginFiles = names.filter((name) => name.endsWith(".ts")).toSorted()
    return yield* Effect.forEach(pluginFiles, (name) => importCandidate(join(directory, name)), { concurrency: 1 })
  })

const importCandidate = (path: string): Effect.Effect<PluginCandidate> =>
  Effect.gen(function* () {
    const imported = yield* Effect.tryPromise({
      try: async (): Promise<unknown> => import(`${pathToFileURL(path).href}?reload=${Date.now()}`),
      catch: (cause) => cause,
    }).pipe(Effect.result)
    if (imported._tag === "Failure") {
      return { name: pluginName(path), path, error: errorMessage(imported.failure) }
    }
    const entrypoint = entrypointFromModule(imported.success)
    if (entrypoint === undefined) {
      return { name: pluginName(path), path, error: "Plugin module must export a default function" }
    }
    return { name: pluginName(path), path, entrypoint }
  })

const entrypointFromModule = (module: unknown): Api.PluginEntrypoint | undefined => {
  if (!isRecord(module)) return undefined
  const entrypoint = module.default
  return typeof entrypoint === "function" ? (api) => entrypoint(api) : undefined
}

const invokeUnknown = (thunk: () => Api.MaybePromise<unknown>, plugin: Api.PluginSummary, operation: string) =>
  Effect.tryPromise({
    try: () => Promise.resolve(thunk()),
    catch: (cause) => new PluginHostError({ message: errorMessage(cause), operation, plugin: plugin.name }),
  })

const invokeVoid = (thunk: () => Api.MaybePromise<unknown>, plugin: Api.PluginSummary, operation: string) =>
  invokeUnknown(thunk, plugin, operation).pipe(Effect.asVoid)

const contextFor = (plugin: Api.PluginSummary, ui: PluginUi.Interface): Api.PluginContext => ({
  plugin,
  logger: { log: () => undefined },
  ui: {
    notify: (message) => Effect.runPromise(ui.notify(message)),
    confirm: (options) => Effect.runPromise(ui.confirm(options)),
    input: (options) => Effect.runPromise(ui.input(options)),
    select: (options) => Effect.runPromise(ui.select(options)),
  },
})

const loggerFor = (plugin: Api.PluginSummary, state: State): Api.Logger => ({
  log: (message: string) => {
    state.logs.push(`[${plugin.name}] ${message}`)
  },
})

const emptyState = (): State => ({
  report: { loaded: [], errors: [], trust },
  tools: [],
  commands: [],
  modes: [],
  subagents: [],
  sessionStartHandlers: [],
  agentStartHandlers: [],
  agentEndHandlers: [],
  toolCallHandlers: [],
  toolResultHandlers: [],
  logs: [],
})

const resetState = (state: State) => {
  state.report = { loaded: [], errors: [], trust }
  state.tools.length = 0
  state.commands.length = 0
  state.modes.length = 0
  state.subagents.length = 0
  state.sessionStartHandlers.length = 0
  state.agentStartHandlers.length = 0
  state.agentEndHandlers.length = 0
  state.toolCallHandlers.length = 0
  state.toolResultHandlers.length = 0
  state.logs.length = 0
}

const isPolicyDecision = (value: unknown): value is PermissionPolicy.Decision => {
  if (!isRecord(value) || typeof value.action !== "string") return false
  return (
    value.action === "allow" ||
    value.action === "reject-and-continue" ||
    value.action === "modify" ||
    value.action === "synthesize"
  )
}

const isToolResult = (value: unknown): value is Result =>
  isRecord(value) && typeof value.name === "string" && (value.status === "success" || value.status === "error")

const isAgentContinue = (value: unknown): value is Api.AgentContinue =>
  isRecord(value) && value.action === "continue" && typeof value.userMessage === "string"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const pluginName = (path: string) => basename(path).replace(/\.ts$/, "")
const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
