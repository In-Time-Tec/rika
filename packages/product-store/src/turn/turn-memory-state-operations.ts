import { TurnResult } from "@rika/product/thread-result"
import { Effect, Ref, Semaphore } from "effect"
import { ThreadId } from "@rika/product/thread-record"
import { TurnId, AgentExecutionTurn, Turn } from "@rika/product/turn-record"
import { MemoryCoordinatorTypeId } from "./turn-memory-coordination"
import { clone, sameTurn } from "./turn-memory-state"
import { emptyQueueState } from "./turn-memory-queue-state"
import type { MemoryCoordinator } from "./turn-memory-coordination"
import type { MemoryQueueState, MemoryState } from "./turn-memory-state"
export interface TurnMemoryContext {
  readonly readState: Effect.Effect<MemoryState>
  readonly modifyState: <A>(f: (state: MemoryState) => readonly [A, MemoryState]) => Effect.Effect<A>
  readonly updateState: (f: (state: MemoryState) => MemoryState) => Effect.Effect<void>
  readonly withLock: MemoryCoordinator["withLock"]
  readonly readUnlocked: Effect.Effect<MemoryState>
  readonly setUnlocked: (state: MemoryState) => Effect.Effect<void>
}

export const makeTurnMemoryState = (initial: ReadonlyArray<Turn>) =>
  Effect.gen(function* () {
    const initialTurns = new Map(initial.map((turn) => [turn.id, clone(turn)]))
    const initialQueues = new Map<ThreadId, MemoryQueueState>()
    for (const turn of initialTurns.values()) {
      if (!TurnResult.isAgentExecution(turn) || turn.status !== "queued") continue
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
    const modifyState = <A>(f: (current: MemoryState) => readonly [A, MemoryState]) => withLock(Ref.modify(state, f))
    const updateState = (f: (current: MemoryState) => MemoryState) => withLock(Ref.update(state, f))
    const agentExecutions: MemoryCoordinator["agentExecutions"] = Ref.get(state).pipe(
      Effect.map((current) => [...current.turns.values()].filter(TurnResult.isAgentExecution).map(clone)),
    )
    const adoptRefold: MemoryCoordinator["adoptRefold"] = (expected, status, cursor, write) =>
      withLock(
        Effect.gen(function* () {
          const currentState = yield* Ref.get(state)
          const current = currentState.turns.get(expected.id)
          if (
            current === undefined ||
            !TurnResult.isAgentExecution(current) ||
            current.status !== expected.status ||
            current.lastCursor !== expected.lastCursor
          )
            return { _tag: "Stale" as const }
          const next: AgentExecutionTurn = { ...current, status, lastCursor: cursor }
          const written = yield* write(clone(next))
          if (written._tag === "Stale") return written
          yield* Ref.set(state, { ...currentState, turns: new Map(currentState.turns).set(expected.id, next) })
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
          } else if (
            current === undefined ||
            !TurnResult.isRunningRecordedShell(current) ||
            !TurnResult.isRunningRecordedShell(expected) ||
            !sameTurn(current, expected) ||
            TurnResult.isRunningRecordedShell(turn) ||
            turn.threadId !== current.threadId ||
            turn.prompt !== current.prompt ||
            turn.command !== current.command ||
            turn.createdAt !== current.createdAt
          ) {
            return { _tag: "Stale" as const }
          }
          const written = yield* write(clone(turn))
          if (written._tag === "Stale") return written
          yield* Ref.set(state, { ...currentState, turns: new Map(currentState.turns).set(turn.id, clone(turn)) })
          return { _tag: "Commit" as const, value: { turn: clone(turn), value: written.value } }
        }),
      )
    const get = Effect.fn("TurnRepository.get")(function* (id: TurnId) {
      const turn = (yield* readState).turns.get(id)
      return turn === undefined ? undefined : clone(turn)
    })
    return {
      context: {
        readState,
        modifyState,
        updateState,
        withLock,
        readUnlocked: Ref.get(state),
        setUnlocked: (next) => Ref.set(state, next),
      } satisfies TurnMemoryContext,
      coordinator: {
        [MemoryCoordinatorTypeId]: {
          withLock,
          agentExecutions,
          adoptRefold,
          writeRecordedShell,
        } satisfies MemoryCoordinator,
      },
      get,
    }
  })
