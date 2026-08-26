export type ToolGroupKind = "explore" | "edit" | "shell" | "other"
export type ToolKind = "read" | "search" | "edit" | "shell" | "other"
export type AgentOutcome =
  | { readonly kind: "answer"; readonly entry: number }
  | { readonly kind: "error"; readonly text: string; readonly tone: "failed" | "cancelled" | "info" }
export type AgentResponseState =
  | { readonly _tag: "Streaming"; readonly answer: number }
  | { readonly _tag: "Settled"; readonly outcome: AgentOutcome }
