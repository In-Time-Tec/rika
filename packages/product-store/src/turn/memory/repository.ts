import { TurnResult } from "@rika/product/thread-result"
import { Service } from "@rika/product/turn-repository"
export { Service }
import { Effect, Layer } from "effect"
import * as ExecutionStatus from "@rika/product/execution-status"
import { AgentExecutionTurn, Turn } from "@rika/product/turn-record"
import { clone, cursorFor, pageSize } from "./state"
import * as Lifecycle from "./lifecycle"
import * as Admission from "./admission"
import * as SteeringAdmission from "./steering-admission"
import * as Queue from "./queue"
import * as StateOperations from "./state-operations"
import * as Submission from "./submission"
import { repositoryError } from "./errors"
import { MemoryCoordination } from "./coordination"

export const makeMemory = (initial: ReadonlyArray<Turn> = []) =>
  Effect.gen(function* () {
    const { context, coordinator, get } = yield* StateOperations.makeTurnMemoryState(initial)
    const { readState } = context
    const service = Service.of({
      ...Submission.makeTurnMemorySubmission(context),
      ...Queue.makeTurnMemoryQueue(context),
      ...Admission.makeTurnMemoryAdmission(context),
      ...SteeringAdmission.makeTurnMemorySteeringAdmission(context),
      ...Lifecycle.makeTurnMemoryLifecycle(context),
      createRecordedShell: Effect.fn("TurnRepository.createRecordedShell")(function* (turn) {
        const result = yield* coordinator.writeRecordedShell(undefined, turn, () =>
          Effect.succeed({ _tag: "Commit" as const, value: undefined }),
        )
        if (result._tag === "Stale") return yield* repositoryError(`Turn ${turn.id} already exists`)
        if (!TurnResult.isRunningRecordedShell(result.value.turn))
          return yield* repositoryError(`Turn ${turn.id} is not a running recorded shell`)
        return result.value.turn
      }),
      settleRecordedShell: Effect.fn("TurnRepository.settleRecordedShell")(function* (expected, turn) {
        const result = yield* coordinator.writeRecordedShell(expected, turn, () =>
          Effect.succeed({ _tag: "Commit" as const, value: undefined }),
        )
        if (result._tag === "Stale") return undefined
        if (TurnResult.isRunningRecordedShell(result.value.turn))
          return yield* repositoryError(`Turn ${turn.id} is not a terminal recorded shell`)
        return result.value.turn
      }),
      copyRecordedShell: Effect.fn("TurnRepository.copyRecordedShell")(function* (turn) {
        const result = yield* coordinator.writeRecordedShell(undefined, turn, () =>
          Effect.succeed({ _tag: "Commit" as const, value: undefined }),
        )
        if (result._tag === "Stale") return yield* repositoryError(`Turn ${turn.id} already exists`)
        if (TurnResult.isRunningRecordedShell(result.value.turn))
          return yield* repositoryError(`Turn ${turn.id} is not a terminal recorded shell`)
        return result.value.turn
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
    MemoryCoordination.register(coordinator, service)
    return service
  })

export const memoryLayer = (initial: ReadonlyArray<Turn> = []) => Layer.effect(Service, makeMemory(initial))
export { memoryCoordinator } from "./coordination"
export type { MemoryRefoldWrite } from "./coordination"
