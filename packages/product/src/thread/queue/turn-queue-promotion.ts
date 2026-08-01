import { ThreadId } from "../model/thread-record"
import { AgentExecutionTurn, TurnId } from "../model/turn-record"

export interface QueueItemChange {
  readonly threadId: ThreadId
  readonly revision: number
  readonly queuedCount: number
  readonly becameNonempty: boolean
  readonly change:
    | { readonly _tag: "Added"; readonly turn: AgentExecutionTurn }
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

export interface QueuedTurnTake {
  readonly turn: AgentExecutionTurn
  readonly queue: QueueItemChange
}
