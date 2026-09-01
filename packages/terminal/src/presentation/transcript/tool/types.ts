import type { AgentResponseState, ToolGroupKind } from "./kinds"

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
export type SubagentGroupTranscriptUnit = {
  readonly kind: "subagent-group"
  readonly block: number
  readonly children: ReadonlyArray<NestedTranscriptUnit>
}
export type NestedTranscriptUnit = ToolTranscriptUnit | SubagentTranscriptUnit | SubagentGroupTranscriptUnit
export type TranscriptUnit =
  | { readonly kind: "entry"; readonly entry: number }
  | ToolTranscriptUnit
  | { readonly kind: "reasoning"; readonly block: number }
  | { readonly kind: "diff"; readonly block: number }
  | SubagentTranscriptUnit
  | SubagentGroupTranscriptUnit
  | { readonly kind: "block"; readonly block: number }
export type TranscriptUnitId = string

export type { AgentOutcome, AgentResponseState } from "./kinds"
