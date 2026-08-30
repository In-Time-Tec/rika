import { Option, Schema } from "effect"
import { Block } from "@rika/transcript/transcript-presentation-model"
import type { Model } from "../../../state/model"
import { toolDetails } from "../../../presentation/transcript/tool/detail"
import type {
  AgentOutcome,
  AgentResponseState,
  ToolTranscriptUnit,
  TranscriptUnit,
} from "../../../presentation/transcript/tool/types"
import { toolUnitsFor } from "../tool/detail"
import type { TranscriptUnitBuild } from "../transcript/window"

export interface TranscriptUnitBuilder {
  (spinnerFrame: string): (model: Model) => TranscriptUnitRenderer
  (model: Model, spinnerFrame: string): TranscriptUnitRenderer
}

type TranscriptUnitRenderer = {
  readonly renderUnit: (unit: TranscriptUnit) => TranscriptUnitBuild
  readonly isUnitVisible: (unit: TranscriptUnit) => boolean
}

const blockAt = (model: Model, index: number) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(Block)(model.blocks[index]))

const animated = (model: Model, unit: TranscriptUnit): boolean => {
  if (unit.kind === "tool") return toolUnitsFor(model, unit.blocks).some((tool) => tool.block.status === "running")
  const block = unit.kind === "subagent" || unit.kind === "cell" ? blockAt(model, unit.block) : undefined
  if (block?._tag === "SubagentCard")
    return block.status === "running" || block.status === "waiting" || block.status === "cancelling"
  return block?._tag === "Cell" && block.status === "running"
}

const targets = (model: Model, unit: TranscriptUnit) => {
  if (unit.kind === "tool")
    return toolDetails(model, unit).flatMap((detail) => (detail.target === undefined ? [] : [detail.target]))
  if (unit.kind !== "diff") return undefined
  const block = blockAt(model, unit.block)
  return block?._tag === "Diff" ? [{ path: block.path }] : undefined
}

const agentOutcome = (state: AgentResponseState): AgentOutcome =>
  state._tag === "Streaming" ? { kind: "answer", entry: state.answer } : state.outcome

const nestedToolExpandable = (
  unit: ToolTranscriptUnit,
  agent: boolean,
  running: boolean,
  detail: string,
  output: string | undefined,
) =>
  (unit.children?.length ?? 0) > 0 ||
  unit.agentResponse !== undefined ||
  (agent && (running || detail.length > 0)) ||
  (output?.length ?? 0) > 0

export const bodyContent = { agentOutcome, animated, nestedToolExpandable, targets }
