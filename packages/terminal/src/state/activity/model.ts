import { Function, Schema } from "effect"
import { formatTokens, plural } from "../../presentation/terminal/format"
import type { Model } from "../model"
import type { TranscriptBlock, TranscriptItem } from "../transcript/model"

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
  Schema.TaggedStruct("Retrying", {
    attempt: Schema.Finite,
    budget: Schema.Finite,
    message: Schema.String,
    nextAt: Schema.Finite,
  }),
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

const formatActivityImpl = (activity: Activity | undefined, countdownSeconds?: number): string | undefined => {
  if (activity === undefined) return undefined
  if (activity._tag === "Retrying") {
    const seconds = countdownSeconds ?? 0
    return `${activity.message} — retrying in ${seconds}s (attempt ${activity.attempt} of ${activity.budget})`
  }
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

export const formatActivity: {
  (activity: Activity | undefined, countdownSeconds?: number): string | undefined
  (activity: Activity | undefined): (countdownSeconds?: number) => string | undefined
} = Function.dual((args) => typeof args[0] !== "number", formatActivityImpl)

const runningCardStatuses: ReadonlySet<string> = new Set(["running", "waiting", "cancelling"])

export const runningToolsActivity = (model: Model): Extract<Activity, { readonly _tag: "RunningTools" }> => {
  const items = model.items as ReadonlyArray<TranscriptItem>
  const blockItems = items.flatMap((item) => (item._tag === "Block" ? [item] : []))
  const ownsChildren = (index: number): boolean => {
    const block = model.blocks[index] as TranscriptBlock | undefined
    if (block === undefined) return false
    return block._tag === "SubagentCard" || (block._tag === "ToolCall" && block.presentation.family === "agent")
  }
  const ownerById = new Map(
    blockItems.flatMap((item) => {
      const block = model.blocks[item.index] as TranscriptBlock | undefined
      if (block?._tag !== "SubagentCard" && block?._tag !== "ToolCall") return []
      return [[block.id, item] as const]
    }),
  )
  const ownedByCard = (item: (typeof blockItems)[number]): boolean => {
    const seen = new Set<string>()
    let cursor = item.parentId
    while (cursor !== undefined && !seen.has(cursor)) {
      seen.add(cursor)
      const owner = ownerById.get(cursor)
      if (owner === undefined) return false
      if (ownsChildren(owner.index)) return true
      cursor = owner.parentId
    }
    return false
  }
  const itemByIndex = new Map(blockItems.map((item) => [item.index, item]))
  let subagents = 0
  let tools = 0
  for (const [index, candidate] of model.blocks.entries()) {
    const block = candidate as TranscriptBlock
    if (block._tag === "SubagentCard") {
      const item = itemByIndex.get(index)
      if (runningCardStatuses.has(block.status) && (item === undefined || !ownedByCard(item))) subagents += 1
      continue
    }
    if (block._tag === "Cell") {
      const item = itemByIndex.get(index)
      if (block.status === "running" && (item === undefined || !ownedByCard(item))) tools += 1
      continue
    }
    if (block._tag !== "ToolCall" || block.status !== "running") continue
    const item = itemByIndex.get(index) ?? { _tag: "Block" as const, index }
    if (ownedByCard(item)) continue
    if (block.presentation.family === "agent") {
      subagents += 1
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
