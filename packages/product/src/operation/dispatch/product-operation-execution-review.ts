import * as Turn from "@rika/product/turn-record"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as ExecutionChildRun from "@rika/product/execution-child-run"
import { Clock, Effect } from "effect"
import { operationError } from "../operation-error"
import { fanOutTurnStatus } from "../../execution/lifecycle/product-execution-quiescence"

export const makeExecutionReview = (input: any) =>
  Effect.sync(() => {
    const { reviewSettlementAdmission, reviewSettlements, ownerScope, executionDependencies, setTurnStatus } = input

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
          yield* setTurnStatus(turn.id, "failed", turn.lastCursor, yield* Clock.currentTimeMillis)
          return yield* operationError(`Review ${fanOutId} disappeared`)
        }
        if (inspection.state === "joining") yield* Effect.sleep("50 millis")
      }
      yield* setTurnStatus(turn.id, fanOutTurnStatus(inspection.state), turn.lastCursor, yield* Clock.currentTimeMillis)
      return inspection
    })
    const startReviewSettlement = Effect.fn("ProductOperation.startReviewSettlement")(function* (
      turn: Pick<Turn.AgentExecutionTurn, "id" | "lastCursor">,
      fanOutId: string,
      initial?: ExecutionChildRun.FanOutInspection,
    ) {
      return yield* reviewSettlementAdmission.withPermits(1)(
        Effect.gen(function* () {
          const existing = reviewSettlements.get(fanOutId)
          if (existing !== undefined) return existing
          const fiber = yield* Effect.forkIn(
            settleReviewOwner(turn, fanOutId, initial).pipe(
              Effect.provide(executionDependencies),
              Effect.mapError((error) => operationError(String(error))),
              Effect.ensuring(Effect.sync(() => reviewSettlements.delete(fanOutId))),
            ),
            ownerScope,
          )
          reviewSettlements.set(fanOutId, fiber)
          return fiber
        }),
      )
    })
    return { settleReviewOwner, startReviewSettlement }
  })
