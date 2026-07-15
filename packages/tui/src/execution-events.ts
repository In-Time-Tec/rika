import { Function } from "effect"
import type { Message, TranscriptBlock } from "./view-state"

export interface Event {
  readonly turnId?: string
  readonly cursor: string
  readonly sequence: number
  readonly type: string
  readonly text?: string
  readonly content?: ReadonlyArray<unknown>
  readonly data?: Readonly<Record<string, unknown>>
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}

const string = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback)

const payload = (event: Event): Record<string, unknown> => event.data ?? record(event.content?.[0])

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

const eventId = (event: Event, id: string): string => (event.turnId === undefined ? id : `${event.turnId}:${id}`)

const block = (event: Event): TranscriptBlock | undefined => {
  const value = payload(event)
  if (event.type === "tool.call.requested")
    return {
      _tag: "ToolCall",
      id: eventId(event, string(value.tool_call_id, event.cursor)),
      name: string(value.tool_name, "tool"),
      input: typeof value.input === "string" ? value.input : JSON.stringify(value.input),
      status: "running",
    }
  if (event.type === "tool.result.received")
    return {
      _tag: "ToolResult",
      id: eventId(event, string(value.tool_call_id, event.cursor)),
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
      id: eventId(event, string(value.callId ?? value.call_id ?? value.id, event.cursor)),
      output: event.text ?? string(value.output ?? value.result),
      failed: event.type.includes("failed") || value.failed === true,
    }
  if (event.type.includes("tool"))
    return {
      _tag: "ToolCall",
      id: eventId(event, string(value.callId ?? value.call_id ?? value.id, event.cursor)),
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

export const messages = (event: Event): ReadonlyArray<Message> => {
  if (event.type === "model.output.delta")
    return event.text === undefined
      ? []
      : [
          {
            _tag: "AssistantStreamed",
            ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
            text: event.text,
          },
        ]
  if (event.type === "model.usage.reported") {
    const cost = usageCost(payload(event))
    return cost === undefined ? [] : [{ _tag: "UsageReported", costUsd: cost }]
  }
  if (event.type === "model.output.completed")
    return [
      {
        _tag: "AssistantCompleted",
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        text: event.text ?? "",
      },
    ]
  if (event.type === "execution.completed")
    return [{ _tag: "ExecutionCompleted", ...(event.turnId === undefined ? {} : { turnId: event.turnId }) }]
  if (event.type === "execution.failed")
    return [
      {
        _tag: "ExecutionFailed",
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        message: event.text ?? "Execution failed",
      },
    ]
  if (event.type === "execution.cancelled")
    return [{ _tag: "ExecutionCancelled", ...(event.turnId === undefined ? {} : { turnId: event.turnId }) }]
  if (event.type === "model.toolcall.delta") {
    const value = payload(event)
    const id = eventId(event, string(value.tool_call_id, event.cursor))
    const name = value.tool_name
    return [
      {
        _tag: "ToolCallDeltaReceived",
        id,
        ...(typeof name === "string" ? { name } : {}),
        delta: string(value.delta ?? event.text),
      },
    ]
  }
  const replayed = (projected: TranscriptBlock, suffix: string): Message => ({
    _tag: "EventReplayed",
    event: {
      id: eventId(event, `${event.sequence}:${event.type}${suffix}`),
      cursor: event.cursor,
      ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
      block: projected,
    },
  })
  if (event.type === "tool.result.received") {
    const result = block(event)
    if (result === undefined) return []
    const diff = outputDiff(payload(event).output)
    return diff === undefined
      ? [replayed(result, "")]
      : [replayed(result, ""), replayed({ _tag: "Diff", path: diffPath(diff), patch: diff }, ":diff")]
  }
  const projected = block(event)
  return projected === undefined ? [] : [replayed(projected, "")]
}

export const project: {
  (events: ReadonlyArray<Event>): (model: import("./view-state").Model) => import("./view-state").Model
  (model: import("./view-state").Model, events: ReadonlyArray<Event>): import("./view-state").Model
} = Function.dual(2, (model: import("./view-state").Model, events: ReadonlyArray<Event>) => {
  let next = model
  const seen = new Set(next.seenExecutionEventKeys)
  let eventCursor = next.eventCursor
  for (const event of events.toSorted((left, right) => left.sequence - right.sequence)) {
    const key = `${event.turnId ?? ""}\u0000${event.cursor}`
    if (seen.has(key)) continue
    seen.add(key)
    eventCursor = event.cursor
    for (const message of messages(event)) next = importViewStateUpdate(next, message)
  }
  const keys = [...seen]
  return {
    ...next,
    seenExecutionEventKeys: keys.length > 2048 ? keys.slice(-2048) : keys,
    eventCursor,
  }
})

export const projectTurn: {
  (
    turnId: string,
    prompt: string,
    events: ReadonlyArray<Event>,
  ): (model: import("./view-state").Model) => import("./view-state").Model
  (
    model: import("./view-state").Model,
    turnId: string,
    prompt: string,
    events: ReadonlyArray<Event>,
  ): import("./view-state").Model
} = Function.dual(
  4,
  (model: import("./view-state").Model, turnId: string, prompt: string, events: ReadonlyArray<Event>) =>
    project(
      importViewStateUpdate(model, { _tag: "TurnStarted", turnId, prompt }),
      events.map((event) => ({ ...event, turnId })),
    ),
)

import { update as importViewStateUpdate } from "./view-state"
