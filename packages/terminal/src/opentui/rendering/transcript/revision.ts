import { Function } from "effect"
import { Block } from "@rika/transcript/transcript-presentation-model"
import { StyledText, type TextChunk, type TextRenderable } from "@opentui/core"
import type { Model } from "../../../state/model"
import type {
  NestedTranscriptUnit,
  ToolTranscriptUnit,
  TranscriptUnit,
} from "../../../presentation/transcript/tool/types"
import type { AgentOutcome, AgentResponseState } from "../../../presentation/transcript/tool/kinds"
import type { PathTarget } from "../../../presentation/transcript/tool/detail-types"

let transcriptIdentityCounter = 0
const transcriptIdentityRevisions = new WeakMap<object, number>()
type TranscriptIdentity = Block | Model["entries"][number]
const identityRevision = (value: TranscriptIdentity): number => {
  const current = transcriptIdentityRevisions.get(value)
  if (current !== undefined) return current
  transcriptIdentityCounter += 1
  transcriptIdentityRevisions.set(value, transcriptIdentityCounter)
  return transcriptIdentityCounter
}
const blockAt = (model: Model, index: number): Block => model.blocks[index]!

export const agentResponseOutcome = (state: AgentResponseState): AgentOutcome =>
  state._tag === "Streaming" ? { kind: "answer", entry: state.answer } : state.outcome

const transcriptUnitRevisionImpl = (
  model: Model,
  unit: TranscriptUnit,
  unitKey: string,
  expandedSet: ReadonlySet<string>,
): string => {
  const ids: Array<number> = []
  const bits: Array<string> = []
  const explicitlyCollapsed = new Set(model.explicitlyCollapsedRowKeys)
  const pushExpanded = (id: string) =>
    bits.push(`${expandedSet.has(id) ? "1" : "0"}${explicitlyCollapsed.has(id) ? "c" : "o"}`)
  const walkTool = (tool: ToolTranscriptUnit) => {
    for (const index of tool.blocks) {
      const block = blockAt(model, index)
      ids.push(identityRevision(block))
      if (block._tag === "ToolCall") {
        pushExpanded(`tool:${block.id}`)
        pushExpanded(`tool-child:${block.id}`)
        for (const file of block.files) pushExpanded(`file:${file.key}`)
      }
    }
    for (const index of tool.diffs) ids.push(identityRevision(blockAt(model, index)))
    for (const child of tool.children ?? []) walkNested(child)
    const response = tool.agentResponse === undefined ? undefined : agentResponseOutcome(tool.agentResponse)
    if (response?.kind === "answer") {
      const entry = model.entries[response.entry]
      if (entry !== undefined) ids.push(identityRevision(entry))
    } else if (response?.kind === "error") bits.push(`${response.tone}:${response.text}`)
  }
  const walkBlock = (index: number) => {
    const block = blockAt(model, index)
    ids.push(identityRevision(block))
    if (block._tag === "Compaction" && block.status === "complete")
      bits.push(`rainbow:${model.compactionShimmer?.tick ?? 0}`)
  }
  const walkNested = (nested: NestedTranscriptUnit) => {
    if (nested.kind === "subagent-group") {
      walkBlock(nested.block)
      const block = blockAt(model, nested.block)
      if (block._tag === "SubagentGroup") pushExpanded(`subagent-group:${block.id}`)
      for (const child of nested.children) walkNested(child)
    } else if (nested.kind === "subagent") {
      walkBlock(nested.block)
      const block = blockAt(model, nested.block)
      if (block._tag === "SubagentCard") pushExpanded(`subagent:${block.id}`)
      for (const child of nested.children) walkNested(child)
      walkAgentResponse(nested.agentResponse)
    } else walkTool(nested)
  }
  const walkAgentResponse = (state: AgentResponseState | undefined) => {
    const response = state === undefined ? undefined : agentResponseOutcome(state)
    if (response?.kind === "answer") {
      const entry = model.entries[response.entry]
      if (entry !== undefined) ids.push(identityRevision(entry))
    } else if (response?.kind === "error") bits.push(`${response.tone}:${response.text}`)
  }
  switch (unit.kind) {
    case "entry":
      {
        const entry = model.entries[unit.entry]
        if (entry !== undefined) ids.push(identityRevision(entry))
      }
      break
    case "tool":
      walkTool(unit)
      break
    case "subagent-group":
      walkBlock(unit.block)
      for (const child of unit.children) walkNested(child)
      break
    case "subagent":
      walkBlock(unit.block)
      for (const child of unit.children) walkNested(child)
      walkAgentResponse(unit.agentResponse)
      break
    case "reasoning":
    case "diff":
    case "block":
      walkBlock(unit.block)
      break
  }
  pushExpanded(unitKey)
  const selected = model.detailSelection === unitKey ? "1" : "0"
  return `${ids.join(".")}|${bits.join("")}|${selected}|${model.width}`
}

export const transcriptUnitRevision: {
  (
    arg1: Parameters<typeof transcriptUnitRevisionImpl>[1],
    arg2: Parameters<typeof transcriptUnitRevisionImpl>[2],
    arg3: Parameters<typeof transcriptUnitRevisionImpl>[3],
  ): (arg0: Parameters<typeof transcriptUnitRevisionImpl>[0]) => ReturnType<typeof transcriptUnitRevisionImpl>
  (
    arg0: Parameters<typeof transcriptUnitRevisionImpl>[0],
    arg1: Parameters<typeof transcriptUnitRevisionImpl>[1],
    arg2: Parameters<typeof transcriptUnitRevisionImpl>[2],
    arg3: Parameters<typeof transcriptUnitRevisionImpl>[3],
  ): ReturnType<typeof transcriptUnitRevisionImpl>
} = Function.dual(4, transcriptUnitRevisionImpl)

export interface TranscriptRenderableDescriptor {
  readonly key: string
  readonly revision: string
  readonly content: StyledText
  readonly selectable?: boolean
  readonly spinnerChunk?: number
  readonly targets?: ReadonlyArray<PathTarget>
  readonly onMouseDown?: TextRenderable["onMouseDown"]
}
export interface TranscriptRangeBundle {
  readonly key: string
  readonly rows: number
  readonly descriptors: ReadonlyArray<TranscriptRenderableDescriptor>
}

export interface TentativeTranscriptLayout {
  readonly width: number
  readonly tone: "answer" | "reasoning"
  markdown: boolean
  sourceLength: number
  pending: string
  pendingSource: string
  readonly bands: Array<Array<string>>
  readonly stableContent: Array<StyledText | undefined>
  readonly markdownTailBands: Array<MarkdownTailBand>
}

/** One renderable-sized slice of the streaming Markdown tail; `revision` changes only when its lines change. */
export interface MarkdownTailBand {
  readonly lines: ReadonlyArray<ReadonlyArray<TextChunk>>
  readonly content: StyledText
  readonly revision: number
}

export interface TranscriptUnitCacheEntry {
  readonly revision: string
  readonly bundles: ReadonlyArray<TranscriptRangeBundle>
  readonly tentative?: TentativeTranscriptLayout
}
