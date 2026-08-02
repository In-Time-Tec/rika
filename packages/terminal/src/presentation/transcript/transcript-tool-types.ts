export type ToolGroupKind = "explore" | "edit" | "shell" | "other"
export type ToolKind = "read" | "search" | "edit" | "shell" | "other"
export type AgentOutcome =
  | { readonly kind: "answer"; readonly entry: number }
  | { readonly kind: "error"; readonly text: string; readonly tone: "failed" | "cancelled" | "info" }
export type AgentResponseState =
  | { readonly _tag: "Streaming"; readonly answer: number }
  | { readonly _tag: "Settled"; readonly outcome: AgentOutcome }
export type ToolTranscriptUnit = {
  readonly kind: "tool"
  readonly group: ToolGroupKind
  readonly blocks: ReadonlyArray<number>
  readonly diffs: ReadonlyArray<number>
  readonly children?: ReadonlyArray<ToolTranscriptUnit>
  readonly agentResponse?: AgentResponseState
}
export type TranscriptUnit =
  | { readonly kind: "entry"; readonly entry: number }
  | ToolTranscriptUnit
  | { readonly kind: "reasoning"; readonly block: number }
  | { readonly kind: "diff"; readonly block: number }
  | { readonly kind: "childAgent"; readonly block: number }
  | { readonly kind: "block"; readonly block: number }
export type TranscriptUnitId = string
