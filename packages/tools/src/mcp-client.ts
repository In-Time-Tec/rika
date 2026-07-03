import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { ToolRegistry } from "@rika/agent"
import { Config } from "@rika/core"
import { Database, McpApprovalStore } from "@rika/persistence"
import { Common } from "@rika/schema"
import type { Call } from "@rika/schema/tool"
import { Context, Effect, JsonSchema, Layer, Option, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

const rikaSettingsKey = "rika.mcpServers"
const legacySettingsKey = "mcpServers"
export const settingsKey = rikaSettingsKey

const StringRecord = Schema.Record(Schema.String, Schema.String)

export interface CommandServerConfig extends Schema.Schema.Type<typeof CommandServerConfig> {}
export const CommandServerConfig = Schema.Struct({
  command: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(StringRecord),
  cwd: Schema.optional(Schema.String),
  includeTools: Schema.optional(Schema.Array(Schema.String)),
  excludeTools: Schema.optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "Rika.Tools.McpClient.CommandServerConfig" })

export interface RemoteServerConfig extends Schema.Schema.Type<typeof RemoteServerConfig> {}
export const RemoteServerConfig = Schema.Struct({
  url: Schema.String,
  headers: Schema.optional(StringRecord),
  includeTools: Schema.optional(Schema.Array(Schema.String)),
  excludeTools: Schema.optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "Rika.Tools.McpClient.RemoteServerConfig" })

export type ServerConfig = CommandServerConfig | RemoteServerConfig
export const ServerConfig = Schema.Union([CommandServerConfig, RemoteServerConfig]).annotate({
  identifier: "Rika.Tools.McpClient.ServerConfig",
})

export const ServerSource = Schema.Literals(["user", "workspace"]).annotate({
  identifier: "Rika.Tools.McpClient.ServerSource",
})
export type ServerSource = typeof ServerSource.Type

export const ServerKind = Schema.Literals(["command", "remote"]).annotate({
  identifier: "Rika.Tools.McpClient.ServerKind",
})
export type ServerKind = typeof ServerKind.Type

export const ServerStatus = Schema.Literals(["ready", "approval_required"]).annotate({
  identifier: "Rika.Tools.McpClient.ServerStatus",
})
export type ServerStatus = typeof ServerStatus.Type

export interface ServerSummary extends Schema.Schema.Type<typeof ServerSummary> {}
export const ServerSummary = Schema.Struct({
  name: Schema.String,
  source: ServerSource,
  kind: ServerKind,
  status: ServerStatus,
  fingerprint: Schema.String,
  reason: Schema.optional(Schema.String),
}).annotate({ identifier: "Rika.Tools.McpClient.ServerSummary" })

export interface SettingsSource {
  readonly source: ServerSource
  readonly path: string
  readonly servers: Readonly<Record<string, ServerConfig>>
}

export class McpClientError extends Schema.TaggedErrorClass<McpClientError>()("McpClientError", {
  message: Schema.String,
  operation: Schema.String,
  server_name: Schema.optional(Schema.String),
  tool_name: Schema.optional(Schema.String),
  details: Schema.optional(Common.JsonValue),
}) {}

export type RunError = Database.DatabaseError | McpClientError | McpApprovalStore.McpApprovalStoreError

export interface Interface {
  readonly servers: Effect.Effect<ReadonlyArray<ServerSummary>, RunError>
  readonly approve: (serverName: string) => Effect.Effect<McpApprovalStore.Approval, RunError>
  readonly toolDefinitions: Effect.Effect<ReadonlyArray<ToolRegistry.Definition>, RunError>
  readonly callTool: (
    serverName: string,
    toolName: string,
    input: Common.JsonValue,
  ) => Effect.Effect<Common.JsonValue, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/tools/McpClient") {}

export interface RemoteTool {
  readonly name: string
  readonly description?: string
  readonly inputSchema?: JsonSchema.JsonSchema
}

export interface Connection {
  readonly listTools: Effect.Effect<ReadonlyArray<RemoteTool>, McpClientError>
  readonly callTool: (name: string, input: Common.JsonValue) => Effect.Effect<Common.JsonValue, McpClientError>
  readonly close: Effect.Effect<void>
}

export type Connector = (server: ConfiguredServer) => Effect.Effect<Connection, McpClientError>

export type SettingsLoader = (config: Config.Values) => Effect.Effect<ReadonlyArray<SettingsSource>, McpClientError>

export interface ConfiguredServer {
  readonly name: string
  readonly source: ServerSource
  readonly path: string
  readonly workspace_root: string
  readonly config: ServerConfig
  readonly fingerprint: string
}

export const layerFromSources = (sources: ReadonlyArray<SettingsSource>, connector: Connector) =>
  layerWith(() => Effect.succeed(sources), connector)

export const emptyLayer = Layer.succeed(
  Service,
  Service.of({
    servers: Effect.succeed([]),
    approve: (serverName: string) =>
      Effect.fail(
        new McpClientError({
          message: `No MCP server named ${serverName}`,
          operation: "approve",
          server_name: serverName,
        }),
      ),
    toolDefinitions: Effect.succeed([]),
    callTool: (serverName: string, toolName: string) =>
      Effect.fail(
        new McpClientError({
          message: `No MCP tool named ${serverName}/${toolName}`,
          operation: "callTool",
          server_name: serverName,
          tool_name: toolName,
        }),
      ),
  }),
)

export const servers = Effect.fn("McpClient.servers.call")(function* () {
  const service = yield* Service
  return yield* service.servers
})

export const approve = Effect.fn("McpClient.approve.call")(function* (serverName: string) {
  const service = yield* Service
  return yield* service.approve(serverName)
})

export const toolDefinitions = Effect.fn("McpClient.toolDefinitions.call")(function* () {
  const service = yield* Service
  return yield* service.toolDefinitions
})

export const callTool = Effect.fn("McpClient.callTool.call")(function* (
  serverName: string,
  toolName: string,
  input: Common.JsonValue,
) {
  const service = yield* Service
  return yield* service.callTool(serverName, toolName, input)
})

export const workspaceSettingsPath = (workspaceRoot: string) => join(workspaceRoot, ".rika", "settings.json")

export const readWorkspaceSettingsSource = (workspaceRoot: string) =>
  readSettingsFile(workspaceSettingsPath(workspaceRoot), "workspace")

export const configuredServersFromSources = (
  sources: ReadonlyArray<SettingsSource>,
  workspaceRoot: string,
): ReadonlyArray<ConfiguredServer> => mergeSources(sources, workspaceRoot)

export const approvalInputForServer = (server: ConfiguredServer): McpApprovalStore.ApprovalInput =>
  approvalInput(server)

export const serverConfigKind = (config: ServerConfig): ServerKind => serverKind(config)

export const fingerprintServerConfig = (config: ServerConfig): string => fingerprintServer(config)

const layerWith = (loadSettings: SettingsLoader, connector: Connector) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service
      const approvals = yield* McpApprovalStore.Service
      const values = yield* config.get
      return makeService(values, approvals, loadSettings, connector)
    }),
  )

const makeService = (
  values: Config.Values,
  approvals: McpApprovalStore.Interface,
  loadSettings: SettingsLoader,
  connector: Connector,
) =>
  Service.of({
    servers: Effect.gen(function* () {
      const configured = yield* configuredServers(values, loadSettings)
      return yield* Effect.forEach(configured, (server) => summarizeServer(server, approvals), { concurrency: 1 })
    }),
    approve: Effect.fn("McpClient.approve")(function* (serverName: string) {
      const configured = yield* configuredServers(values, loadSettings)
      const server = configured.find((candidate) => candidate.name === serverName)
      if (server === undefined) {
        return yield* new McpClientError({
          message: `No MCP server named ${serverName}`,
          operation: "approve",
          server_name: serverName,
        })
      }
      if (server.source !== "workspace" || serverKind(server.config) !== "command") {
        return yield* new McpClientError({
          message: `MCP server ${serverName} does not require workspace command approval`,
          operation: "approve",
          server_name: serverName,
        })
      }
      return yield* approvals.approve(approvalInput(server)).pipe(Effect.mapError((error) => error as RunError))
    }),
    toolDefinitions: Effect.gen(function* () {
      const configured = yield* configuredServers(values, loadSettings)
      const allowed = yield* Effect.forEach(configured, (server) => isRunnable(server, approvals), { concurrency: 1 })
      const runnable = configured.filter((_server, index) => allowed[index] === true)
      const nested = yield* Effect.forEach(
        runnable,
        (server) => definitionsForServer(server, connector).pipe(Effect.catch(() => Effect.succeed([]))),
        { concurrency: 1 },
      )
      return nested.flat()
    }),
    callTool: Effect.fn("McpClient.callTool")(function* (
      serverName: string,
      toolName: string,
      input: Common.JsonValue,
    ) {
      const configured = yield* configuredServers(values, loadSettings)
      const server = configured.find((candidate) => candidate.name === serverName)
      if (server === undefined) {
        return yield* new McpClientError({
          message: `No MCP server named ${serverName}`,
          operation: "callTool",
          server_name: serverName,
          tool_name: toolName,
        })
      }
      const runnable = yield* isRunnable(server, approvals)
      if (!runnable) {
        return yield* new McpClientError({
          message: `Workspace MCP server ${serverName} must be approved before it can run`,
          operation: "callTool",
          server_name: serverName,
          tool_name: toolName,
        })
      }
      return yield* withConnection(connector, server, (connection) => connection.callTool(toolName, input))
    }),
  })

const configuredServers = (values: Config.Values, loadSettings: SettingsLoader) =>
  Effect.gen(function* () {
    const sources = yield* loadSettings(values)
    return mergeSources(sources, values.workspace_root)
  })

const summarizeServer = (server: ConfiguredServer, approvals: McpApprovalStore.Interface) =>
  Effect.gen(function* () {
    const kind = serverKind(server.config)
    const approved =
      kind === "command" && server.source === "workspace" ? yield* approvals.isApproved(approvalInput(server)) : true
    return {
      name: server.name,
      source: server.source,
      kind,
      status: approved ? "ready" : "approval_required",
      fingerprint: server.fingerprint,
      ...(approved ? {} : { reason: "Workspace command MCP servers must be approved before they execute." }),
    } satisfies ServerSummary
  }).pipe(Effect.mapError((error) => error as RunError))

const isRunnable = (server: ConfiguredServer, approvals: McpApprovalStore.Interface) =>
  server.source === "workspace" && serverKind(server.config) === "command"
    ? approvals.isApproved(approvalInput(server)).pipe(Effect.mapError((error) => error as RunError))
    : Effect.succeed(true)

const definitionsForServer = (server: ConfiguredServer, connector: Connector) =>
  withConnection(connector, server, (connection) => connection.listTools).pipe(
    Effect.map((tools) =>
      tools
        .filter((tool) => toolAllowed(server.config, tool.name))
        .map((tool) => toolDefinition(server, tool, connector)),
    ),
  )

const toolDefinition = (server: ConfiguredServer, tool: RemoteTool, connector: Connector): ToolRegistry.Definition => ({
  tool: remoteToolDefinition(server, tool),
  execute: Effect.fn(`McpClient.tool.${server.name}.${tool.name}`)(function* (call: Call) {
    return yield* withConnection(connector, server, (connection) => connection.callTool(tool.name, call.input)).pipe(
      Effect.mapError(
        (error) =>
          new ToolRegistry.ToolRegistryError({
            message: error.message,
            name: call.name,
            retryable: false,
            details: error.details,
          }),
      ),
    )
  }),
})

const remoteToolDefinition = (server: ConfiguredServer, tool: RemoteTool) => {
  const name = rikaToolName(server.name, tool.name)
  const description = `[MCP:${server.name}] ${tool.description ?? tool.name}`
  if (tool.inputSchema === undefined) {
    return Tool.make(name, {
      description,
      parameters: Tool.EmptyParams,
      success: Schema.Json,
      failure: Schema.Json,
      failureMode: "return",
    })
  }
  return Tool.dynamic(name, {
    description,
    parameters: tool.inputSchema,
    success: Schema.Json,
    failure: Schema.Json,
    failureMode: "return",
  }).annotate(Tool.Strict, false)
}

const withConnection = <A>(
  connector: Connector,
  server: ConfiguredServer,
  use: (connection: Connection) => Effect.Effect<A, McpClientError>,
) => Effect.acquireUseRelease(connector(server), use, (connection) => connection.close.pipe(Effect.ignore))

const liveConnector: Connector = (server) =>
  Effect.tryPromise({
    try: async () => {
      const client = new Client({ name: "rika", version: "0.0.0" })
      await client.connect(makeTransport(server))
      return {
        listTools: Effect.tryPromise({
          try: async () => {
            const listed = await client.listTools()
            return listed.tools.map(sdkToolToRemoteTool)
          },
          catch: (cause) => toClientError(cause, "listTools", server.name),
        }),
        callTool: (name: string, input: Common.JsonValue) =>
          Effect.tryPromise({
            try: async () => {
              const result = await client.callTool({ name, arguments: inputToArguments(input) })
              if (result.isError === true) {
                throw new McpClientError({
                  message: `MCP tool ${server.name}/${name} reported an error`,
                  operation: "callTool",
                  server_name: server.name,
                  tool_name: name,
                  details: toJsonValue({ content: result.content }),
                })
              }
              return toJsonValue({
                content: result.content,
                ...(result.structuredContent === undefined ? {} : { structured_content: result.structuredContent }),
              })
            },
            catch: (cause) => toClientError(cause, "callTool", server.name, name),
          }),
        close: Effect.promise(() => client.close()).pipe(Effect.ignore),
      }
    },
    catch: (cause) => toClientError(cause, "connect", server.name),
  })

const makeTransport = (server: ConfiguredServer) => {
  if (isCommandServerConfig(server.config)) {
    return new StdioClientTransport({
      command: server.config.command,
      stderr: "pipe",
      cwd: server.config.cwd ?? server.workspace_root,
      ...(server.config.args === undefined ? {} : { args: [...server.config.args] }),
      ...(server.config.env === undefined ? {} : { env: { ...server.config.env } }),
    })
  }
  const url = new URL(server.config.url)
  if (server.config.headers === undefined) return new StreamableHTTPClientTransport(url)
  return new StreamableHTTPClientTransport(url, { requestInit: { headers: { ...server.config.headers } } })
}

const sdkToolToRemoteTool = (tool: {
  readonly name: string
  readonly description?: string | undefined
  readonly inputSchema: JsonSchema.JsonSchema
}): RemoteTool => ({
  name: tool.name,
  ...(tool.description === undefined ? {} : { description: tool.description }),
  inputSchema: tool.inputSchema,
})

const liveSettingsLoader: SettingsLoader = (config) =>
  Effect.gen(function* () {
    const home = process.env.HOME
    const sources = yield* Effect.all(
      [
        home === undefined
          ? Effect.succeed(undefined)
          : readSettingsFile(join(home, ".config", "rika", "settings.json"), "user"),
        readSettingsFile(workspaceSettingsPath(config.workspace_root), "workspace"),
      ],
      { concurrency: 1 },
    )
    return sources.filter((source): source is SettingsSource => source !== undefined)
  })

export const layer = layerWith(liveSettingsLoader, liveConnector)

const SettingsFile = Schema.Struct({
  [rikaSettingsKey]: Schema.optional(Schema.Record(Schema.String, ServerConfig)),
  [legacySettingsKey]: Schema.optional(Schema.Record(Schema.String, ServerConfig)),
})

const readSettingsFile = (path: string, source: ServerSource) =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) => cause,
  }).pipe(
    Effect.matchEffect({
      onFailure: (cause) =>
        isNotFoundError(cause)
          ? Effect.succeed(undefined)
          : Effect.fail(new McpClientError({ message: errorMessage(cause), operation: "readSettings" })),
      onSuccess: (content) => decodeSettingsFile(path, source, content).pipe(Effect.map((settings) => settings)),
    }),
  )

const decodeSettingsFile = (path: string, source: ServerSource, content: string) =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => JSON.parse(content) as unknown,
      catch: (cause) => new McpClientError({ message: errorMessage(cause), operation: "parseSettings" }),
    })
    const decoded = Schema.decodeUnknownOption(SettingsFile)(parsed)
    if (Option.isNone(decoded)) {
      return yield* new McpClientError({ message: `Invalid MCP settings in ${path}`, operation: "decodeSettings" })
    }
    return {
      source,
      path,
      servers: decoded.value[rikaSettingsKey] ?? decoded.value[legacySettingsKey] ?? {},
    } satisfies SettingsSource
  })

const mergeSources = (
  sources: ReadonlyArray<SettingsSource>,
  workspaceRoot: string,
): ReadonlyArray<ConfiguredServer> => {
  const merged = new Map<string, ConfiguredServer>()
  for (const source of sources) {
    for (const [name, config] of Object.entries(source.servers)) {
      merged.set(name, {
        name,
        source: source.source,
        path: source.path,
        workspace_root: workspaceRoot,
        config,
        fingerprint: fingerprintServer(config),
      })
    }
  }
  return [...merged.values()].toSorted((left, right) => left.name.localeCompare(right.name))
}

const approvalInput = (server: ConfiguredServer): McpApprovalStore.ApprovalInput => ({
  workspace_root: server.workspace_root,
  server_name: server.name,
  fingerprint: server.fingerprint,
})

const serverKind = (config: ServerConfig): ServerKind => (isCommandServerConfig(config) ? "command" : "remote")
const isCommandServerConfig = (config: ServerConfig): config is CommandServerConfig => "command" in config

const rikaToolName = (serverName: string, toolName: string) => `mcp.${serverName}.${toolName}`

const toolAllowed = (config: ServerConfig, name: string) => {
  const include = config.includeTools ?? ["*"]
  const exclude = config.excludeTools ?? []
  return include.some((pattern) => matchGlob(pattern, name)) && !exclude.some((pattern) => matchGlob(pattern, name))
}

const matchGlob = (pattern: string, value: string) => {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")
  return new RegExp(`^${escaped}$`).test(value)
}

const inputToArguments = (input: Common.JsonValue) => (isRecord(input) ? input : {})

const toJsonValue = (value: unknown): Common.JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return value
  if (Array.isArray(value)) return value.map(toJsonValue)
  if (isUnknownRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toJsonValue(entry)]))
  }
  return null
}

const fingerprintServer = (config: ServerConfig) => createHash("sha256").update(stableJson(config)).digest("hex")

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

const toClientError = (cause: unknown, operation: string, serverName: string, toolName?: string) => {
  if (cause instanceof McpClientError) return cause
  return new McpClientError({
    message: errorMessage(cause),
    operation,
    server_name: serverName,
    ...(toolName === undefined ? {} : { tool_name: toolName }),
  })
}

const isRecord = (value: unknown): value is Record<string, Common.JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isUnknownRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isNotFoundError = (cause: unknown) => cause instanceof Error && "code" in cause && cause.code === "ENOENT"
const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
