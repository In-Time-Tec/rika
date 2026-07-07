import { PermissionPolicy, ToolExecutor, ToolRegistry } from "@rika/agent"
import { Config, Diagnostics } from "@rika/core"
import { ArtifactStore } from "@rika/persistence"
import { Common, Ids } from "@rika/schema"
import { Call, Result } from "@rika/schema/tool"
import { Tool } from "effect/unstable/ai"
import { Context, Effect, Layer, Option, Schema } from "effect"
import type { JsonSchema } from "effect"
import { Buffer } from "node:buffer"
import { readdir, readFile } from "node:fs/promises"
import { basename, join, relative, sep } from "node:path"
import * as Api from "./api"
import * as PluginUi from "./plugin-ui"
import * as SelfExtension from "./self-extension"

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
  readonly logs: Effect.Effect<ReadonlyArray<string>>
  readonly toolDefinitions: Effect.Effect<ReadonlyArray<ToolRegistry.Definition>>
  readonly commands: Effect.Effect<ReadonlyArray<Api.CommandRegistration>>
  readonly modes: Effect.Effect<ReadonlyArray<Api.ModeRegistration>>
  readonly subagents: Effect.Effect<ReadonlyArray<Api.SubagentRegistration>>
  readonly runCommand: (name: string) => Effect.Effect<void, RunError>
  readonly decideToolCall: (call: Call) => Effect.Effect<PermissionPolicy.Decision, RunError>
  readonly decideToolCallOverride: (call: Call) => Effect.Effect<Option.Option<PermissionPolicy.Decision>, RunError>
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
  diagnostics: Option.Option<Diagnostics.Interface>
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
  logEmits: Array<Promise<void>>
}

type CandidateLoader = () => Effect.Effect<ReadonlyArray<PluginCandidate>, RunError>

const trust = {
  model: "trusted-local" as const,
  sandboxed: false,
  description:
    "MVP plugins are trusted local TypeScript modules loaded only when the file hash matches an enabled SelfExtension trust artifact. They are not sandboxed.",
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const ui = yield* PluginUi.Service
    const artifactStore = yield* ArtifactStore.Service
    return yield* makeService(ui, () =>
      Effect.gen(function* () {
        const values = yield* config.get
        return yield* discoverLocalPlugins(
          values.workspace_root,
          Ids.WorkspaceId.make(values.workspace_root),
          artifactStore,
        )
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
      const configService = yield* Effect.serviceOption(Config.Service)
      const values = Option.isSome(configService) ? yield* configService.value.get : undefined
      const options = values === undefined ? {} : { workspace_root: values.workspace_root }
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
          return yield* PermissionPolicy.decideFromConfig(config, call, options)
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
      toolsWithDefinitions: base.toolsWithDefinitions,
      describeWithDefinitions: base.describeWithDefinitions,
      execute: Effect.fn("PluginHost.ToolExecutor.execute")(function* (call: Call) {
        const result = yield* base.execute(call)
        return yield* host.observeToolResult(result).pipe(Effect.catch(() => Effect.succeed(result)))
      }),
      executeWithDefinitions: Effect.fn("PluginHost.ToolExecutor.executeWithDefinitions")(function* (
        call: Call,
        definitions,
      ) {
        const result = yield* base.executeWithDefinitions(call, definitions)
        return yield* host.observeToolResult(result).pipe(Effect.catch(() => Effect.succeed(result)))
      }),
    })
  }),
)

const makeService = (ui: PluginUi.Interface, loadCandidates: CandidateLoader) =>
  Effect.gen(function* () {
    const diagnostics = yield* Effect.serviceOption(Diagnostics.Service)
    const state = emptyState(diagnostics)
    const decideToolCallOverride = Effect.fn("PluginHost.decideToolCallOverride")(function* (call: Call) {
      for (const record of state.toolCallHandlers) {
        const result = yield* invokeUnknown(
          () => record.handler({ tool: call.name, call }, contextFor(record.plugin, state, ui)),
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
      logs: Effect.gen(function* () {
        yield* Effect.promise(() => Promise.all(state.logEmits)).pipe(Effect.asVoid)
        return [...state.logs]
      }),
      toolDefinitions: Effect.sync(() => state.tools.map((registration) => toolDefinition(registration, state, ui))),
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
        return yield* invokeVoid(
          () => command.handler(contextFor(command.plugin, state, ui)),
          command.plugin,
          "runCommand",
        )
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
            () => record.handler({ tool: current.name, result: current }, contextFor(record.plugin, state, ui)),
            record.plugin,
            "tool.result",
          )
          if (isToolResult(next)) current = next
        }
        return current
      }),
      emitSessionStart: emitVoidHandlers(state.sessionStartHandlers, state, ui, "session.start"),
      emitAgentStart: emitVoidHandlers(state.agentStartHandlers, state, ui, "agent.start"),
      emitAgentEnd: Effect.fn("PluginHost.emitAgentEnd")(function* (event: Api.AgentEndEvent) {
        const continues: Array<Api.AgentContinue> = []
        for (const record of state.agentEndHandlers) {
          const result = yield* invokeUnknown(
            () => record.handler(event, contextFor(record.plugin, state, ui)),
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

const toolDefinition = (
  registration: Api.ToolRegistration,
  state: State,
  ui: PluginUi.Interface,
): ToolRegistry.Definition => ({
  tool: pluginTool(registration.descriptor),
  execute: Effect.fn(`PluginHost.tool.${registration.descriptor.name}`)(function* (call: Call) {
    const inputError = validateToolInput(registration.descriptor, call.input)
    if (inputError !== undefined) {
      return yield* new ToolRegistry.ToolRegistryError({
        message: inputError,
        name: call.name,
        retryable: false,
      })
    }
    const output = yield* invokeUnknown(
      () => registration.execute(call, contextFor(registration.plugin, state, ui)),
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
    parameters: jsonSchemaParameters(descriptor.inputSchema),
    success: Schema.Json,
    failure: Schema.Json,
    failureMode: "return",
  }).annotate(Tool.Strict, false)
}

const jsonSchemaParameters = (value: Common.JsonValue): JsonSchema.JsonSchema => (isRecord(value) ? { ...value } : {})

const validateToolInput = (descriptor: Api.ToolDescriptor, input: Common.JsonValue): string | undefined => {
  if (descriptor.inputSchema === undefined) return undefined
  const reason = validateJsonSchema(descriptor.inputSchema, input, "$")
  return reason === undefined
    ? undefined
    : `Plugin tool ${descriptor.name} input does not match declared schema: ${reason}`
}

const validateJsonSchema = (schemaValue: unknown, value: unknown, path: string): string | undefined => {
  if (!isRecord(schemaValue)) return undefined
  const schema = schemaValue

  const allOf = schema.allOf
  if (Array.isArray(allOf)) {
    for (const candidate of allOf) {
      const error = validateJsonSchema(candidate, value, path)
      if (error !== undefined) return error
    }
  }

  const anyOf = schema.anyOf
  if (Array.isArray(anyOf) && !anyOf.some((candidate) => validateJsonSchema(candidate, value, path) === undefined)) {
    return `${path} must match at least one allowed schema`
  }

  const oneOf = schema.oneOf
  if (Array.isArray(oneOf)) {
    const matches = oneOf.filter((candidate) => validateJsonSchema(candidate, value, path) === undefined).length
    if (matches !== 1) return `${path} must match exactly one allowed schema`
  }

  if ("const" in schema && !jsonEqual(value, schema.const)) return `${path} must equal ${JSON.stringify(schema.const)}`

  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => jsonEqual(value, candidate))) {
    return `${path} must be one of the declared enum values`
  }

  const typeError = validateJsonType(schema.type, value, path)
  if (typeError !== undefined) return typeError

  if (isRecord(value)) {
    const required = stringArray(schema.required)
    for (const key of required) {
      if (!(key in value)) return `${path}.${key} is required`
    }

    const properties = recordValue(schema.properties)
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (key in value) {
        const error = validateJsonSchema(propertySchema, value[key], `${path}.${key}`)
        if (error !== undefined) return error
      }
    }

    const additionalProperties = schema.additionalProperties
    if (additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) return `${path}.${key} is not allowed`
      }
    } else if (isRecord(additionalProperties)) {
      for (const [key, propertyValue] of Object.entries(value)) {
        if (key in properties) continue
        const error = validateJsonSchema(additionalProperties, propertyValue, `${path}.${key}`)
        if (error !== undefined) return error
      }
    }
  }

  if (Array.isArray(value)) {
    const minItems = numberValue(schema.minItems)
    if (minItems !== undefined && value.length < minItems) return `${path} must have at least ${minItems} items`
    const maxItems = numberValue(schema.maxItems)
    if (maxItems !== undefined && value.length > maxItems) return `${path} must have at most ${maxItems} items`
    if (isRecord(schema.items)) {
      for (let index = 0; index < value.length; index += 1) {
        const error = validateJsonSchema(schema.items, value[index], `${path}[${index}]`)
        if (error !== undefined) return error
      }
    }
  }

  if (typeof value === "string") {
    const minLength = numberValue(schema.minLength)
    if (minLength !== undefined && value.length < minLength) return `${path} must have length at least ${minLength}`
    const maxLength = numberValue(schema.maxLength)
    if (maxLength !== undefined && value.length > maxLength) return `${path} must have length at most ${maxLength}`
    const patternError = validatePattern(schema.pattern, value, path)
    if (patternError !== undefined) return patternError
  }

  if (typeof value === "number") {
    const minimum = numberValue(schema.minimum)
    if (minimum !== undefined && value < minimum) return `${path} must be at least ${minimum}`
    const maximum = numberValue(schema.maximum)
    if (maximum !== undefined && value > maximum) return `${path} must be at most ${maximum}`
  }

  return undefined
}

const validateJsonType = (schemaType: unknown, value: unknown, path: string): string | undefined => {
  const allowedTypes = typeof schemaType === "string" ? [schemaType] : stringArray(schemaType)
  if (allowedTypes.length === 0) return undefined
  return allowedTypes.some((type) => matchesJsonType(type, value))
    ? undefined
    : `${path} must be ${allowedTypes.join(" or ")}`
}

const matchesJsonType = (type: string, value: unknown) => {
  switch (type) {
    case "array":
      return Array.isArray(value)
    case "boolean":
      return typeof value === "boolean"
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
    case "null":
      return value === null
    case "number":
      return typeof value === "number"
    case "object":
      return isRecord(value)
    case "string":
      return typeof value === "string"
    default:
      return false
  }
}

const stringArray = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []

const numberValue = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined)

const recordValue = (value: unknown): Readonly<Record<string, unknown>> => (isRecord(value) ? value : {})

const validatePattern = (pattern: unknown, value: string, path: string): string | undefined => {
  if (typeof pattern !== "string") return undefined
  try {
    return new RegExp(pattern).test(value) ? undefined : `${path} must match pattern ${pattern}`
  } catch {
    return `${path} declares an invalid string pattern`
  }
}

const jsonEqual = (left: unknown, right: unknown): boolean => {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => jsonEqual(item, right[index]))
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).toSorted()
    const rightKeys = Object.keys(right).toSorted()
    return jsonEqual(leftKeys, rightKeys) && leftKeys.every((key) => jsonEqual(left[key], right[key]))
  }
  return false
}

const emitVoidHandlers = <Event>(
  handlers: Array<HandlerRecord<Event, void>>,
  state: State,
  ui: PluginUi.Interface,
  operation: string,
) =>
  Effect.fn(`PluginHost.${operation}`)(function* (event: Event) {
    for (const record of handlers) {
      yield* invokeUnknown(() => record.handler(event, contextFor(record.plugin, state, ui)), record.plugin, operation)
    }
  })

const discoverLocalPlugins = (
  workspaceRoot: string,
  workspaceId: Ids.WorkspaceId,
  artifactStore: ArtifactStore.Interface,
): Effect.Effect<ReadonlyArray<PluginCandidate>, RunError> =>
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
    const trustRecords = yield* pluginTrustRecords(artifactStore, workspaceId)
    return yield* Effect.forEach(
      pluginFiles,
      (name) => trustedImportCandidate(workspaceRoot, workspaceId, join(directory, name), trustRecords),
      { concurrency: 1 },
    )
  })

interface PluginTrustRecord {
  readonly created_at: Common.TimestampMillis
  readonly change: SelfExtension.ExtensionChange
}

type TrustLookup =
  | { readonly _tag: "missing" }
  | { readonly _tag: "ambiguous"; readonly created_at: Common.TimestampMillis }
  | { readonly _tag: "record"; readonly record: PluginTrustRecord }

const pluginTrustRecords = (
  artifactStore: ArtifactStore.Interface,
  workspaceId: Ids.WorkspaceId,
): Effect.Effect<ReadonlyArray<PluginTrustRecord>, RunError> =>
  artifactStore.listAll({ workspace_id: workspaceId, kind: "other", limit: 5_000 }).pipe(
    Effect.map((artifacts) =>
      artifacts.flatMap((artifact) => {
        const decoded = Schema.decodeUnknownOption(SelfExtension.ExtensionChange)(artifact.content)
        if (Option.isNone(decoded) || decoded.value.kind !== "plugin") return []
        return [{ created_at: artifact.created_at, change: decoded.value }]
      }),
    ),
    Effect.mapError(
      (cause) =>
        new PluginHostError({
          message: cause.message,
          operation: "discover.trust",
        }),
    ),
  )

const trustedImportCandidate = (
  workspaceRoot: string,
  workspaceId: Ids.WorkspaceId,
  path: string,
  trustRecords: ReadonlyArray<PluginTrustRecord>,
): Effect.Effect<PluginCandidate> =>
  Effect.gen(function* () {
    const source = yield* trustedPluginSource(workspaceRoot, workspaceId, path, trustRecords).pipe(Effect.result)
    if (source._tag === "Failure") return { name: pluginName(path), path, error: source.failure.message }
    return yield* importCandidate(path, source.success)
  })

const trustedPluginSource = (
  workspaceRoot: string,
  workspaceId: Ids.WorkspaceId,
  path: string,
  trustRecords: ReadonlyArray<PluginTrustRecord>,
): Effect.Effect<string, PluginHostError> =>
  Effect.gen(function* () {
    const trustRecord = latestTrustRecord(workspaceRoot, workspaceId, path, trustRecords)
    if (trustRecord._tag === "missing") {
      return yield* trustError(path, "Plugin file has no enabled SelfExtension trust record")
    }
    if (trustRecord._tag === "ambiguous") {
      return yield* trustError(path, "Plugin has multiple latest SelfExtension trust records with the same timestamp")
    }
    const change = trustRecord.record.change
    if (change.action !== "enable-plugin" || !change.enabled || !change.trust.enabled) {
      return yield* trustError(path, "Plugin is not currently enabled by SelfExtension")
    }
    if (change.trust.verification.status !== "passed") {
      return yield* trustError(path, "Plugin trust record does not have a passed verification")
    }
    if (change.trust.content_hash === undefined) {
      return yield* trustError(path, "Plugin trust record is missing a content hash")
    }
    const source = yield* readPluginSource(path)
    const actualHash = SelfExtension.contentHash(source)
    if (actualHash !== change.trust.content_hash) {
      return yield* trustError(path, "Plugin content hash does not match the enabled SelfExtension trust record")
    }
    return source
  })

const latestTrustRecord = (
  workspaceRoot: string,
  workspaceId: Ids.WorkspaceId,
  path: string,
  trustRecords: ReadonlyArray<PluginTrustRecord>,
): TrustLookup => {
  const name = pluginName(path)
  const pluginPath = relativePluginPath(workspaceRoot, path)
  const matching = trustRecords.filter(
    (record) =>
      record.change.workspace_id === workspaceId &&
      record.change.name === name &&
      record.change.files.some((file) => file.path === pluginPath),
  )
  if (matching.length === 0) return { _tag: "missing" }
  const latest = matching.reduce((current, record) => (record.created_at > current.created_at ? record : current))
  const latestRecords = matching.filter((record) => record.created_at === latest.created_at)
  if (latestRecords.length > 1) return { _tag: "ambiguous", created_at: latest.created_at }
  return { _tag: "record", record: latest }
}

const readPluginSource = (path: string): Effect.Effect<string, PluginHostError> =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) =>
      new PluginHostError({
        message: cause instanceof Error ? cause.message : String(cause),
        operation: "trust.read",
        plugin: pluginName(path),
      }),
  })

const trustError = (path: string, message: string) =>
  new PluginHostError({ message, operation: "trust", plugin: pluginName(path) })

const importCandidate = (path: string, source: string): Effect.Effect<PluginCandidate> =>
  Effect.gen(function* () {
    const imported = yield* Effect.tryPromise({
      try: async (): Promise<unknown> => import(/* @vite-ignore */ moduleUrl(source)),
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

const contextFor = (plugin: Api.PluginSummary, state: State, ui: PluginUi.Interface): Api.PluginContext => ({
  plugin,
  logger: loggerFor(plugin, state),
  ui: {
    notify: (message) => Effect.runPromise(ui.notify(message)),
    confirm: (options) => Effect.runPromise(ui.confirm(options)),
    input: (options) => Effect.runPromise(ui.input(options)),
    select: (options) => Effect.runPromise(ui.select(options)),
  },
})

const moduleUrl = (source: string) =>
  `data:text/javascript;reload=${Date.now()};base64,${Buffer.from(new Bun.Transpiler({ loader: "ts" }).transformSync(source)).toString("base64")}`

const loggerFor = (plugin: Api.PluginSummary, state: State): Api.Logger => ({
  log: (message: string) => {
    state.logs.push(`[${plugin.name}] ${message}`)
    if (Option.isSome(state.diagnostics)) {
      const entry: Diagnostics.Entry = {
        level: "info",
        message: "plugin.log",
        data: {
          op: "plugin.log",
          plugin_name: plugin.name,
          plugin_path: plugin.path,
          plugin_message: message,
        },
      }
      state.logEmits.push(Effect.runPromise(state.diagnostics.value.emit(entry)).catch(() => undefined))
    }
  },
})

const emptyState = (diagnostics: Option.Option<Diagnostics.Interface>): State => ({
  diagnostics,
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
  logEmits: [],
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
  state.logEmits.length = 0
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
const relativePluginPath = (workspaceRoot: string, path: string) => relative(workspaceRoot, path).split(sep).join("/")
const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
