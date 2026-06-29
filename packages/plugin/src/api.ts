import type { PermissionPolicy } from "@rika/agent"
import type { Config } from "@rika/core"
import type { Common, Tool } from "@rika/schema"

export type MaybePromise<A> = A | Promise<A>

export interface Logger {
  readonly log: (message: string) => void
}

export interface PluginUiContext {
  readonly notify: (message: string) => Promise<void>
  readonly confirm: (options: ConfirmOptions) => Promise<boolean>
  readonly input: (options: InputOptions) => Promise<string | undefined>
  readonly select: (options: SelectOptions) => Promise<string | undefined>
}

export interface ConfirmOptions {
  readonly title: string
  readonly message?: string
  readonly confirmButtonText?: string
}

export interface InputOptions {
  readonly title: string
  readonly placeholder?: string
}

export interface SelectOptions {
  readonly title: string
  readonly options: ReadonlyArray<string>
}

export interface PluginContext {
  readonly plugin: PluginSummary
  readonly ui: PluginUiContext
  readonly logger: Logger
}

export interface PluginSummary {
  readonly name: string
  readonly path: string
}

export interface SessionStartEvent {
  readonly thread: {
    readonly id: string
  }
}

export interface AgentStartEvent {
  readonly thread_id: string
  readonly turn_id: string
  readonly message: string
}

export interface AgentEndEvent {
  readonly thread_id: string
  readonly turn_id: string
  readonly message: string
}

export interface AgentContinue {
  readonly action: "continue"
  readonly userMessage: string
}

export interface ToolCallEvent {
  readonly tool: string
  readonly call: Tool.Call
}

export interface ToolResultEvent {
  readonly tool: string
  readonly result: Tool.Result
}

export type SessionStartHandler = (event: SessionStartEvent, ctx: PluginContext) => MaybePromise<void>
export type AgentStartHandler = (event: AgentStartEvent, ctx: PluginContext) => MaybePromise<void>
export type AgentEndHandler = (event: AgentEndEvent, ctx: PluginContext) => MaybePromise<AgentContinue | void>
export type ToolCallHandler = (
  event: ToolCallEvent,
  ctx: PluginContext,
) => MaybePromise<PermissionPolicy.Decision | void>
export type ToolResultHandler = (event: ToolResultEvent, ctx: PluginContext) => MaybePromise<Tool.Result | void>

export type EventName = "session.start" | "agent.start" | "agent.end" | "tool.call" | "tool.result"
export type EventHandler =
  | SessionStartHandler
  | AgentStartHandler
  | AgentEndHandler
  | ToolCallHandler
  | ToolResultHandler

export interface RegisterToolOptions {
  readonly description: string
  readonly inputSchema?: Common.JsonValue
}

export type ToolHandler = (call: Tool.Call, ctx: PluginContext) => MaybePromise<Common.JsonValue>

export interface CommandDescriptor {
  readonly title: string
  readonly category?: string
  readonly description?: string
  readonly availability?: CommandAvailability
}

export type CommandAvailability =
  | { readonly type: "enabled" }
  | { readonly type: "disabled"; readonly reason: string }
  | { readonly type: "hidden" }

export interface CommandRegistration {
  readonly name: string
  readonly descriptor: CommandDescriptor
}

export interface CommandSubscription {
  readonly setAvailability: (availability: CommandAvailability) => void
}

export type CommandHandler = (ctx: PluginContext) => MaybePromise<void>

export interface ModeRegistration {
  readonly name: Config.Mode
  readonly description: string
}

export interface SubagentRegistration {
  readonly name: string
  readonly description: string
  readonly prompt: string
}

export interface PluginAPI {
  readonly logger: Logger
  readonly on: {
    (event: "session.start", handler: SessionStartHandler): void
    (event: "agent.start", handler: AgentStartHandler): void
    (event: "agent.end", handler: AgentEndHandler): void
    (event: "tool.call", handler: ToolCallHandler): void
    (event: "tool.result", handler: ToolResultHandler): void
  }
  readonly registerTool: (name: string, options: RegisterToolOptions, execute: ToolHandler) => void
  readonly registerCommand: (
    name: string,
    descriptor: CommandDescriptor,
    execute: CommandHandler,
  ) => CommandSubscription
  readonly registerMode: (mode: ModeRegistration) => void
  readonly registerSubagent: (subagent: SubagentRegistration) => void
}

export type PluginEntrypoint = (api: PluginAPI) => MaybePromise<void>

export interface ToolRegistration {
  readonly plugin: PluginSummary
  readonly descriptor: ToolDescriptor
  readonly execute: ToolHandler
}

export interface ToolDescriptor {
  readonly name: string
  readonly description: string
  readonly inputSchema?: Common.JsonValue
}

export interface CommandRegistrationState {
  readonly plugin: PluginSummary
  readonly name: string
  readonly handler: CommandHandler
  descriptor: CommandDescriptor
  availability: CommandAvailability
}
