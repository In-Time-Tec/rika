import type { Interface } from "@rika/product/turn-repository"
import type { Effect } from "effect"
import { ThreadId } from "@rika/product/thread-record"
import { Turn, TurnId } from "@rika/product/turn-record"
import type { StartTurn } from "@rika/product/execution-gateway"
import type { SteeringAdmission } from "@rika/product/turn-repository-steering"

type QueueItemChange = Effect.Success<ReturnType<Interface["dequeue"]>>
type Submission = Effect.Success<ReturnType<Interface["createForSubmission"]>>

export * from "./page"

export interface MemoryQueueState {
  readonly revision: number
  readonly queuedCount: number
}

export interface MemoryExecutionAdmission {
  readonly input: StartTurn
  readonly preparedAt: number
}

export interface MemoryState {
  readonly turns: ReadonlyMap<TurnId, Turn>
  readonly executionAdmissions: ReadonlyMap<TurnId, MemoryExecutionAdmission>
  readonly steeringAdmissions: ReadonlyMap<string, SteeringAdmission>
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
