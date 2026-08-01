import { Effect } from "effect"
import * as ExecutionStatus from "@rika/product/execution-status"
import { AgentExecutionTurn, isAgentExecution } from "@rika/product/turn-record"
import { QueueFull, RepositoryError } from "@rika/product/turn-repository"
import type { Interface, QueueClaimFinish, QueueItemChange } from "@rika/product/turn-repository"
import { clone, queueState, queuedTurnUnavailable, withQueueState } from "./turn-memory-support"
import type { MemoryState, MemoryRequeueResult } from "./turn-memory-support"
import type { TurnMemoryContext } from "./turn-memory-state-operations"

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
  | "takeQueued"
  | "dequeue"
  | "requeueAccepted"
  | "requestQueueWake"
  | "consumeQueueWake"
> => ({
  readQueue: Effect.fn("TurnRepository.readQueue")(function* (threadId) {
    const current = yield* readState
    const queue = queueState(current, threadId)
    const turns = [...current.turns.values()]
      .filter(
        (turn): turn is AgentExecutionTurn =>
          isAgentExecution(turn) && turn.threadId === threadId && turn.status === "queued",
      )
      .toSorted((left, right) => left.createdAt - right.createdAt)
      .map(clone)
    return { threadId, revision: queue.revision, queuedCount: queue.queuedCount, turns }
  }),
  claimNextQueued: Effect.fn("TurnRepository.claimNextQueued")(function* (threadId, _now) {
    return yield* modifyState((current) => {
      const hasActive = [...current.turns.values()].some(
        (turn) => isAgentExecution(turn) && turn.threadId === threadId && ExecutionStatus.isActiveStatus(turn.status),
      )
      const queued = [...current.turns.values()]
        .filter(
          (turn): turn is AgentExecutionTurn =>
            isAgentExecution(turn) &&
            turn.threadId === threadId &&
            turn.status === "queued" &&
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
  finishQueuedClaim: Effect.fn("TurnRepository.finishQueuedClaim")(
    function* (claim, status, lastCursor, extensionPin, now) {
      return yield* modifyState((current): readonly [QueueClaimFinish, MemoryState] => {
        const existing = current.turns.get(claim.turn.id)
        if (
          existing === undefined ||
          !isAgentExecution(existing) ||
          existing.status !== "queued" ||
          current.claims.get(claim.turn.id) !== claim.token
        )
          return [{ _tag: "Unavailable" }, current]
        const { lastCursor: previousCursor, ...withoutCursor } = existing
        void previousCursor
        const nextTurn: AgentExecutionTurn = {
          ...withoutCursor,
          status,
          ...(lastCursor === undefined ? {} : { lastCursor }),
          ...(extensionPin === undefined ? {} : { extensionPin: structuredClone(extensionPin) }),
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
    },
  ),
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
  takeQueued: Effect.fn("TurnRepository.takeQueued")(function* (id) {
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
      return [{ turn: clone(turn), queue }, withQueueState({ ...current, turns, claims }, turn.threadId, nextQueue)]
    })
    if (result === undefined) return yield* queuedTurnUnavailable(id)
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
          isAgentExecution(candidate) &&
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
  requestQueueWake: Effect.fn("TurnRepository.requestQueueWake")(function* (threadId) {
    return yield* modifyState((current) => {
      const queue = queueState(current, threadId)
      if (queue.queuedCount === 0) return [undefined, current]
      if (queue.wakePending)
        return [{ threadId, generation: queue.wakeGeneration, queueRevision: queue.revision }, current]
      const next = { ...queue, wakeGeneration: queue.wakeGeneration + 1, wakePending: true }
      return [
        { threadId, generation: next.wakeGeneration, queueRevision: next.revision },
        withQueueState(current, threadId, next),
      ]
    })
  }),
  consumeQueueWake: Effect.fn("TurnRepository.consumeQueueWake")(function* (threadId, generation) {
    return yield* modifyState((current) => {
      const queue = queueState(current, threadId)
      if (!queue.wakePending || queue.wakeGeneration !== generation) return [false, current]
      return [true, withQueueState(current, threadId, { ...queue, wakePending: false })]
    })
  }),
})
