import { Config, IdGenerator, Time } from "@rika/core"
import { Modes, Provider, Router } from "@rika/llm"
import { Common, Ids } from "@rika/schema"
import type { Call } from "@rika/schema/tool"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as ToolExecutor from "./tool-executor"
import * as ToolRegistry from "./tool-registry"

export const Status = Schema.Literals(["completed", "failed", "cancelled"]).annotate({
  identifier: "Rika.Agent.SubagentRuntime.Status",
})
export type Status = typeof Status.Type

export const ToolAccess = Schema.Literals(["read-only", "read-write", "none"]).annotate({
  identifier: "Rika.Agent.SubagentRuntime.ToolAccess",
})
export type ToolAccess = typeof ToolAccess.Type

export interface Spec extends Schema.Schema.Type<typeof Spec> {}
export const Spec = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  prompt: Schema.String,
  tool_access: Schema.optionalKey(ToolAccess),
  tool_names: Schema.optionalKey(Schema.Array(Schema.String)),
  max_output_chars: Schema.optionalKey(Schema.Int),
  mode: Schema.optionalKey(Config.Mode),
  profile: Schema.optionalKey(Modes.ProfileName),
}).annotate({ identifier: "Rika.Agent.SubagentRuntime.Spec" })

export interface RunBatchInput extends Schema.Schema.Type<typeof RunBatchInput> {}
export const RunBatchInput = Schema.Struct({
  parent_thread_id: Schema.optionalKey(Ids.ThreadId),
  parent_turn_id: Schema.optionalKey(Ids.TurnId),
  agents: Schema.Array(Spec),
  cancelled: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "Rika.Agent.SubagentRuntime.RunBatchInput" })

export interface RunSummary extends Schema.Schema.Type<typeof RunSummary> {}
export const RunSummary = Schema.Struct({
  subagent_id: Schema.String,
  name: Schema.String,
  status: Status,
  summary: Schema.String,
  evidence: Schema.Array(Schema.String),
  tool_access: ToolAccess,
  tool_names: Schema.Array(Schema.String),
  started_at: Common.TimestampMillis,
  completed_at: Common.TimestampMillis,
}).annotate({ identifier: "Rika.Agent.SubagentRuntime.RunSummary" })

export interface BatchResult extends Schema.Schema.Type<typeof BatchResult> {}
export const BatchResult = Schema.Struct({
  type: Schema.Literal("subagent.batch"),
  runs: Schema.Array(RunSummary),
}).annotate({ identifier: "Rika.Agent.SubagentRuntime.BatchResult" })

export class SubagentRuntimeError extends Schema.TaggedErrorClass<SubagentRuntimeError>()("SubagentRuntimeError", {
  message: Schema.String,
  operation: Schema.String,
  name: Schema.optional(Schema.String),
}) {}

export type RunError = SubagentRuntimeError | Router.RouterError | Provider.ProviderError

export interface Interface {
  readonly runBatch: (input: RunBatchInput) => Effect.Effect<BatchResult, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/agent/SubagentRuntime") {}

interface Dependencies {
  readonly idGenerator: IdGenerator.Interface
  readonly time: Time.Interface
  readonly router: Router.Interface
  readonly toolExecutor: ToolExecutor.Interface
}

export const readOnlyToolNames = [
  "semantic_search",
  "semantic_search_status",
  "fffind",
  "fff_glob",
  "fff_directory_search",
  "ffgrep",
  "fff_multi_grep",
  "fff_health",
  "ast_grep_outline",
  "read",
] as const

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const idGenerator = yield* IdGenerator.Service
    const time = yield* Time.Service
    const router = yield* Router.Service
    const toolExecutor = yield* ToolExecutor.SubagentService
    const dependencies: Dependencies = { idGenerator, time, router, toolExecutor }

    return Service.of({
      runBatch: Effect.fn("SubagentRuntime.runBatch")(function* (input: RunBatchInput) {
        yield* validateBatchInput(input)
        const runs = yield* Effect.forEach(input.agents, (spec, index) => runOne(dependencies, spec, index, input), {
          concurrency: "unbounded",
        })
        return { type: "subagent.batch", runs }
      }),
    })
  }),
)

export const fakeLayer = (handler: Interface["runBatch"]) => Layer.succeed(Service, Service.of({ runBatch: handler }))

export const runBatch = Effect.fn("SubagentRuntime.runBatch.call")(function* (input: RunBatchInput) {
  const runtime = yield* Service
  return yield* runtime.runBatch(input)
})

export const toolDefinitions = (runtime: Interface): ReadonlyArray<ToolRegistry.Definition> => [
  {
    tool: Tool.make("task", {
      description:
        "Run one or more isolated subagents in parallel and return compact summaries with evidence. Use read-write access only when the user asked for delegated implementation or workspace mutation.",
      parameters: RunBatchInput,
      success: Schema.Json,
      failure: Schema.Json,
      failureMode: "return",
    }),
    execute: Effect.fn("SubagentRuntime.tool.execute")(function* (call: Call) {
      const decoded = Schema.decodeUnknownOption(RunBatchInput)(call.input)
      if (Option.isNone(decoded)) {
        return yield* new ToolRegistry.ToolRegistryError({
          message: "task input must include an agents array with prompt strings",
          name: call.name,
          retryable: false,
        })
      }
      const result = yield* runtime.runBatch(withParentFromToolCall(decoded.value, call)).pipe(
        Effect.mapError(
          (error) =>
            new ToolRegistry.ToolRegistryError({
              message: error.message,
              name: call.name,
              retryable: false,
            }),
        ),
      )
      return batchResultToJson(result)
    }),
  },
]

const validateBatchInput = (input: RunBatchInput) =>
  Effect.gen(function* () {
    if (input.agents.length === 0) {
      return yield* new SubagentRuntimeError({ message: "At least one subagent is required", operation: "runBatch" })
    }
    if (input.agents.length > 4) {
      return yield* new SubagentRuntimeError({
        message: "At most four subagents may run at once",
        operation: "runBatch",
      })
    }
    for (const spec of input.agents) {
      if (spec.prompt.trim().length === 0) {
        return yield* new SubagentRuntimeError({
          message: "Subagent prompt must not be empty",
          operation: "runBatch",
          ...(spec.name === undefined ? {} : { name: spec.name }),
        })
      }
      const toolAccess = spec.tool_access ?? "read-only"
      const disallowed =
        toolAccess === "read-write" ? [] : requestedToolNames(spec).filter((name) => !readOnlyToolSet.has(name))
      if (disallowed.length > 0) {
        return yield* new SubagentRuntimeError({
          message: `Subagents are read-only; disallowed tools: ${disallowed.join(", ")}`,
          operation: "runBatch",
          ...(spec.name === undefined ? {} : { name: spec.name }),
        })
      }
    }
    return undefined
  })

const runOne = (dependencies: Dependencies, spec: Spec, index: number, input: RunBatchInput) =>
  Effect.gen(function* () {
    const subagentId = yield* dependencies.idGenerator.next("subagent")
    const startedAt = yield* dependencies.time.nowMillis
    const name = spec.name ?? `subagent-${index + 1}`
    const toolAccess = spec.tool_access ?? "read-only"
    const toolNames = toolAccess === "none" ? [] : requestedToolNames(spec)
    const metadata = subagentMetadata(input, subagentId, name)
    const messages = yield* subagentMessages(dependencies, spec, name, toolAccess, toolNames)

    if (input.cancelled === true) {
      const completedAt = yield* dependencies.time.nowMillis
      return runSummary({
        subagent_id: subagentId,
        name,
        status: "cancelled",
        summary: "Subagent cancelled before execution.",
        evidence: [],
        tool_access: toolAccess,
        tool_names: toolNames,
        started_at: startedAt,
        completed_at: completedAt,
      })
    }

    const response = yield* dependencies.router
      .complete({ mode: spec.mode, profile: spec.profile, messages, metadata })
      .pipe(Effect.result)
    const completedAt = yield* dependencies.time.nowMillis

    if (response._tag === "Failure") {
      return runSummary({
        subagent_id: subagentId,
        name,
        status: "failed",
        summary: "Subagent failed before producing a summary.",
        evidence: [],
        tool_access: toolAccess,
        tool_names: toolNames,
        started_at: startedAt,
        completed_at: completedAt,
      })
    }

    const toolRequest = parseToolRequest(response.success.content)
    if (toolRequest !== undefined) {
      return yield* runToolFollowUp(
        dependencies,
        spec,
        name,
        toolAccess,
        toolNames,
        messages,
        response.success.content,
        toolRequest,
        {
          subagent_id: subagentId,
          metadata,
          started_at: startedAt,
          completed_at: completedAt,
        },
      )
    }

    const content = response.success.content.trim()
    return runSummary({
      subagent_id: subagentId,
      name,
      status: "completed",
      summary: capText(content.length === 0 ? "Subagent completed without a text summary." : content, outputCap(spec)),
      evidence: extractEvidence(content),
      tool_access: toolAccess,
      tool_names: toolNames,
      started_at: startedAt,
      completed_at: completedAt,
    })
  })

const runToolFollowUp = (
  dependencies: Dependencies,
  spec: Spec,
  name: string,
  toolAccess: ToolAccess,
  toolNames: ReadonlyArray<string>,
  messages: ReadonlyArray<Provider.Message>,
  assistantContent: string,
  toolRequest: ToolRequest,
  ids: {
    readonly subagent_id: string
    readonly metadata: Provider.Metadata
    readonly started_at: Common.TimestampMillis
    readonly completed_at: Common.TimestampMillis
  },
) =>
  Effect.gen(function* () {
    if (toolAccess === "none" || !toolNames.includes(toolRequest.name)) {
      return runSummary({
        subagent_id: ids.subagent_id,
        name,
        status: "failed",
        summary: `Subagent requested disallowed tool ${toolRequest.name}.`,
        evidence: [],
        tool_access: toolAccess,
        tool_names: toolNames,
        started_at: ids.started_at,
        completed_at: ids.completed_at,
      })
    }

    const toolCall: Call = {
      id: Ids.ToolCallId.make(yield* dependencies.idGenerator.next("tool_call")),
      name: toolRequest.name,
      input: toolRequest.input,
      metadata: ids.metadata,
    }
    const toolResult = yield* dependencies.toolExecutor.execute(toolCall)
    const finalResponse = yield* dependencies.router
      .complete({
        mode: spec.mode,
        profile: spec.profile,
        metadata: ids.metadata,
        messages: [
          ...messages,
          { role: "assistant", content: assistantContent },
          { role: "tool", content: JSON.stringify(toolResult) },
        ],
      })
      .pipe(Effect.result)
    const completedAt = yield* dependencies.time.nowMillis

    if (finalResponse._tag === "Failure") {
      return runSummary({
        subagent_id: ids.subagent_id,
        name,
        status: "failed",
        summary: "Subagent failed after a tool result.",
        evidence: [],
        tool_access: toolAccess,
        tool_names: toolNames,
        started_at: ids.started_at,
        completed_at: completedAt,
      })
    }

    const content = finalResponse.success.content.trim()
    return runSummary({
      subagent_id: ids.subagent_id,
      name,
      status: toolResult.status === "success" ? "completed" : "failed",
      summary: capText(content.length === 0 ? "Subagent completed without a text summary." : content, outputCap(spec)),
      evidence: extractEvidence(content),
      tool_access: toolAccess,
      tool_names: toolNames,
      started_at: ids.started_at,
      completed_at: completedAt,
    })
  })

const subagentMessages = (
  dependencies: Dependencies,
  spec: Spec,
  name: string,
  toolAccess: ToolAccess,
  toolNames: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<Provider.Message>> =>
  Effect.gen(function* () {
    const descriptors = (yield* dependencies.toolExecutor.describe).filter((descriptor) =>
      toolNames.includes(descriptor.name),
    )
    return [
      {
        role: "system" as const,
        content: [
          `You are Rika subagent ${name}.`,
          "Work in isolation. Do not assume other subagents can see your context or findings.",
          "Return a compact final summary with specific evidence. Do not include raw transcripts.",
          toolInstructions(toolAccess, descriptors),
        ].join("\n"),
      },
      { role: "user" as const, content: spec.prompt },
    ]
  })

const toolInstructions = (toolAccess: ToolAccess, descriptors: ReadonlyArray<ToolRegistry.Descriptor>) => {
  if (toolAccess === "none") return "No tools are available for this subagent."
  return [
    toolAccess === "read-write" ? "Tools available to this subagent:" : "Read-only tools available to this subagent:",
    ...descriptors.map((descriptor) => `- ${descriptor.name}: ${descriptor.description}`),
    'To call a tool once, respond with JSON only: {"tool_call":{"name":"tool.name","input":{}}}',
    toolAccess === "read-write"
      ? "Use mutating tools only when required by the delegated task."
      : "Do not propose or perform file mutations.",
  ].join("\n")
}

const requestedToolNames = (spec: Spec): ReadonlyArray<string> =>
  spec.tool_names === undefined || spec.tool_names.length === 0 ? [...readOnlyToolNames] : [...spec.tool_names]

const subagentMetadata = (input: RunBatchInput, subagentId: string, name: string): Provider.Metadata => ({
  subagent_id: subagentId,
  subagent_name: name,
  ...(input.parent_thread_id === undefined ? {} : { parent_thread_id: input.parent_thread_id }),
  ...(input.parent_turn_id === undefined ? {} : { parent_turn_id: input.parent_turn_id }),
})

const withParentFromToolCall = (input: RunBatchInput, call: Call): RunBatchInput => ({
  ...input,
  ...(typeof call.metadata?.thread_id === "string"
    ? { parent_thread_id: Ids.ThreadId.make(call.metadata.thread_id) }
    : {}),
  ...(typeof call.metadata?.turn_id === "string" ? { parent_turn_id: Ids.TurnId.make(call.metadata.turn_id) } : {}),
})

const batchResultToJson = (result: BatchResult): Common.JsonValue => ({
  type: result.type,
  runs: result.runs.map((run) => ({
    subagent_id: run.subagent_id,
    name: run.name,
    status: run.status,
    summary: run.summary,
    evidence: [...run.evidence],
    tool_access: run.tool_access,
    tool_names: [...run.tool_names],
    started_at: run.started_at,
    completed_at: run.completed_at,
  })),
})

const runSummary = (summary: RunSummary): RunSummary => summary

interface ToolRequest {
  readonly name: string
  readonly input: Common.JsonValue
}

const parseToolRequest = (content: string): ToolRequest | undefined => {
  const parsed = parseJsonObject(content)
  if (parsed === undefined) return undefined
  const toolCall = parsed.tool_call
  if (!isRecord(toolCall) || typeof toolCall.name !== "string") return undefined
  const decodedInput = Schema.decodeUnknownOption(Common.JsonValue)(toolCall.input ?? {})
  if (Option.isNone(decodedInput)) return undefined
  return { name: toolCall.name, input: decodedInput.value }
}

const parseJsonObject = (content: string): Record<string, unknown> | undefined => {
  const json = extractJson(content)
  try {
    const parsed: unknown = JSON.parse(json)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const extractJson = (content: string) => {
  const trimmed = content.trim()
  if (!trimmed.startsWith("```")) return trimmed
  const firstLineEnd = trimmed.indexOf("\n")
  const lastFenceStart = trimmed.lastIndexOf("```")
  if (firstLineEnd < 0 || lastFenceStart <= firstLineEnd) return trimmed
  return trimmed.slice(firstLineEnd + 1, lastFenceStart).trim()
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const extractEvidence = (content: string): ReadonlyArray<string> =>
  content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter((line) => line.length > 0)
    .slice(0, 5)

const outputCap = (spec: Spec) => clamp(spec.max_output_chars ?? 2_000, 200, 8_000)
const capText = (text: string, maxChars: number) =>
  text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n… truncated`
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)
const readOnlyToolSet = new Set<string>(readOnlyToolNames)
