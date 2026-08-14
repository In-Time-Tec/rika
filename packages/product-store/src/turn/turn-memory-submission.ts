import { TurnResult } from "@rika/product/thread-result"
import { Effect } from "effect"
import * as ExecutionStatus from "@rika/product/execution-status"
import { QueueFull, RepositoryError } from "@rika/product/turn-repository"
import { clone } from "./turn-memory-state"
import { queueState, withQueueState } from "./turn-memory-queue-state"
import type { MemoryState, MemorySubmissionResult } from "./turn-memory-state"
import type { TurnMemoryContext } from "./turn-memory-state-operations"
import type { AgentExecutionTurn } from "@rika/product/turn-record"
import type { Interface } from "@rika/product/turn-repository"

type QueueItemChange = Effect.Success<ReturnType<Interface["dequeue"]>>

export const makeTurnMemorySubmission = ({
  modifyState,
}: TurnMemoryContext): Pick<Interface, "createForSubmission" | "copy"> => ({
  createForSubmission: Effect.fn("TurnRepository.createForSubmission")(function* (input) {
    const result = yield* modifyState((current): readonly [MemorySubmissionResult, MemoryState] => {
      if (current.turns.has(input.id)) return [{ _tag: "Duplicate" as const }, current] as const
      const active = [...current.turns.values()].some(
        (turn) =>
          TurnResult.isAgentExecution(turn) &&
          turn.threadId === input.threadId &&
          ExecutionStatus.occupiesQueue(turn.status),
      )
      const previousQueue = queueState(current, input.threadId)
      const occupiedQueueSlots =
        previousQueue.queuedCount +
        [...current.steeringAdmissions.values()].filter(
          (admission) =>
            admission.source?.threadId === input.threadId &&
            admission.sourceWithdrawn === true &&
            admission.outcome._tag !== "Rejected",
        ).length
      if (active && occupiedQueueSlots >= input.queueCapacity)
        return [
          {
            _tag: "Full" as const,
            error: QueueFull.make({
              threadId: input.threadId,
              capacity: input.queueCapacity,
              count: occupiedQueueSlots,
            }),
          },
          current,
        ] as const
      const { queueCapacity, now, ...submission } = input
      void queueCapacity
      const turn: AgentExecutionTurn = {
        _tag: "AgentExecution",
        ...submission,
        author: input.author ?? { _tag: "Human" },
        lineage: input.lineage ?? { _tag: "Original" },
        status: active ? "queued" : "accepted",
        createdAt: now,
        updatedAt: now,
      }
      const withTurn: MemoryState = { ...current, turns: new Map(current.turns).set(turn.id, clone(turn)) }
      if (turn.status !== "queued") return [{ _tag: "Created" as const, submission: clone(turn) }, withTurn] as const
      const nextQueue = {
        ...previousQueue,
        revision: previousQueue.revision + 1,
        queuedCount: previousQueue.queuedCount + 1,
      }
      const queue: QueueItemChange = {
        threadId: input.threadId,
        revision: nextQueue.revision,
        queuedCount: nextQueue.queuedCount,
        becameNonempty: nextQueue.queuedCount === 1,
        change: { _tag: "Added", turn: clone(turn) },
      }
      return [
        { _tag: "Created" as const, submission: { ...clone(turn), queue } },
        withQueueState(withTurn, input.threadId, nextQueue),
      ] as const
    })
    if (result._tag === "Duplicate") return yield* RepositoryError.make({ message: `Turn ${input.id} exists` })
    if (result._tag === "Full") return yield* result.error
    return result.submission
  }),
  copy: Effect.fn("TurnRepository.copy")(function* (turn, queueCapacity) {
    const result = yield* modifyState((current): readonly [MemorySubmissionResult, MemoryState] => {
      if (current.turns.has(turn.id)) return [{ _tag: "Duplicate" as const }, current]
      const previousQueue = queueState(current, turn.threadId)
      const occupiedQueueSlots =
        previousQueue.queuedCount +
        [...current.steeringAdmissions.values()].filter(
          (admission) =>
            admission.source?.threadId === turn.threadId &&
            admission.sourceWithdrawn === true &&
            admission.outcome._tag !== "Rejected",
        ).length
      if (turn.status === "queued" && occupiedQueueSlots >= queueCapacity)
        return [
          {
            _tag: "Full" as const,
            error: QueueFull.make({
              threadId: turn.threadId,
              capacity: queueCapacity,
              count: occupiedQueueSlots,
            }),
          },
          current,
        ] as const
      const copied = clone(turn)
      const withTurn: MemoryState = { ...current, turns: new Map(current.turns).set(copied.id, copied) }
      if (copied.status !== "queued")
        return [{ _tag: "Created" as const, submission: clone(copied) }, withTurn] as const
      const nextQueue = {
        ...previousQueue,
        revision: previousQueue.revision + 1,
        queuedCount: previousQueue.queuedCount + 1,
      }
      const queue: QueueItemChange = {
        threadId: copied.threadId,
        revision: nextQueue.revision,
        queuedCount: nextQueue.queuedCount,
        becameNonempty: nextQueue.queuedCount === 1,
        change: { _tag: "Added", turn: clone(copied) },
      }
      return [
        { _tag: "Created" as const, submission: { ...clone(copied), queue } },
        withQueueState(withTurn, copied.threadId, nextQueue),
      ] as const
    })
    if (result._tag === "Duplicate") return yield* RepositoryError.make({ message: `Turn ${turn.id} exists` })
    if (result._tag === "Full") return yield* result.error
    return result.submission
  }),
})
