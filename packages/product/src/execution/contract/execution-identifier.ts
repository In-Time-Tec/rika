import { Effect } from "effect"

const executionNamespacePrefixes = ["execution:", "child:", "workflow:"] as const

const isExecutionNamespace = (value: string): boolean =>
  executionNamespacePrefixes.some((prefix) => value.startsWith(prefix))

const executionKey = (value: string): string => value.replace(/^execution:/, "")

const ownsExecution = (turnId: string, executionId: string): boolean => executionKey(executionId) === turnId

export const ExecutionId = { executionKey, isExecutionNamespace, ownsExecution }
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
