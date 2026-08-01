import { ThreadId } from "../model/thread-record"
import { TurnId } from "../model/turn-record"
import type { RootResult } from "./thread-interaction-result"

export interface DeliverThreadResultInput {
  readonly targetTurnId: TurnId
  readonly deliveredTurnId: TurnId
  readonly queueCapacity: number
  readonly now: number
}

export interface SettleThreadResultInput {
  readonly targetTurnId: TurnId
  readonly result: RootResult
  readonly now: number
}

export interface BoundThreadControl {
  readonly targetThreadId: ThreadId
  readonly targetTurnId?: TurnId
  readonly outcome: "bound" | "no-active" | "already-terminal"
  readonly queueRevision?: number
  readonly stoppedTurnIds?: ReadonlyArray<TurnId>
}

export interface DeliveredThreadResult {
  readonly targetTurnId: TurnId
  readonly delivery: "delivered" | "source-unavailable"
  readonly deliveredTurnId?: TurnId
}
