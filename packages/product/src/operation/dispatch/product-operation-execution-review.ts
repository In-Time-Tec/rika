import * as Turn from "@rika/product/turn-record"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as ExecutionChildRun from "@rika/product/execution-child-run"
import { Context, Clock, Effect, Fiber, Scope, Semaphore } from "effect"
import { OperationError, operationError } from "../operation-error"
import { fanOutTurnStatus } from "../../execution/lifecycle/product-execution-quiescence"

export const makeExecutionReview = (input: any) =>
  Effect.sync(() => {
    const { reviewSettlementAdmission, reviewSettlements, ownerScope, executionDependencies, setTurnStatus } = input
    const typedReviewSettlementAdmission: Semaphore.Semaphore = reviewSettlementAdmission
    const typedReviewSettlements: Map<
      string,
      Fiber.Fiber<ExecutionChildRun.FanOutInspection, OperationError>
    > = reviewSettlements
    const typedOwnerScope: Scope.Scope = ownerScope
    const typedExecutionDependencies: Context.Context<ExecutionBackend.Service> = executionDependencies
    const typedSetTurnStatus: (
      id: Turn.TurnId,
      status: import("@rika/product/execution-status").Status,
      cursor: string | undefined,
      now: number,
    ) => Effect.Effect<Turn.Turn, OperationError, never> = setTurnStatus

    const settleReviewOwner = Effect.fn("ProductOperation.settleReviewOwner")(function* (
      turn: Pick<Turn.AgentExecutionTurn, "id" | "lastCursor">,
      fanOutId: string,
      initial?: ExecutionChildRun.FanOutInspection,
    ) {
      const backend = yield* ExecutionBackend.Service
      let inspection = initial
      while (inspection?.state === "joining" || inspection === undefined) {
        inspection = yield* backend.inspectFanOut(fanOutId)
        if (inspection === undefined) {
          yield* typedSetTurnStatus(turn.id, "failed", turn.lastCursor, yield* Clock.currentTimeMillis)
          return yield* operationError(`Review ${fanOutId} disappeared`)
        }
        if (inspection.state === "joining") yield* Effect.sleep("50 millis")
      }
      yield* typedSetTurnStatus(
        turn.id,
        fanOutTurnStatus(inspection.state),
        turn.lastCursor,
        yield* Clock.currentTimeMillis,
      )
      return inspection
    })
    const startReviewSettlement = Effect.fn("ProductOperation.startReviewSettlement")(function* (
      turn: Pick<Turn.AgentExecutionTurn, "id" | "lastCursor">,
      fanOutId: string,
      initial?: ExecutionChildRun.FanOutInspection,
    ) {
      return yield* typedReviewSettlementAdmission.withPermits(1)(
        Effect.gen(function* () {
          const existing = typedReviewSettlements.get(fanOutId)
          if (existing !== undefined) return existing
          const fiber = yield* Effect.forkIn(
            settleReviewOwner(turn, fanOutId, initial).pipe(
              Effect.provide(typedExecutionDependencies),
              Effect.mapError((error) => operationError(String(error))),
              Effect.ensuring(Effect.sync(() => typedReviewSettlements.delete(fanOutId))),
            ),
            typedOwnerScope,
          )
          typedReviewSettlements.set(fanOutId, fiber)
          return fiber
        }),
      )
    })
    return { settleReviewOwner, startReviewSettlement }
  }).pipe(Effect.mapError((error) => operationError(String(error), error)))
