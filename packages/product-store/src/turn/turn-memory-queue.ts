import { TurnResult } from "@rika/product/thread-result"
import { Effect } from "effect"
import * as ExecutionStatus from "@rika/product/execution-status"
import { AgentExecutionTurn } from "@rika/product/turn-record"
import { QueueFull, RepositoryError } from "@rika/product/turn-repository"
import type { Interface } from "@rika/product/turn-repository"
import { clone } from "./turn-memory-state"
import { queueState, withQueueState } from "./turn-memory-queue-state"
import type { MemoryState, MemoryRequeueResult } from "./turn-memory-state"
import type { TurnMemoryContext } from "./turn-memory-state-operations"

type QueueClaimFinish = Effect.Success<ReturnType<Interface["finishQueuedClaim"]>>
type QueueItemChange = Effect.Success<ReturnType<Interface["dequeue"]>>

export const makeTurnMemoryQueue = ({
  readState,
  modifyState,
  updateState,
}: TurnMemoryContext): Pick<
  Interface,
  | "readQueue"
  | "claimNextQueued"
  | "finishQueuedClaim"
  | "releaseQueuedClaim"
  | "resetQueueClaims"
  | "editQueued"
  | "dequeue"
  | "requeueAccepted"
> => ({
  readQueue: Effect.fn("TurnRepository.readQueue")(function* (threadId) {
    const current = yield* readState
    const queue = queueState(current, threadId)
    const steering = new Map(
      [...current.steeringAdmissions.values()]
        .filter((admission) => admission.source !== undefined && admission.outcome._tag !== "Rejected")
        .map((admission) => [String(admission.source!.id), admission] as const),
    )
    const turns = [...current.turns.values()]
      .filter(
        (turn): turn is AgentExecutionTurn =>
          TurnResult.isAgentExecution(turn) && turn.threadId === threadId && turn.status === "queued",
      )
      .toSorted((left, right) => left.createdAt - right.createdAt)
      .map((turn) => (steering.has(String(turn.id)) ? { ...clone(turn), delivery: "steer" as const } : clone(turn)))
    return { threadId, revision: queue.revision, queuedCount: queue.queuedCount, turns }
  }),
  claimNextQueued: Effect.fn("TurnRepository.claimNextQueued")(function* (threadId, _now) {
    return yield* modifyState((current) => {
      const hasActive = [...current.turns.values()].some(
        (turn) =>
          TurnResult.isAgentExecution(turn) &&
          turn.threadId === threadId &&
          ExecutionStatus.isActiveStatus(turn.status),
      )
      const queued = [...current.turns.values()]
        .filter(
          (turn): turn is AgentExecutionTurn =>
            TurnResult.isAgentExecution(turn) &&
            turn.threadId === threadId &&
            turn.status === "queued" &&
            turn.delivery !== "steer" &&
            !current.claims.has(turn.id),
        )
        .toSorted((left, right) => left.createdAt - right.createdAt)[0]
      const hasClaim = [...current.claims.keys()].some((id) => current.turns.get(id)?.threadId === threadId)
      if (hasActive || hasClaim || queued === undefined) return [undefined, current]
      const token = String(current.nextClaimToken)
      return [
        { turn: clone(queued), token },
        {
          ...current,
          claims: new Map(current.claims).set(queued.id, token),
          nextClaimToken: current.nextClaimToken + 1,
        },
      ]
    })
  }),
  finishQueuedClaim: Effect.fn("TurnRepository.finishQueuedClaim")(function* (claim, status, now) {
    return yield* modifyState((current): readonly [QueueClaimFinish, MemoryState] => {
      const existing = current.turns.get(claim.turn.id)
      if (
        existing === undefined ||
        !TurnResult.isAgentExecution(existing) ||
        existing.status !== "queued" ||
        current.claims.get(claim.turn.id) !== claim.token
      )
        return [{ _tag: "Unavailable" }, current]
      const nextTurn: AgentExecutionTurn = {
        ...existing,
        status,
        updatedAt: now,
      }
      const previousQueue = queueState(current, existing.threadId)
      const nextQueue = {
        ...previousQueue,
        revision: previousQueue.revision + 1,
        queuedCount: Math.max(0, previousQueue.queuedCount - 1),
      }
      const queue: QueueItemChange = {
        threadId: existing.threadId,
        revision: nextQueue.revision,
        queuedCount: nextQueue.queuedCount,
        becameNonempty: false,
        change: { _tag: "Removed", turnId: existing.id },
      }
      const claims = new Map(current.claims)
      claims.delete(existing.id)
      return [
        { _tag: "Transitioned", turn: clone(nextTurn), queue },
        withQueueState(
          { ...current, turns: new Map(current.turns).set(existing.id, nextTurn), claims },
          existing.threadId,
          nextQueue,
        ),
      ]
    })
  }),
  releaseQueuedClaim: Effect.fn("TurnRepository.releaseQueuedClaim")(function* (claim) {
    yield* updateState((current) => {
      if (current.claims.get(claim.turn.id) !== claim.token) return current
      const claims = new Map(current.claims)
      claims.delete(claim.turn.id)
      return { ...current, claims }
    })
  }),
  resetQueueClaims: updateState((current) => ({ ...current, claims: new Map() })),
  editQueued: Effect.fn("TurnRepository.editQueued")(function* (id, prompt, now) {
    const result = yield* modifyState((current) => {
      const turn = current.turns.get(id)
      if (turn === undefined || turn.status !== "queued") return [undefined, current]
      const { promptParts: _promptParts, ...withoutParts } = turn
      void _promptParts
      const nextTurn = { ...withoutParts, prompt, updatedAt: now }
      const claims = new Map(current.claims)
      claims.delete(id)
      const previousQueue = queueState(current, turn.threadId)
      const nextQueue = { ...previousQueue, revision: previousQueue.revision + 1 }
      const queue: QueueItemChange = {
        threadId: turn.threadId,
        revision: nextQueue.revision,
        queuedCount: nextQueue.queuedCount,
        becameNonempty: false,
        change: { _tag: "Updated", turn: clone(nextTurn) },
      }
      return [
        { ...clone(nextTurn), queue },
        withQueueState(
          { ...current, turns: new Map(current.turns).set(id, nextTurn), claims },
          turn.threadId,
          nextQueue,
        ),
      ]
    })
    if (result === undefined) return yield* RepositoryError.make({ message: `Turn ${id} is not queued` })
    return result
  }),
  dequeue: Effect.fn("TurnRepository.dequeue")(function* (id) {
    const result = yield* modifyState((current) => {
      const turn = current.turns.get(id)
      if (turn === undefined || turn.status !== "queued") return [undefined, current]
      const turns = new Map(current.turns)
      turns.delete(id)
      const claims = new Map(current.claims)
      claims.delete(id)
      const previousQueue = queueState(current, turn.threadId)
      const nextQueue = {
        ...previousQueue,
        revision: previousQueue.revision + 1,
        queuedCount: Math.max(0, previousQueue.queuedCount - 1),
      }
      const queue: QueueItemChange = {
        threadId: turn.threadId,
        revision: nextQueue.revision,
        queuedCount: nextQueue.queuedCount,
        becameNonempty: false,
        change: { _tag: "Removed", turnId: id },
      }
      return [queue, withQueueState({ ...current, turns, claims }, turn.threadId, nextQueue)]
    })
    if (result === undefined) return yield* RepositoryError.make({ message: `Turn ${id} is not queued` })
    return result
  }),
  requeueAccepted: Effect.fn("TurnRepository.requeueAccepted")(function* (id, queueCapacity, now) {
    const result = yield* modifyState((current): readonly [MemoryRequeueResult, MemoryState] => {
      const turn = current.turns.get(id)
      if (turn === undefined || turn.status !== "accepted") return [{ _tag: "Unavailable" as const }, current]
      const hasOtherActive = [...current.turns.values()].some(
        (candidate) =>
          TurnResult.isAgentExecution(candidate) &&
          candidate.id !== id &&
          candidate.threadId === turn.threadId &&
          ExecutionStatus.isActiveStatus(candidate.status),
      )
      if (hasOtherActive) return [{ _tag: "Unavailable" as const }, current]
      const previousQueue = queueState(current, turn.threadId)
      if (previousQueue.queuedCount >= queueCapacity)
        return [
          {
            _tag: "Full" as const,
            error: QueueFull.make({
              threadId: turn.threadId,
              capacity: queueCapacity,
              count: previousQueue.queuedCount,
            }),
          },
          current,
        ]
      const queued = { ...turn, status: "queued" as const, updatedAt: now }
      const nextQueue = {
        ...previousQueue,
        revision: previousQueue.revision + 1,
        queuedCount: previousQueue.queuedCount + 1,
      }
      const queue: QueueItemChange = {
        threadId: turn.threadId,
        revision: nextQueue.revision,
        queuedCount: nextQueue.queuedCount,
        becameNonempty: nextQueue.queuedCount === 1,
        change: { _tag: "Added", turn: clone(queued) },
      }
      return [
        { _tag: "Queued" as const, value: { ...clone(queued), queue } },
        withQueueState({ ...current, turns: new Map(current.turns).set(id, queued) }, turn.threadId, nextQueue),
      ]
    })
    if (result._tag === "Unavailable")
      return yield* RepositoryError.make({ message: `Turn ${id} is not an unowned accepted turn` })
    if (result._tag === "Full") return yield* result.error
    return result.value
  }),
})
