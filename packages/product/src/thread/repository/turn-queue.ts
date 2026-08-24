import type { AgentExecutionTurn } from "../turn/record"
import type { ThreadId } from "../model/record"
import type { TurnId } from "../turn/record"

export interface QueueSnapshot {
  readonly threadId: ThreadId
  readonly revision: number
  readonly queuedCount: number
  readonly turns: ReadonlyArray<AgentExecutionTurn>
}

export interface QueueItemChange {
  readonly threadId: ThreadId
  readonly revision: number
  readonly queuedCount: number
  readonly becameNonempty: boolean
  readonly change:
    | { readonly _tag: "Added"; readonly turn: AgentExecutionTurn; readonly position?: number }
    | { readonly _tag: "Updated"; readonly turn: AgentExecutionTurn }
    | { readonly _tag: "Removed"; readonly turnId: TurnId }
}

export type Submission = AgentExecutionTurn & { readonly queue?: QueueItemChange }

export interface QueueClaim {
  readonly turn: AgentExecutionTurn
  readonly token: string
}

export type QueueClaimFinish =
  | { readonly _tag: "Transitioned"; readonly turn: AgentExecutionTurn; readonly queue: QueueItemChange }
  | { readonly _tag: "Unavailable" }
