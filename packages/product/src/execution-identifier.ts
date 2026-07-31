import { Effect } from "effect"
import type { AgentProfile } from "./execution-child-run"

export interface ExecutionReference {
  readonly _tag: "ExecutionReference"
}

export const executionReference: ExecutionReference = { _tag: "ExecutionReference" }

export interface OpenRootExecution {
  readonly executionId: string
  readonly turnId: string | undefined
  readonly createdAt: number
}

export interface InvocationSource {
  readonly rootTurnId: string
  readonly threadId: string
  readonly callerProfile: AgentProfile | "Root" | "Title"
  readonly threadCreationDepth: number
}

export type TurnPromoter = (threadId: string, generation: number) => Effect.Effect<number>
