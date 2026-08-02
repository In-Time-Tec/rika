import { Schema } from "effect"
import { ThreadId } from "../model/thread-record"
import { TurnId } from "../model/turn-record"

export const ResultDelivery = Schema.Literals([
  "awaiting-result",
  "ready",
  "delivered",
  "failed",
  "cancelled",
  "source-unavailable",
])
export type ResultDelivery = typeof ResultDelivery.Type

export type RootResult =
  | { readonly status: "completed"; readonly cursor: string; readonly sequence: number; readonly output: string }
  | { readonly status: "failed"; readonly cursor: string; readonly sequence: number; readonly reason?: string }
  | { readonly status: "cancelled"; readonly cursor?: string; readonly sequence?: number; readonly reason?: string }

interface ResultRouteBase {
  readonly targetTurnId: TurnId
  readonly kind: "manual" | "reply"
  readonly sourceThreadId?: ThreadId
  readonly sourceTurnId?: TurnId
  readonly createdAt: number
  readonly updatedAt: number
}

export type ResultRoute =
  | (ResultRouteBase & { readonly delivery: "awaiting-result" | "failed" | "cancelled" })
  | (ResultRouteBase & { readonly delivery: "ready"; readonly readySequence: number })
  | (ResultRouteBase & {
      readonly delivery: "delivered" | "source-unavailable"
      readonly readySequence: number
      readonly deliveredTurnId?: TurnId
    })

export interface ResultRouteCursor {
  readonly targetTurnId: TurnId
}

export interface AcceptedThreadTurn {
  readonly threadId: ThreadId
  readonly turnId: TurnId
  readonly status: "accepted" | "queued"
  readonly queueRevision?: number
}
