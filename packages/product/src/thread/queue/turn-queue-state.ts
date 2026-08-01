import { Schema } from "effect"
import { ThreadId } from "../model/thread-record"
import { AgentExecutionTurn, Turn, TurnId } from "../model/turn-record"

export const PageCursor = Schema.Struct({ createdAt: Schema.Finite, id: TurnId })
export interface PageCursor extends Schema.Schema.Type<typeof PageCursor> {}

export interface PageOptions {
  readonly before?: PageCursor | undefined
  readonly limit?: number
}

export interface PageResult {
  readonly turns: ReadonlyArray<Turn>
  readonly hasOlder: boolean
  readonly oldestCursor: PageCursor | undefined
  readonly newestCursor: PageCursor | undefined
}

export interface QueueSnapshot {
  readonly threadId: ThreadId
  readonly revision: number
  readonly queuedCount: number
  readonly turns: ReadonlyArray<AgentExecutionTurn>
}

export interface QueueWake {
  readonly threadId: ThreadId
  readonly generation: number
  readonly queueRevision: number
}
