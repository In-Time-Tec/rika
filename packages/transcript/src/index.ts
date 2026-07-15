import { Function, Schema } from "effect"

export const SourceEvent = Schema.Struct({
  cursor: Schema.String,
  sequence: Schema.Finite,
  type: Schema.String,
  createdAt: Schema.Finite,
  text: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  data: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
})
export type SourceEvent = typeof SourceEvent.Type

const Reasoning = Schema.TaggedStruct("Reasoning", {
  text: Schema.String,
  expanded: Schema.Boolean,
})
const ToolCall = Schema.TaggedStruct("ToolCall", {
  id: Schema.String,
  name: Schema.String,
  input: Schema.String,
  status: Schema.Literals(["running", "complete", "failed"]),
  output: Schema.optionalKey(Schema.String),
  expanded: Schema.optionalKey(Schema.Boolean),
})
const ToolResult = Schema.TaggedStruct("ToolResult", {
  id: Schema.String,
  output: Schema.String,
  failed: Schema.Boolean,
})
const Diff = Schema.TaggedStruct("Diff", {
  path: Schema.String,
  patch: Schema.String,
  expanded: Schema.optionalKey(Schema.Boolean),
})
const ContextUsage = Schema.TaggedStruct("ContextUsage", {
  text: Schema.String,
  cost: Schema.optionalKey(Schema.String),
})
const Compaction = Schema.TaggedStruct("Compaction", {
  summary: Schema.String,
  checkpoint: Schema.optionalKey(Schema.String),
})
const Notification = Schema.TaggedStruct("Notification", {
  title: Schema.String,
  detail: Schema.String,
})
const ErrorBlock = Schema.TaggedStruct("Error", {
  title: Schema.String,
  detail: Schema.String,
  turnId: Schema.optionalKey(Schema.String),
  recovery: Schema.optionalKey(Schema.String),
})
const Permission = Schema.TaggedStruct("Permission", {
  id: Schema.String,
  kind: Schema.Literals(["permission", "tool-approval"]),
  title: Schema.String,
  detail: Schema.String,
  status: Schema.Literals(["pending", "approved", "denied"]),
})
const Queued = Schema.TaggedStruct("Queued", { id: Schema.String, prompt: Schema.String })
const ChildAgent = Schema.TaggedStruct("ChildAgent", {
  name: Schema.String,
  summary: Schema.String,
  status: Schema.Literals(["running", "complete", "failed"]),
})
const Workflow = Schema.TaggedStruct("Workflow", {
  name: Schema.String,
  step: Schema.String,
  status: Schema.Literals(["running", "waiting", "complete", "failed"]),
})
const ImageAttachment = Schema.TaggedStruct("ImageAttachment", {
  name: Schema.String,
  mediaType: Schema.String,
  width: Schema.optionalKey(Schema.Finite),
  height: Schema.optionalKey(Schema.Finite),
  bytes: Schema.optionalKey(Schema.Finite),
})

export const Block = Schema.Union([
  Reasoning,
  ToolCall,
  ToolResult,
  Diff,
  ContextUsage,
  Compaction,
  Notification,
  ErrorBlock,
  Permission,
  Queued,
  ChildAgent,
  Workflow,
  ImageAttachment,
])
export type Block = typeof Block.Type

export const Content = Schema.Union([
  Schema.TaggedStruct("Entry", {
    role: Schema.Literals(["user", "assistant", "notice"]),
    text: Schema.String,
  }),
  Schema.TaggedStruct("Block", { block: Block }),
])
export type Content = typeof Content.Type

export const Unit = Schema.Struct({
  key: Schema.String,
  turnId: Schema.String,
  order: Schema.Struct({ sequence: Schema.Finite, part: Schema.Finite }),
  revision: Schema.Finite,
  content: Content,
})
export type Unit = typeof Unit.Type

export const Draft = Schema.Struct({
  id: Schema.String,
  name: Schema.optionalKey(Schema.String),
  text: Schema.String,
})
export type Draft = typeof Draft.Type

export const Projection = Schema.Struct({
  units: Schema.Array(Unit),
  drafts: Schema.Array(Draft),
  revision: Schema.Finite,
  oldestCursor: Schema.optionalKey(Schema.String),
  checkpointCursor: Schema.optionalKey(Schema.String),
  costUsd: Schema.optionalKey(Schema.Finite),
})
export type Projection = typeof Projection.Type

export type SemanticMessage =
  | { readonly _tag: "AssistantStreamed"; readonly id: string; readonly text: string }
  | { readonly _tag: "AssistantCompleted"; readonly id: string; readonly text: string }
  | { readonly _tag: "ExecutionCompleted" }
  | { readonly _tag: "ExecutionFailed"; readonly id: string; readonly message: string }
  | { readonly _tag: "ExecutionCancelled"; readonly id: string }
  | { readonly _tag: "UsageReported"; readonly costUsd: number }
  | { readonly _tag: "ToolCallDeltaReceived"; readonly id: string; readonly name?: string; readonly delta: string }
  | { readonly _tag: "EventReplayed"; readonly id: string; readonly block: Block; readonly part: number }

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}

const string = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback)

const payload = (event: SourceEvent): Record<string, unknown> => event.data ?? record(event.content?.[0])

const outputText = (output: unknown): string =>
  typeof output === "string"
    ? output
    : typeof record(output).text === "string"
      ? (record(output).text as string)
      : JSON.stringify(output)

const outputDiff = (output: unknown): string | undefined => {
  const diff = record(output).diff
  return typeof diff === "string" && diff.length > 0 ? diff : undefined
}

const diffPath = (patch: string): string => {
  const match = /^\+\+\+ (?:b\/)?(.+)$/m.exec(patch)
  return match?.[1] ?? "diff"
}

const eventId = (turnId: string, event: SourceEvent, id: string): string =>
  turnId.length === 0 ? id : `${turnId}:${id}`

const block = (turnId: string, event: SourceEvent): Block | undefined => {
  const value = payload(event)
  if (event.type === "tool.call.requested")
    return {
      _tag: "ToolCall",
      id: eventId(turnId, event, string(value.tool_call_id, event.cursor)),
      name: string(value.tool_name, "tool"),
      input: typeof value.input === "string" ? value.input : JSON.stringify(value.input),
      status: "running",
    }
  if (event.type === "tool.result.received")
    return {
      _tag: "ToolResult",
      id: eventId(turnId, event, string(value.tool_call_id, event.cursor)),
      output: outputText(value.output),
      failed: typeof value.error === "string",
    }
  if (event.type === "tool.approval.requested" || event.type === "tool.approval.resolved")
    return {
      _tag: "Permission",
      id: string(value.wait_id, event.cursor),
      kind: "tool-approval",
      title: string(value.tool_name, "Permission required"),
      detail:
        typeof value.input === "string" ? value.input : value.input === undefined ? "" : JSON.stringify(value.input),
      status: event.type === "tool.approval.requested" ? "pending" : value.approved === false ? "denied" : "approved",
    }
  if (event.type === "permission.ask.requested" || event.type === "permission.ask.resolved")
    return {
      _tag: "Permission",
      id: string(value.wait_id ?? value.permission_id, event.cursor),
      kind: "permission",
      title: string(value.title ?? value.tool_name ?? value.name, "Permission required"),
      detail:
        typeof value.input === "string" ? value.input : value.input === undefined ? "" : JSON.stringify(value.input),
      status: event.type === "permission.ask.requested" ? "pending" : value.approved === false ? "denied" : "approved",
    }
  if (event.type === "model.usage.reported") return undefined
  if (event.type.includes("diff"))
    return {
      _tag: "Diff",
      path: string(value.path, "diff"),
      patch: event.text ?? string(value.patch ?? value.diff),
    }
  if (event.type === "child_run.spawned" || event.type === "child_run.event")
    return {
      _tag: "ChildAgent",
      name: string(value.preset_name ?? value.child_execution_id, "child"),
      summary: string(value.summary ?? value.error),
      status: event.type === "child_run.spawned" ? "running" : value.status === "failed" ? "failed" : "complete",
    }
  if (event.type.includes("reasoning"))
    return { _tag: "Reasoning", text: event.text ?? string(value.text), expanded: false }
  if (event.type.includes("tool") && (event.type.includes("result") || event.type.includes("completed")))
    return {
      _tag: "ToolResult",
      id: eventId(turnId, event, string(value.callId ?? value.call_id ?? value.id, event.cursor)),
      output: event.text ?? string(value.output ?? value.result),
      failed: event.type.includes("failed") || value.failed === true,
    }
  if (event.type.includes("tool"))
    return {
      _tag: "ToolCall",
      id: eventId(turnId, event, string(value.callId ?? value.call_id ?? value.id, event.cursor)),
      name: string(value.name ?? value.tool, "tool"),
      input: string(value.input, JSON.stringify(value.input ?? value)),
      status: event.type.includes("failed") ? "failed" : event.type.includes("completed") ? "complete" : "running",
    }
  if (event.type.includes("child"))
    return {
      _tag: "ChildAgent",
      name: string(value.profile ?? value.name ?? value.childId, "child"),
      summary: event.text ?? string(value.summary ?? value.error),
      status: event.type.includes("failed") ? "failed" : event.type.includes("completed") ? "complete" : "running",
    }
  if (event.type.includes("workflow"))
    return {
      _tag: "Workflow",
      name: string(value.workflow ?? value.name, "workflow"),
      step: event.text ?? string(value.step ?? value.status),
      status: event.type.includes("failed")
        ? "failed"
        : event.type.includes("completed")
          ? "complete"
          : event.type.includes("wait")
            ? "waiting"
            : "running",
    }
  return undefined
}

const tokenPricing = (model: string): readonly [number, number] =>
  model.includes("claude") || model.includes("fable") || model.includes("opus")
    ? [5, 25]
    : model.includes("haiku") || model.includes("mini") || model.includes("flash")
      ? [0.8, 4]
      : [1.25, 10]

const usageCost = (value: Record<string, unknown>): number | undefined => {
  for (const key of ["cost_usd", "costUsd", "total_cost_usd", "cost", "usd"]) {
    const candidate = value[key]
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate
  }
  const usage = record(value.usage)
  for (const key of ["cost_usd", "costUsd", "cost"]) {
    const candidate = usage[key]
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate
  }
  const inputTokens = value.input_tokens ?? usage.input_tokens
  const outputTokens = value.output_tokens ?? usage.output_tokens
  if (typeof inputTokens !== "number" && typeof outputTokens !== "number") return undefined
  const [inputPrice, outputPrice] = tokenPricing(string(value.model).toLowerCase())
  return (
    ((typeof inputTokens === "number" ? inputTokens : 0) * inputPrice) / 1_000_000 +
    ((typeof outputTokens === "number" ? outputTokens : 0) * outputPrice) / 1_000_000
  )
}

export const messages: {
  (turnId: string, event: SourceEvent): ReadonlyArray<SemanticMessage>
  (event: SourceEvent): (turnId: string) => ReadonlyArray<SemanticMessage>
} = Function.dual(2, (turnId: string, event: SourceEvent): ReadonlyArray<SemanticMessage> => {
  if (event.type === "model.output.delta")
    return event.text === undefined
      ? []
      : [{ _tag: "AssistantStreamed", id: eventId(turnId, event, `${event.sequence}:${event.type}`), text: event.text }]
  if (event.type === "model.usage.reported") {
    const cost = usageCost(payload(event))
    return cost === undefined ? [] : [{ _tag: "UsageReported", costUsd: cost }]
  }
  if (event.type === "model.output.completed")
    return [
      {
        _tag: "AssistantCompleted",
        id: eventId(turnId, event, `${event.sequence}:${event.type}`),
        text: event.text ?? "",
      },
    ]
  if (event.type === "execution.completed") return [{ _tag: "ExecutionCompleted" }]
  if (event.type === "execution.failed")
    return [
      {
        _tag: "ExecutionFailed",
        id: eventId(turnId, event, `${event.sequence}:${event.type}`),
        message: event.text ?? "Execution failed",
      },
    ]
  if (event.type === "execution.cancelled")
    return [{ _tag: "ExecutionCancelled", id: eventId(turnId, event, `${event.sequence}:${event.type}`) }]
  if (event.type === "model.toolcall.delta") {
    const value = payload(event)
    const name = value.tool_name
    return [
      {
        _tag: "ToolCallDeltaReceived",
        id: eventId(turnId, event, string(value.tool_call_id, event.cursor)),
        ...(typeof name === "string" ? { name } : {}),
        delta: string(value.delta ?? event.text),
      },
    ]
  }
  const replayed = (projected: Block, part: number): SemanticMessage => ({
    _tag: "EventReplayed",
    id: eventId(turnId, event, `${event.sequence}:${event.type}${part === 0 ? "" : `:${part}`}`),
    block: projected,
    part,
  })
  if (event.type === "tool.result.received") {
    const result = block(turnId, event)
    if (result === undefined) return []
    const diff = outputDiff(payload(event).output)
    return diff === undefined
      ? [replayed(result, 0)]
      : [replayed(result, 0), replayed({ _tag: "Diff", path: diffPath(diff), patch: diff }, 1)]
  }
  const projected = block(turnId, event)
  return projected === undefined ? [] : [replayed(projected, 0)]
})

const unit = (
  key: string,
  turnId: string,
  sequence: number,
  part: number,
  revision: number,
  content: Content,
): Unit => ({ key, turnId, order: { sequence, part }, revision, content })

export const empty: {
  (turnId: string, prompt: string): Projection
  (prompt: string): (turnId: string) => Projection
} = Function.dual(
  2,
  (turnId: string, prompt: string): Projection => ({
    units: [unit(`turn:${turnId}:user`, turnId, -1, 0, 0, { _tag: "Entry", role: "user", text: prompt })],
    drafts: [],
    revision: -1,
  }),
)

const reduceMessage = (
  projection: Projection,
  turnId: string,
  event: SourceEvent,
  message: SemanticMessage,
): Projection => {
  const units = [...projection.units]
  if (message._tag === "AssistantStreamed" || message._tag === "AssistantCompleted") {
    const last = units.at(-1)
    if (last?.content._tag === "Entry" && last.content.role === "assistant") {
      units[units.length - 1] = {
        ...last,
        revision: event.sequence,
        content: {
          ...last.content,
          text: message._tag === "AssistantCompleted" ? message.text : last.content.text + message.text,
        },
      }
    } else
      units.push(
        unit(message.id, turnId, event.sequence, 0, event.sequence, {
          _tag: "Entry",
          role: "assistant",
          text: message.text,
        }),
      )
    return { ...projection, units }
  }
  if (message._tag === "ExecutionFailed") {
    units.push(
      unit(message.id, turnId, event.sequence, 0, event.sequence, {
        _tag: "Block",
        block: {
          _tag: "Error",
          title: "Execution failed",
          detail: message.message,
          turnId,
          recovery: "Edit your prompt and press Enter to try again.",
        },
      }),
    )
    return { ...projection, units }
  }
  if (message._tag === "ExecutionCancelled") {
    units.push(
      unit(message.id, turnId, event.sequence, 0, event.sequence, {
        _tag: "Entry",
        role: "notice",
        text: "cancelled",
      }),
    )
    return { ...projection, units }
  }
  if (message._tag === "UsageReported") return { ...projection, costUsd: (projection.costUsd ?? 0) + message.costUsd }
  if (message._tag === "ToolCallDeltaReceived") {
    const index = projection.drafts.findIndex((draft) => draft.id === message.id)
    const drafts = [...projection.drafts]
    if (index < 0)
      drafts.push({
        id: message.id,
        ...(message.name === undefined ? {} : { name: message.name }),
        text: message.delta,
      })
    else {
      const current = drafts[index]!
      drafts[index] = {
        ...current,
        ...(message.name === undefined ? {} : { name: message.name }),
        text: current.text + message.delta,
      }
    }
    return { ...projection, drafts }
  }
  if (message._tag === "ExecutionCompleted") return projection
  const incoming = message.block
  const last = units.at(-1)
  if (incoming._tag === "Reasoning" && last?.content._tag === "Block" && last.content.block._tag === "Reasoning") {
    units[units.length - 1] = {
      ...last,
      revision: event.sequence,
      content: {
        _tag: "Block",
        block: { ...last.content.block, text: last.content.block.text + incoming.text },
      },
    }
  } else if (incoming._tag === "ToolResult") {
    const index = units.findIndex(
      (candidate) =>
        candidate.content._tag === "Block" &&
        candidate.content.block._tag === "ToolCall" &&
        candidate.content.block.id === incoming.id,
    )
    if (index >= 0) {
      const current = units[index]!
      if (current.content._tag === "Block" && current.content.block._tag === "ToolCall")
        units[index] = {
          ...current,
          revision: event.sequence,
          content: {
            _tag: "Block",
            block: {
              ...current.content.block,
              output: incoming.output,
              status: incoming.failed ? "failed" : "complete",
            },
          },
        }
    } else
      units.push(
        unit(message.id, turnId, event.sequence, message.part, event.sequence, { _tag: "Block", block: incoming }),
      )
  } else if (incoming._tag === "ToolCall" || incoming._tag === "Permission") {
    const index = units.findIndex(
      (candidate) =>
        candidate.content._tag === "Block" &&
        candidate.content.block._tag === incoming._tag &&
        candidate.content.block.id === incoming.id,
    )
    if (index >= 0) {
      const current = units[index]!
      if (current.content._tag === "Block")
        units[index] = {
          ...current,
          revision: event.sequence,
          content: { _tag: "Block", block: { ...current.content.block, ...incoming } as Block },
        }
    } else
      units.push(
        unit(message.id, turnId, event.sequence, message.part, event.sequence, { _tag: "Block", block: incoming }),
      )
  } else
    units.push(
      unit(message.id, turnId, event.sequence, message.part, event.sequence, { _tag: "Block", block: incoming }),
    )
  return {
    ...projection,
    units,
    ...(incoming._tag === "ToolCall" ? { drafts: projection.drafts.filter((draft) => draft.id !== incoming.id) } : {}),
  }
}

export const applyEvent: {
  (projection: Projection, event: SourceEvent): Projection
  (event: SourceEvent): (projection: Projection) => Projection
} = Function.dual(2, (projection: Projection, event: SourceEvent): Projection => {
  if (event.sequence <= projection.revision) return projection
  let next = projection
  const turnId = projection.units[0]?.turnId ?? ""
  for (const message of messages(turnId, event)) next = reduceMessage(next, turnId, event, message)
  return {
    ...next,
    revision: event.sequence,
    ...(projection.oldestCursor === undefined ? { oldestCursor: event.cursor } : {}),
    checkpointCursor: event.cursor,
  }
})

export const project: {
  (turnId: string, prompt: string, events: ReadonlyArray<SourceEvent>): Projection
  (prompt: string, events: ReadonlyArray<SourceEvent>): (turnId: string) => Projection
} = Function.dual(3, (turnId: string, prompt: string, events: ReadonlyArray<SourceEvent>): Projection => {
  let projection = empty(turnId, prompt)
  for (const event of events.toSorted((left, right) => left.sequence - right.sequence))
    projection = applyEvent(projection, event)
  return projection
})
