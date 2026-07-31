import { Effect } from "effect"

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
  readonly callerProfile: string
  readonly threadCreationDepth: number
}
export type TurnPromoter = (threadId: string, generation: number) => Effect.Effect<number>
