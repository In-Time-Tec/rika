import type { AgentExecutionTurn } from "../turn/record"
import type { Projection } from "../transcript/page"

export type WriteResult = "committed" | "stale"

export type RefoldWriteResult =
  | { readonly _tag: "Committed"; readonly turn: AgentExecutionTurn }
  | { readonly _tag: "Stale" }

export type RecordedShellWriteResult =
  | { readonly _tag: "Committed"; readonly projection: Projection }
  | { readonly _tag: "Stale" }
