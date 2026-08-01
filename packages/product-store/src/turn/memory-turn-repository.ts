import { Service } from "@rika/product/turn-repository"
export { Service }
import { Effect, Layer } from "effect"
import * as ExecutionStatus from "@rika/product/execution-status"
import { AgentExecutionTurn, Turn, isAgentExecution } from "@rika/product/turn-record"
import { clone, cursorFor, pageSize } from "./turn-memory-support"
import { makeTurnMemoryLifecycle } from "./turn-memory-lifecycle"
import { makeTurnMemoryQueue } from "./turn-memory-queue"
import { makeTurnMemoryState } from "./turn-memory-state-operations"
import { makeTurnMemorySubmission } from "./turn-memory-submission"

export const makeMemory = (initial: ReadonlyArray<Turn> = []) =>
  Effect.gen(function* () {
    const { context, coordinator, get } = yield* makeTurnMemoryState(initial)
    const { readState, modifyState } = context
    return Service.of({
      ...coordinator,
      ...makeTurnMemorySubmission(context),
      ...makeTurnMemoryQueue(context),
      ...makeTurnMemoryLifecycle(context),
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
        const descending = [...(yield* readState).turns.values()]
          .filter(
            (turn) =>
              turn.threadId === threadId &&
              (options.before === undefined ||
                turn.createdAt < options.before.createdAt ||
                (turn.createdAt === options.before.createdAt && turn.id < options.before.id)),
          )
          .toSorted((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
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
        return [...(yield* readState).turns.values()]
          .filter(
            (turn): turn is AgentExecutionTurn =>
              isAgentExecution(turn) && turn.threadId === threadId && ExecutionStatus.isActiveStatus(turn.status),
          )
          .toSorted((left, right) => left.createdAt - right.createdAt)[0]
      }),
      listNonterminal: Effect.gen(function* () {
        return [...(yield* readState).turns.values()]
          .filter(
            (turn): turn is AgentExecutionTurn =>
              isAgentExecution(turn) && ExecutionStatus.occupiesQueue(turn.status) && turn.stopIntent === "none",
          )
          .toSorted((left, right) => left.createdAt - right.createdAt)
          .map(clone)
      }).pipe(Effect.withSpan("TurnRepository.listNonterminal")),
      listStopRequested: Effect.gen(function* () {
        return [...(yield* readState).turns.values()]
          .filter(
            (turn): turn is AgentExecutionTurn =>
              isAgentExecution(turn) && ExecutionStatus.occupiesQueue(turn.status) && turn.stopIntent === "requested",
          )
          .toSorted((left, right) => left.createdAt - right.createdAt)
          .map(clone)
      }).pipe(Effect.withSpan("TurnRepository.listStopRequested")),
      requestStop: Effect.fn("TurnRepository.requestStop")(function* (id, now) {
        return yield* modifyState((current) => {
          const existing = current.turns.get(id)
          if (existing === undefined || !isAgentExecution(existing) || !ExecutionStatus.occupiesQueue(existing.status))
            return [undefined, current] as const
          const updated: AgentExecutionTurn = { ...existing, stopIntent: "requested", updatedAt: now }
          return [clone(updated), { ...current, turns: new Map(current.turns).set(id, updated) }] as const
        })
      }),
    })
  })

export const memoryLayer = (initial: ReadonlyArray<Turn> = []) => Layer.effect(Service, makeMemory(initial))
export { memoryCoordinator } from "./turn-memory-support"
export type { MemoryRefoldWrite } from "./turn-memory-support"
