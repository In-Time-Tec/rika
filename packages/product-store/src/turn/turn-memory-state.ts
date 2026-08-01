import { Schema } from "effect"
import { ThreadId } from "@rika/product/thread-record"
import { Turn, TurnId } from "@rika/product/turn-record"
import { defaultPageSize, maximumPageSize } from "@rika/product/turn-repository"
import type { QueueItemChange, Submission, PageCursor } from "@rika/product/turn-repository"

export const clone = <T extends Turn>(turn: T): T => structuredClone(turn)
export const sameTurn = Schema.toEquivalence(Turn)
export const pageSize = (limit: number | undefined) =>
  Math.min(maximumPageSize, Math.max(1, Math.floor(limit ?? defaultPageSize)))
export const cursorFor = (turn: Turn | undefined): PageCursor | undefined =>
  turn === undefined ? undefined : { createdAt: turn.createdAt, id: turn.id }

export interface MemoryQueueState {
  readonly revision: number
  readonly queuedCount: number
  readonly wakeGeneration: number
  readonly wakePending: boolean
}

export interface MemoryState {
  readonly turns: ReadonlyMap<TurnId, Turn>
  readonly queues: ReadonlyMap<ThreadId, MemoryQueueState>
  readonly claims: ReadonlyMap<TurnId, string>
  readonly nextClaimToken: number
}

export type MemorySubmissionResult =
  | { readonly _tag: "Duplicate" }
  | { readonly _tag: "Full"; readonly error: import("@rika/product/turn-repository").QueueFull }
  | { readonly _tag: "Created"; readonly submission: Submission }

export type MemoryRequeueResult =
  | { readonly _tag: "Unavailable" }
  | { readonly _tag: "Full"; readonly error: import("@rika/product/turn-repository").QueueFull }
  | {
      readonly _tag: "Queued"
      readonly value: import("@rika/product/turn-record").AgentExecutionTurn & { readonly queue: QueueItemChange }
    }
