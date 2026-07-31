import { Service } from "@rika/product/turn-repository"
import { decodeStoredTurn, ExtensionPinJson } from "./turn-row-codec"
import { clone, cursorFor, emptyQueueState, isTerminalStatus, memoryCoordinator, MemoryCoordinatorTypeId, missing, pageSize, queuedTurnUnavailable, queueState, repositoryError, sameTurn, withQueueState } from "./turn-memory-support"
import type { MemoryCoordinator, MemoryQueueState, MemoryRefoldWrite, MemoryRequeueResult, MemoryState, MemorySubmissionResult } from "./turn-memory-support"
export { Service }
import { Effect, Layer, Ref, Schema, Semaphore } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { ThreadId } from "@rika/product/thread-record"
import * as ExecutionStatus from "@rika/product/execution-status"
import { AgentExecutionTurn, ExecutionExtensionPin, ExecutionRoutePin, PromptPart, RecordedShellTurn, Status, StopIntent, Turn, TurnAuthor, TurnId, TurnLineage, isAgentExecution, isRunningRecordedShell } from "@rika/product/turn-record"
import type { RunningRecordedShellTurn } from "@rika/product/turn-record"
export { RepositoryError, QueueFull, QueuedTurnUnavailable } from "@rika/product/turn-repository"
import { RepositoryError, QueueFull, QueuedTurnUnavailable } from "@rika/product/turn-repository"
export interface CreateInput {
  readonly id: TurnId
  readonly threadId: ThreadId
  readonly prompt: string
  readonly promptParts?: ReadonlyArray<PromptPart>
  readonly executionRoute: ExecutionRoutePin
  readonly reviewFanOutId?: string
  readonly author?: TurnAuthor
  readonly lineage?: TurnLineage
  readonly queueCapacity: number
  readonly now: number
}
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
export interface QueueItemChange {
  readonly threadId: ThreadId
  readonly revision: number
  readonly queuedCount: number
  readonly becameNonempty: boolean
  readonly change: { readonly _tag: "Added"; readonly turn: AgentExecutionTurn } | { readonly _tag: "Updated"; readonly turn: AgentExecutionTurn } | { readonly _tag: "Removed"; readonly turnId: TurnId }
}
export interface QueueSnapshot {
  readonly threadId: ThreadId
  readonly revision: number
  readonly queuedCount: number
  readonly turns: ReadonlyArray<AgentExecutionTurn>
}
export type Submission = AgentExecutionTurn & { readonly queue?: QueueItemChange }
export interface QueueClaim {
  readonly turn: AgentExecutionTurn
  readonly token: string
}
export type QueueClaimFinish = { readonly _tag: "Transitioned"; readonly turn: AgentExecutionTurn; readonly queue: QueueItemChange } | { readonly _tag: "Unavailable" }
export interface QueuedTurnTake {
  readonly turn: AgentExecutionTurn
  readonly queue: QueueItemChange
}
export interface QueueWake {
  readonly threadId: ThreadId
  readonly generation: number
  readonly queueRevision: number
}
export const defaultPageSize = 50
export const maximumPageSize = 200
export interface Interface {
  readonly createForSubmission: (input: CreateInput) => Effect.Effect<Submission, RepositoryError | QueueFull>
  readonly copy: (turn: AgentExecutionTurn, queueCapacity: number) => Effect.Effect<Submission, RepositoryError | QueueFull>
  readonly get: (id: TurnId) => Effect.Effect<Turn | undefined, RepositoryError>
  readonly list: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<Turn>, RepositoryError>
  readonly listRecentNonqueued: (threadId: ThreadId, limit: number) => Effect.Effect<ReadonlyArray<Turn>, RepositoryError>
  readonly page: (threadId: ThreadId, options?: PageOptions) => Effect.Effect<PageResult, RepositoryError>
  readonly findActive: (threadId: ThreadId) => Effect.Effect<AgentExecutionTurn | undefined, RepositoryError>
  readonly readQueue: (threadId: ThreadId) => Effect.Effect<QueueSnapshot, RepositoryError>
  readonly listNonterminal: Effect.Effect<ReadonlyArray<AgentExecutionTurn>, RepositoryError>
  readonly listStopRequested: Effect.Effect<ReadonlyArray<AgentExecutionTurn>, RepositoryError>
  readonly requestStop: (id: TurnId, now: number) => Effect.Effect<AgentExecutionTurn | undefined, RepositoryError>
  readonly claimNextQueued: (threadId: ThreadId, now: number) => Effect.Effect<QueueClaim | undefined, RepositoryError>
  readonly finishQueuedClaim: (claim: QueueClaim, status: "running" | "failed", lastCursor: string | undefined, extensionPin: ExecutionExtensionPin | undefined, now: number) => Effect.Effect<QueueClaimFinish, RepositoryError>
  readonly releaseQueuedClaim: (claim: QueueClaim) => Effect.Effect<void, RepositoryError>
  readonly resetQueueClaims: Effect.Effect<void, RepositoryError>
  readonly editQueued: (id: TurnId, prompt: string, now: number) => Effect.Effect<AgentExecutionTurn & { readonly queue: QueueItemChange }, RepositoryError>
  readonly takeQueued: (id: TurnId) => Effect.Effect<QueuedTurnTake, RepositoryError | QueuedTurnUnavailable>
  readonly dequeue: (id: TurnId) => Effect.Effect<QueueItemChange, RepositoryError>
  readonly requeueAccepted: (id: TurnId, queueCapacity: number, now: number) => Effect.Effect<AgentExecutionTurn & { readonly queue: QueueItemChange }, RepositoryError | QueueFull>
  readonly requestQueueWake: (threadId: ThreadId) => Effect.Effect<QueueWake | undefined, RepositoryError>
  readonly consumeQueueWake: (threadId: ThreadId, generation: number) => Effect.Effect<boolean, RepositoryError>
  readonly setExtensionPin: (id: TurnId, pin: ExecutionExtensionPin) => Effect.Effect<AgentExecutionTurn, RepositoryError>
  readonly setStatus: (id: TurnId, status: Status, lastCursor: string | undefined, now: number) => Effect.Effect<AgentExecutionTurn, RepositoryError>
  readonly startAccepted: (id: TurnId, now: number) => Effect.Effect<boolean, RepositoryError>
  readonly cancelAccepted: (id: TurnId, now: number) => Effect.Effect<boolean, RepositoryError>
  readonly repairCursor: (id: TurnId, status: Status, expectedCursor: string | undefined, cursor: string | undefined) => Effect.Effect<boolean, RepositoryError>
}
export const makeMemory = (initial: ReadonlyArray<Turn> = []) =>
  Effect.gen(function* () {
    const initialTurns = new Map(initial.map((turn) => [turn.id, clone(turn)]))
    const initialQueues = new Map<ThreadId, MemoryQueueState>()
    for (const turn of initialTurns.values()) {
      if (!isAgentExecution(turn) || turn.status !== "queued") continue
      const current = initialQueues.get(turn.threadId) ?? emptyQueueState
      initialQueues.set(turn.threadId, {
        ...current,
        queuedCount: current.queuedCount + 1,
        revision: current.revision + 1,
      })
    }
    const state = yield* Ref.make<MemoryState>({
      turns: initialTurns,
      queues: initialQueues,
      claims: new Map(),
      nextClaimToken: 1,
    })
    const admission = yield* Semaphore.make(1)
    const withLock: MemoryCoordinator["withLock"] = (effect) => admission.withPermits(1)(Effect.uninterruptible(effect))
    const readState = withLock(Ref.get(state))
    const modifyState = <A>(f: (state: MemoryState) => readonly [A, MemoryState]) => withLock(Ref.modify(state, f))
    const updateState = (f: (state: MemoryState) => MemoryState) => withLock(Ref.update(state, f))
    const agentExecutions: MemoryCoordinator["agentExecutions"] = Ref.get(state).pipe(Effect.map((current) => [...current.turns.values()].filter(isAgentExecution).map(clone)))
    const adoptRefold: MemoryCoordinator["adoptRefold"] = (expected, status, cursor, write) =>
      withLock(
        Effect.gen(function* () {
          const currentState = yield* Ref.get(state)
          const current = currentState.turns.get(expected.id)
          if (current === undefined || !isAgentExecution(current) || current.status !== expected.status || current.lastCursor !== expected.lastCursor) return { _tag: "Stale" as const }
          const next: AgentExecutionTurn = { ...current, status, lastCursor: cursor }
          const written = yield* write(clone(next))
          if (written._tag === "Stale") return written
          yield* Ref.set(state, {
            ...currentState,
            turns: new Map(currentState.turns).set(expected.id, next),
          })
          return { _tag: "Committed" as const, turn: clone(next), value: written.value }
        }),
      )
    const writeRecordedShell: MemoryCoordinator["writeRecordedShell"] = (expected, turn, write) =>
      withLock(
        Effect.gen(function* () {
          const currentState = yield* Ref.get(state)
          const current = currentState.turns.get(turn.id)
          if (expected === undefined) {
            if (current !== undefined) return { _tag: "Stale" as const }
          } else if (current === undefined || !isRunningRecordedShell(current) || !isRunningRecordedShell(expected) || !sameTurn(current, expected) || isRunningRecordedShell(turn) || turn.threadId !== current.threadId || turn.prompt !== current.prompt || turn.command !== current.command || turn.createdAt !== current.createdAt) {
            return { _tag: "Stale" as const }
          }
          const written = yield* write(clone(turn))
          if (written._tag === "Stale") return written
          yield* Ref.set(state, {
            ...currentState,
            turns: new Map(currentState.turns).set(turn.id, clone(turn)),
          })
          return {
            _tag: "Commit" as const,
            value: { turn: clone(turn), value: written.value },
          }
        }),
      )
    const get = Effect.fn("TurnRepository.get")(function* (id: TurnId) {
      const turn = (yield* readState).turns.get(id)
      return turn === undefined ? undefined : clone(turn)
    })
    return Service.of({
      [MemoryCoordinatorTypeId]: {
        withLock,
        agentExecutions,
        adoptRefold,
        writeRecordedShell,
      } satisfies MemoryCoordinator,
      createForSubmission: Effect.fn("TurnRepository.createForSubmission")(function* (input) {
        const result = yield* modifyState((current): readonly [MemorySubmissionResult, MemoryState] => {
          if (current.turns.has(input.id)) return [{ _tag: "Duplicate" as const }, current] as const
          const active = [...current.turns.values()].some((turn) => isAgentExecution(turn) && turn.threadId === input.threadId && ExecutionStatus.occupiesQueue(turn.status))
          const previousQueue = queueState(current, input.threadId)
          if (active && previousQueue.queuedCount >= input.queueCapacity)
            return [
              {
                _tag: "Full" as const,
                error: QueueFull.make({
                  threadId: input.threadId,
                  capacity: input.queueCapacity,
                  count: previousQueue.queuedCount,
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
            stopIntent: "none",
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
          return [{ _tag: "Created" as const, submission: { ...clone(turn), queue } }, withQueueState(withTurn, input.threadId, nextQueue)] as const
        })
        if (result._tag === "Duplicate") return yield* RepositoryError.make({ message: `Turn ${input.id} exists` })
        if (result._tag === "Full") return yield* result.error
        return result.submission
      }),
      copy: Effect.fn("TurnRepository.copy")(function* (turn, queueCapacity) {
        const result = yield* modifyState((current): readonly [MemorySubmissionResult, MemoryState] => {
          if (current.turns.has(turn.id)) return [{ _tag: "Duplicate" as const }, current]
          const previousQueue = queueState(current, turn.threadId)
          if (turn.status === "queued" && previousQueue.queuedCount >= queueCapacity)
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
            ] as const
          const copied = clone(turn)
          const withTurn: MemoryState = { ...current, turns: new Map(current.turns).set(copied.id, copied) }
          if (copied.status !== "queued") return [{ _tag: "Created" as const, submission: clone(copied) }, withTurn] as const
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
          return [{ _tag: "Created" as const, submission: { ...clone(copied), queue } }, withQueueState(withTurn, copied.threadId, nextQueue)] as const
        })
        if (result._tag === "Duplicate") return yield* RepositoryError.make({ message: `Turn ${turn.id} exists` })
        if (result._tag === "Full") return yield* result.error
        return result.submission
      }),
      get,
      list: Effect.fn("TurnRepository.list")(function* (threadId) {
        return [...(yield* readState).turns.values()]
          .filter((turn) => turn.threadId === threadId)
          .toSorted((left, right) => left.createdAt - right.createdAt)
          .map(clone)
      }),
      listRecentNonqueued: Effect.fn("TurnRepository.listRecentNonqueued")(function* (threadId, limit) {
        return [...(yield* readState).turns.values()]
          .filter((turn) => turn.threadId === threadId && turn.status !== "queued")
          .toSorted((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
          .slice(0, Math.max(0, Math.floor(limit)))
          .toReversed()
          .map(clone)
      }),
      page: Effect.fn("TurnRepository.page")(function* (threadId, options = {}) {
        const limit = pageSize(options.limit)
        const descending = [...(yield* readState).turns.values()].filter((turn) => turn.threadId === threadId && (options.before === undefined || turn.createdAt < options.before.createdAt || (turn.createdAt === options.before.createdAt && turn.id < options.before.id))).toSorted((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
        const hasOlder = descending.length > limit
        const turns = descending.slice(0, limit).toReversed().map(clone)
        return {
          turns,
          hasOlder,
          oldestCursor: cursorFor(turns[0]),
          newestCursor: cursorFor(turns.at(-1)),
        }
      }),
      findActive: Effect.fn("TurnRepository.findActive")(function* (threadId) {
        return [...(yield* readState).turns.values()].filter((turn): turn is AgentExecutionTurn => isAgentExecution(turn) && turn.threadId === threadId && ExecutionStatus.isActiveStatus(turn.status)).toSorted((left, right) => left.createdAt - right.createdAt)[0]
      }),
      readQueue: Effect.fn("TurnRepository.readQueue")(function* (threadId) {
        const current = yield* readState
        const queue = queueState(current, threadId)
        const turns = [...current.turns.values()]
          .filter((turn): turn is AgentExecutionTurn => isAgentExecution(turn) && turn.threadId === threadId && turn.status === "queued")
          .toSorted((left, right) => left.createdAt - right.createdAt)
          .map(clone)
        return { threadId, revision: queue.revision, queuedCount: queue.queuedCount, turns }
      }),
      listNonterminal: Effect.gen(function* () {
        return [...(yield* readState).turns.values()]
          .filter((turn): turn is AgentExecutionTurn => isAgentExecution(turn) && ExecutionStatus.occupiesQueue(turn.status) && turn.stopIntent === "none")
          .toSorted((left, right) => left.createdAt - right.createdAt)
          .map(clone)
      }).pipe(Effect.withSpan("TurnRepository.listNonterminal")),
      listStopRequested: Effect.gen(function* () {
        return [...(yield* readState).turns.values()]
          .filter((turn): turn is AgentExecutionTurn => isAgentExecution(turn) && ExecutionStatus.occupiesQueue(turn.status) && turn.stopIntent === "requested")
          .toSorted((left, right) => left.createdAt - right.createdAt)
          .map(clone)
      }).pipe(Effect.withSpan("TurnRepository.listStopRequested")),
      requestStop: Effect.fn("TurnRepository.requestStop")(function* (id, now) {
        return yield* modifyState((current) => {
          const existing = current.turns.get(id)
          if (existing === undefined || !isAgentExecution(existing) || !ExecutionStatus.occupiesQueue(existing.status)) {
            return [undefined, current] as const
          }
          const updated: AgentExecutionTurn = { ...existing, stopIntent: "requested", updatedAt: now }
          const turns = new Map(current.turns)
          turns.set(id, updated)
          return [clone(updated), { ...current, turns }] as const
        })
      }),
      claimNextQueued: Effect.fn("TurnRepository.claimNextQueued")(function* (threadId, _now) {
        return yield* modifyState((current) => {
          const hasActive = [...current.turns.values()].some((turn) => isAgentExecution(turn) && turn.threadId === threadId && ExecutionStatus.isActiveStatus(turn.status))
          const queued = [...current.turns.values()].filter((turn): turn is AgentExecutionTurn => isAgentExecution(turn) && turn.threadId === threadId && turn.status === "queued" && !current.claims.has(turn.id)).toSorted((left, right) => left.createdAt - right.createdAt)[0]
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
      finishQueuedClaim: Effect.fn("TurnRepository.finishQueuedClaim")(function* (claim, status, lastCursor, extensionPin, now) {
        return yield* modifyState((current): readonly [QueueClaimFinish, MemoryState] => {
          const existing = current.turns.get(claim.turn.id)
          if (existing === undefined || !isAgentExecution(existing) || existing.status !== "queued" || current.claims.get(claim.turn.id) !== claim.token) return [{ _tag: "Unavailable" }, current]
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
          return [{ _tag: "Transitioned", turn: clone(nextTurn), queue }, withQueueState({ ...current, turns: new Map(current.turns).set(existing.id, nextTurn), claims }, existing.threadId, nextQueue)]
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
          return [{ ...clone(nextTurn), queue }, withQueueState({ ...current, turns: new Map(current.turns).set(id, nextTurn), claims }, turn.threadId, nextQueue)]
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
          const hasOtherActive = [...current.turns.values()].some((candidate) => isAgentExecution(candidate) && candidate.id !== id && candidate.threadId === turn.threadId && ExecutionStatus.isActiveStatus(candidate.status))
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
          return [{ _tag: "Queued" as const, value: { ...clone(queued), queue } }, withQueueState({ ...current, turns: new Map(current.turns).set(id, queued) }, turn.threadId, nextQueue)]
        })
        if (result._tag === "Unavailable") return yield* RepositoryError.make({ message: `Turn ${id} is not an unowned accepted turn` })
        if (result._tag === "Full") return yield* result.error
        return result.value
      }),
      requestQueueWake: Effect.fn("TurnRepository.requestQueueWake")(function* (threadId) {
        return yield* modifyState((current) => {
          const queue = queueState(current, threadId)
          if (queue.queuedCount === 0) return [undefined, current]
          if (queue.wakePending) return [{ threadId, generation: queue.wakeGeneration, queueRevision: queue.revision }, current]
          const next = { ...queue, wakeGeneration: queue.wakeGeneration + 1, wakePending: true }
          return [{ threadId, generation: next.wakeGeneration, queueRevision: next.revision }, withQueueState(current, threadId, next)]
        })
      }),
      consumeQueueWake: Effect.fn("TurnRepository.consumeQueueWake")(function* (threadId, generation) {
        return yield* modifyState((current) => {
          const queue = queueState(current, threadId)
          if (!queue.wakePending || queue.wakeGeneration !== generation) return [false, current]
          return [true, withQueueState(current, threadId, { ...queue, wakePending: false })]
        })
      }),
      setExtensionPin: Effect.fn("TurnRepository.setExtensionPin")(function* (id, pin) {
        return yield* withLock(
          Effect.gen(function* () {
            const currentState = yield* Ref.get(state)
            const current = currentState.turns.get(id)
            if (current === undefined || !isAgentExecution(current)) return yield* missing(id)
            const encoded = yield* Schema.encodeEffect(ExtensionPinJson)(pin).pipe(Effect.mapError(repositoryError))
            if (current.extensionPin !== undefined && (yield* Schema.encodeEffect(ExtensionPinJson)(current.extensionPin).pipe(Effect.mapError(repositoryError))) !== encoded) return yield* RepositoryError.make({ message: `Turn ${id} extension pin is immutable` })
            const next = { ...current, extensionPin: structuredClone(pin) }
            yield* Ref.set(state, {
              ...currentState,
              turns: new Map(currentState.turns).set(id, next),
            })
            return clone(next)
          }),
        )
      }),
      setStatus: Effect.fn("TurnRepository.setStatus")(function* (id, status, lastCursor, now) {
        const updated = yield* modifyState((currentState): readonly [{ readonly _tag: "Missing" } | { readonly _tag: "Queued" } | { readonly _tag: "Ok"; readonly turn: AgentExecutionTurn }, MemoryState] => {
          const current = currentState.turns.get(id)
          if (current === undefined) return [{ _tag: "Missing" }, currentState]
          if (!isAgentExecution(current)) return [{ _tag: "Missing" }, currentState]
          if (status === "queued" || current.status === "queued") return [{ _tag: "Queued" }, currentState]
          if (isTerminalStatus(current.status)) return [{ _tag: "Ok", turn: clone(current) }, currentState]
          const { lastCursor: previousCursor, ...withoutCursor } = current
          void previousCursor
          const next: AgentExecutionTurn = {
            ...withoutCursor,
            status,
            ...(lastCursor === undefined ? {} : { lastCursor }),
            updatedAt: now,
          }
          const withTurn: MemoryState = {
            ...currentState,
            turns: new Map(currentState.turns).set(id, next),
          }
          return [{ _tag: "Ok", turn: clone(next) }, withTurn]
        })
        if (updated._tag === "Missing") return yield* missing(id)
        if (updated._tag === "Queued")
          return yield* RepositoryError.make({
            message: `Turn ${id} cannot transition into or out of 'queued' via setStatus`,
          })
        return updated.turn
      }),
      startAccepted: Effect.fn("TurnRepository.startAccepted")(function* (id, now) {
        return yield* modifyState((currentState) => {
          const current = currentState.turns.get(id)
          if (current === undefined || !isAgentExecution(current) || current.status !== "accepted") return [false, currentState]
          const next: AgentExecutionTurn = { ...current, status: "running", updatedAt: now }
          return [true, { ...currentState, turns: new Map(currentState.turns).set(id, next) }]
        })
      }),
      cancelAccepted: Effect.fn("TurnRepository.cancelAccepted")(function* (id, now) {
        return yield* modifyState((currentState) => {
          const current = currentState.turns.get(id)
          if (current === undefined || !isAgentExecution(current) || current.status !== "accepted") return [false, currentState]
          const next: AgentExecutionTurn = { ...current, status: "cancelled", updatedAt: now }
          return [true, { ...currentState, turns: new Map(currentState.turns).set(id, next) }]
        })
      }),
      repairCursor: Effect.fn("TurnRepository.repairCursor")(function* (id, status, expectedCursor, cursor) {
        return yield* modifyState((currentState) => {
          const current = currentState.turns.get(id)
          if (current === undefined || !isAgentExecution(current) || current.status !== status || current.lastCursor !== expectedCursor) return [false, currentState]
          const { lastCursor: previousCursor, ...withoutCursor } = current
          void previousCursor
          const next: AgentExecutionTurn = {
            ...withoutCursor,
            ...(cursor === undefined ? {} : { lastCursor: cursor }),
          }
          return [true, { ...currentState, turns: new Map(currentState.turns).set(id, next) }]
        })
      }),
    } as Interface & { readonly [MemoryCoordinatorTypeId]: MemoryCoordinator })
  })
export const memoryLayer = (initial: ReadonlyArray<Turn> = []) => Layer.effect(Service, makeMemory(initial))
export { memoryCoordinator } from "./turn-memory-support"
export type { MemoryRefoldWrite } from "./turn-memory-support"
