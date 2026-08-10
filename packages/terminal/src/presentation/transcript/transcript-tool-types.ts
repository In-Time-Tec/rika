import type { AgentResponseState, ToolGroupKind } from "./transcript-tool-kinds"

export type ToolTranscriptUnit = {
  readonly kind: "tool"
  readonly group: ToolGroupKind
  readonly blocks: ReadonlyArray<number>
  readonly diffs: ReadonlyArray<number>
  readonly children?: ReadonlyArray<NestedTranscriptUnit>
  readonly agentResponse?: AgentResponseState
}
export type SubagentTranscriptUnit = {
  readonly kind: "subagent"
  readonly block: number
  readonly children: ReadonlyArray<NestedTranscriptUnit>
  readonly agentResponse?: AgentResponseState
}
export type CellTranscriptUnit = {
  readonly kind: "cell"
  readonly block: number
}
export type NestedTranscriptUnit = ToolTranscriptUnit | CellTranscriptUnit
export type TranscriptUnit =
  | { readonly kind: "entry"; readonly entry: number }
  | ToolTranscriptUnit
  | { readonly kind: "reasoning"; readonly block: number }
  | { readonly kind: "diff"; readonly block: number }
  | SubagentTranscriptUnit
  | CellTranscriptUnit
  | { readonly kind: "block"; readonly block: number }
export type TranscriptUnitId = string

export type { AgentOutcome, AgentResponseState } from "./transcript-tool-kinds"
