import type { Interface } from "@rika/product/turn-repository"
import { Effect, Schema } from "effect"
import { ThreadId } from "@rika/product/thread-record"
import { Turn, TurnId } from "@rika/product/turn-record"
import { defaultPageSize, maximumPageSize } from "@rika/product/turn-repository"
import { PageCursor as PageCursorSchema } from "@rika/product/turn-repository"
type PageCursor = typeof PageCursorSchema.Type

type QueueItemChange = Effect.Success<ReturnType<Interface["dequeue"]>>
type Submission = Effect.Success<ReturnType<Interface["createForSubmission"]>>

export const clone = <T extends Turn>(turn: T): T => structuredClone(turn)
const turnEquivalence = Schema.toEquivalence(Turn)

function sameTurnImplementation(left: Turn, right: Turn): boolean
function sameTurnImplementation(right: Turn): (left: Turn) => boolean
function sameTurnImplementation(leftOrRight: Turn, right?: Turn): boolean | ((left: Turn) => boolean) {
  if (right === undefined) return (left) => sameTurnImplementation(left, leftOrRight)
  return turnEquivalence(leftOrRight, right)
}

export const sameTurn: {
  (left: Turn, right: Turn): boolean
  (right: Turn): (left: Turn) => boolean
} = sameTurnImplementation
export const pageSize = (limit: number | undefined) =>
  Math.min(maximumPageSize, Math.max(1, Math.floor(limit ?? defaultPageSize)))
export const cursorFor = (turn: Turn | undefined): PageCursor | undefined =>
  turn === undefined ? undefined : { createdAt: turn.createdAt, id: turn.id }

export interface MemoryQueueState {
  readonly revision: number
  readonly queuedCount: number
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
