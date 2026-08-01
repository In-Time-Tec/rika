import { Duration, Function, Schema } from "effect"
import { formatTokens, plural } from "../../presentation/terminal/terminal-format"
import type { Model, TranscriptBlock, TranscriptItem } from "./terminal-state"
import type { UsageTime } from "./terminal-usage-state"

export const Activity = Schema.Union([
  Schema.TaggedStruct("Sending", {}),
  Schema.TaggedStruct("Waiting", {}),
  Schema.TaggedStruct("Thinking", { bytes: Schema.Finite, blockId: Schema.optionalKey(Schema.String) }),
  Schema.TaggedStruct("Streaming", { bytes: Schema.Finite, blockId: Schema.optionalKey(Schema.String) }),
  Schema.TaggedStruct("RunningTools", {
    subagents: Schema.optionalKey(Schema.Finite),
    tools: Schema.optionalKey(Schema.Finite),
  }),
  Schema.TaggedStruct("Compacting", {}),
])
export type Activity = typeof Activity.Type

export const utf8ByteLength = (value: string): number => {
  let bytes = 0
  for (const character of value) {
    const point = character.codePointAt(0)!
    if (point <= 0x7f) bytes += 1
    else if (point <= 0x7ff) bytes += 2
    else if (point <= 0xffff) bytes += 3
    else bytes += 4
  }
  return bytes
}

export const formatActivityCounter = formatTokens

export const formatActivity = (activity: Activity | undefined): string | undefined => {
  if (activity === undefined) return undefined
  if (activity._tag === "RunningTools") {
    const labels = [
      ...(activity.subagents === undefined || activity.subagents === 0 ? [] : [plural(activity.subagents, "subagent")]),
      ...(activity.tools === undefined || activity.tools === 0 ? [] : [plural(activity.tools, "tool")]),
    ]
    return labels.length === 0 ? "Running tools" : `Running ${labels.join(", ")}`
  }
  if (activity._tag === "Compacting") return "Auto-Compacting"
  if (activity._tag === "Thinking" || activity._tag === "Streaming") {
    const tokens = Math.floor(activity.bytes / 4)
    return `${activity._tag} ${formatActivityCounter(tokens)}`
  }
  return activity._tag
}

export const runningToolsActivity = (model: Model): Activity => {
  const nestedBlocks = new Set(
    (model.items as ReadonlyArray<TranscriptItem>).flatMap((item) =>
      item._tag === "Block" && item.parentId !== undefined ? [item.index] : [],
    ),
  )
  let subagents = 0
  let tools = 0
  for (const [index, candidate] of model.blocks.entries()) {
    const block = candidate as TranscriptBlock
    if (block._tag !== "ToolCall" || block.status !== "running") continue
    if (block.presentation.family === "agent") {
      if (!nestedBlocks.has(index)) subagents += 1
    } else tools += 1
  }
  return { _tag: "RunningTools", subagents, tools }
}

const streamActivityImpl = (
  current: Activity | undefined,
  tag: "Thinking" | "Streaming",
  text: string,
  blockId?: string,
): Activity => ({
  _tag: tag,
  bytes:
    current?._tag === tag && current.blockId === blockId ? current.bytes + utf8ByteLength(text) : utf8ByteLength(text),
  ...(blockId === undefined ? {} : { blockId }),
})

export const streamActivity: {
  (current: Activity | undefined, tag: "Thinking" | "Streaming", text: string, blockId: string | undefined): Activity
  (
    tag: "Thinking" | "Streaming",
    text: string,
    blockId: string | undefined,
  ): (current: Activity | undefined) => Activity
} = Function.dual(4, streamActivityImpl)

export const activeTimeIcon = "◷"
export const activeTimeAt: {
  (time: Extract<UsageTime, { readonly _tag: "Available" }>, now: number): Duration.Duration
  (now: number): (time: Extract<UsageTime, { readonly _tag: "Available" }>) => Duration.Duration
} = Function.dual(
  2,
  (time: Extract<UsageTime, { readonly _tag: "Available" }>, now: number): Duration.Duration =>
    Duration.sum(
      Duration.millis(time.accumulatedMillis),
      Duration.millis(time.activeSince === undefined ? 0 : Math.max(0, now - time.activeSince)),
    ),
)

export const formatActiveTime = (duration: Duration.Duration): string => {
  const parts = Duration.parts(duration)
  if (parts.days > 0) return `${activeTimeIcon} ${parts.days}d${parts.hours > 0 ? ` ${parts.hours}h` : ""}`
  if (parts.hours > 0) return `${activeTimeIcon} ${parts.hours}h${parts.minutes > 0 ? ` ${parts.minutes}m` : ""}`
  if (parts.minutes > 0) return `${activeTimeIcon} ${parts.minutes}m${parts.seconds > 0 ? ` ${parts.seconds}s` : ""}`
  return `${activeTimeIcon} ${parts.seconds}s`
}

export type { UsageTime } from "./terminal-usage-state"
