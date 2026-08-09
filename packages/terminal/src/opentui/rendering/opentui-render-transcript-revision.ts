import { Function } from "effect"
import { StyledText, type TextRenderable } from "@opentui/core"
import type { Model } from "../../state/model/terminal-state"
import type { TranscriptBlock } from "../../state/model/terminal-transcript-state"
import type {
  AgentOutcome,
  AgentResponseState,
  ToolTranscriptUnit,
  TranscriptUnit,
} from "../../presentation/transcript/transcript-tool-types"
import type { PathTarget } from "../../presentation/transcript/transcript-tool-detail-types"

let transcriptIdentityCounter = 0
const transcriptIdentityRevisions = new WeakMap<object, number>()
const identityRevision = (value: unknown): number => {
  if (typeof value !== "object" || value === null) return 0
  const current = transcriptIdentityRevisions.get(value)
  if (current !== undefined) return current
  transcriptIdentityCounter += 1
  transcriptIdentityRevisions.set(value, transcriptIdentityCounter)
  return transcriptIdentityCounter
}

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
  const pushExpanded = (id: string) => bits.push(expandedSet.has(id) ? "1" : "0")
  const walkTool = (tool: ToolTranscriptUnit) => {
    for (const index of tool.blocks) {
      const block = model.blocks[index] as TranscriptBlock
      ids.push(identityRevision(block))
      if (block._tag === "ToolCall") {
        pushExpanded(`tool:${block.id}`)
        pushExpanded(`tool-child:${block.id}`)
        for (const file of block.files) pushExpanded(`file:${file.key}`)
      }
    }
    for (const index of tool.diffs) ids.push(identityRevision(model.blocks[index]))
    for (const child of tool.children ?? []) walkTool(child)
    const response = tool.agentResponse === undefined ? undefined : agentResponseOutcome(tool.agentResponse)
    if (response?.kind === "answer") ids.push(identityRevision(model.entries[response.entry]))
    else if (response?.kind === "error") bits.push(`${response.tone}:${response.text}`)
  }
  const walkBlock = (index: number) => {
    const block = model.blocks[index] as TranscriptBlock
    ids.push(identityRevision(block))
    if (block._tag === "Compaction" && block.status === "complete")
      bits.push(`rainbow:${model.compactionShimmer?.tick ?? 0}`)
    if (block._tag === "Cell") {
      pushExpanded(`cell:${block.id}`)
      for (const file of block.files) pushExpanded(`file:${file.key}`)
    }
  }
  const walkAgentResponse = (state: AgentResponseState | undefined) => {
    const response = state === undefined ? undefined : agentResponseOutcome(state)
    if (response?.kind === "answer") ids.push(identityRevision(model.entries[response.entry]))
    else if (response?.kind === "error") bits.push(`${response.tone}:${response.text}`)
  }
  switch (unit.kind) {
    case "entry":
      ids.push(identityRevision(model.entries[unit.entry]))
      break
    case "tool":
      walkTool(unit)
      break
    case "subagent":
      walkBlock(unit.block)
      for (const child of unit.children) walkTool(child)
      walkAgentResponse(unit.agentResponse)
      break
    case "reasoning":
    case "diff":
    case "cell":
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
  readonly descriptors: ReadonlyArray<TranscriptRenderableDescriptor>
}

export interface TranscriptUnitCacheEntry {
  readonly revision: string
  readonly bundles: ReadonlyArray<TranscriptRangeBundle>
}
