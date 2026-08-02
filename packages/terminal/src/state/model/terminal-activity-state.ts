import { Function, Schema } from "effect"
import { formatTokens, plural } from "../../presentation/terminal/terminal-format"
import type { Model } from "./terminal-state"
import type { TranscriptBlock, TranscriptItem } from "./terminal-transcript-state"

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
