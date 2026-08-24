import { TurnResult } from "@rika/product/thread-result"
import { Service } from "@rika/product/turn-repository"
export { Service }
import { Effect, Layer } from "effect"
import * as ExecutionStatus from "@rika/product/execution-status"
import { AgentExecutionTurn, Turn } from "@rika/product/turn-record"
import { clone, cursorFor, pageSize } from "./state"
import { makeTurnMemoryLifecycle } from "./lifecycle"
import { makeTurnMemoryAdmission } from "./admission"
import { makeTurnMemorySteeringAdmission } from "./steering-admission"
import { makeTurnMemoryQueue } from "./queue"
import { makeTurnMemoryState } from "./state-operations"
import { makeTurnMemorySubmission } from "./submission"
import { repositoryError } from "./errors"
import { MemoryCoordinatorTypeId } from "./coordination"

export const makeMemory = (initial: ReadonlyArray<Turn> = []) =>
  Effect.gen(function* () {
    const { context, coordinator, get } = yield* makeTurnMemoryState(initial)
    const { readState } = context
    const shellCoordinator = coordinator[MemoryCoordinatorTypeId]
    return Service.of({
      ...coordinator,
      ...makeTurnMemorySubmission(context),
      ...makeTurnMemoryQueue(context),
      ...makeTurnMemoryAdmission(context),
      ...makeTurnMemorySteeringAdmission(context),
      ...makeTurnMemoryLifecycle(context),
      createRecordedShell: Effect.fn("TurnRepository.createRecordedShell")(function* (turn) {
        const result = yield* shellCoordinator.writeRecordedShell(undefined, turn, () =>
          Effect.succeed({ _tag: "Commit" as const, value: undefined }),
        )
        if (result._tag === "Stale") return yield* repositoryError(`Turn ${turn.id} already exists`)
        return result.value.turn as typeof turn
      }),
      settleRecordedShell: Effect.fn("TurnRepository.settleRecordedShell")(function* (expected, turn) {
        const result = yield* shellCoordinator.writeRecordedShell(expected, turn, () =>
          Effect.succeed({ _tag: "Commit" as const, value: undefined }),
        )
        return result._tag === "Stale" ? undefined : (result.value.turn as typeof turn)
      }),
      copyRecordedShell: Effect.fn("TurnRepository.copyRecordedShell")(function* (turn) {
        const result = yield* shellCoordinator.writeRecordedShell(undefined, turn, () =>
          Effect.succeed({ _tag: "Commit" as const, value: undefined }),
        )
        if (result._tag === "Stale") return yield* repositoryError(`Turn ${turn.id} already exists`)
        return result.value.turn as typeof turn
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
              TurnResult.isAgentExecution(turn) &&
              turn.threadId === threadId &&
              ExecutionStatus.isActiveStatus(turn.status),
          )
          .toSorted((left, right) => left.createdAt - right.createdAt)[0]
      }),
      listNonterminal: Effect.gen(function* () {
        return [...(yield* readState).turns.values()]
          .filter(
            (turn): turn is AgentExecutionTurn =>
              TurnResult.isAgentExecution(turn) && ExecutionStatus.occupiesQueue(turn.status),
          )
          .toSorted((left, right) => left.createdAt - right.createdAt)
          .map(clone)
      }).pipe(Effect.withSpan("TurnRepository.listNonterminal")),
    })
  })

export const memoryLayer = (initial: ReadonlyArray<Turn> = []) => Layer.effect(Service, makeMemory(initial))
export { memoryCoordinator } from "./coordination"
export type { MemoryRefoldWrite } from "./coordination"
