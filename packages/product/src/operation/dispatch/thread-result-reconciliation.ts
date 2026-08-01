import * as Turn from "@rika/product/turn-record"
import * as ThreadResult from "@rika/product/thread-result"
import * as TranscriptCorrelation from "@rika/transcript/child-parent-correlation"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as ResultDelivery from "../../thread/repository/thread-interaction-result"
import * as TurnRepository from "@rika/product/turn-repository"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import { Clock, Context, Effect } from "effect"

export const projectedOutcomeStatus = (
  status: "completed" | "failed" | "cancelled",
): "complete" | "failed" | "cancelled" => (status === "completed" ? "complete" : status)

export const makeThreadResultReconciliation =
  (input: any): any =>
  () =>
    Effect.gen(function* () {
      const {
        threadInteractions,
        executionDependencies: _executionDependencies,
        ensureIngest,
        awaitIngestSettled,
        pendingTurnCapacity,
        rootTurnOwner,
        dependencyContext,
        isTerminalStatus,
      } = input
      const reconcileThreadResults = Effect.fn("ProductOperation.reconcileThreadResults")(function* () {
        if (threadInteractions === undefined) return false
        const turns = Context.get(dependencyContext, TurnRepository.Service)
        const transcripts = Context.get(dependencyContext, TranscriptRepository.Service)
        let retry = false
        let after: ResultDelivery.ResultRouteCursor | undefined
        while (true) {
          const routes = yield* threadInteractions.listUndeliveredResults(100, after)
          if (routes.length === 0) break
          for (const route of routes) {
            const turn = yield* turns.get(route.targetTurnId)
            if (turn === undefined || !ThreadResult.TurnResult.isAgentExecution(turn)) continue
            let currentRoute = route
            if (route.delivery === "awaiting-result" && isTerminalStatus(turn.status)) {
              let projection = yield* transcripts.get(turn.id)
              if (turn.status !== "cancelled" || projection !== undefined) {
                const ingested = yield* Effect.exit(
                  ensureIngest(turn.threadId, turn.id).pipe(Effect.andThen(awaitIngestSettled(turn.id))),
                )
                if (ingested._tag === "Failure") {
                  retry = true
                  continue
                }
                projection = yield* transcripts.get(turn.id)
              }
              let result: ResultDelivery.RootResult
              if (turn.status === "cancelled" && projection === undefined) result = { status: "cancelled" }
              else {
                const checkpoint = projection?.executionCheckpoints.find(
                  (entry: any) => entry.executionKey === TranscriptCorrelation.executionKey(String(turn.id)),
                )
                const expectedOutcome = projectedOutcomeStatus(turn.status as any)
                const outcome = projection?.units.find(
                  (unit: any) =>
                    unit.parentId === undefined && unit.turnId === turn.id && unit.executionOutcome !== undefined,
                )?.executionOutcome
                if (
                  projection === undefined ||
                  checkpoint === undefined ||
                  checkpoint.status !== turn.status ||
                  checkpoint.cursor.length === 0 ||
                  outcome?.status !== expectedOutcome
                ) {
                  retry = true
                  continue
                }
                if (turn.status === "completed") {
                  const output = TranscriptProjection.Projection.finalAssistantOutput(
                    projection,
                    String(turn.id),
                  )?.slice(0, 8_000)
                  if (output === undefined) {
                    retry = true
                    continue
                  }
                  result = {
                    status: "completed",
                    cursor: checkpoint.cursor,
                    sequence: checkpoint.sequence,
                    output,
                  }
                } else
                  result = {
                    status: turn.status,
                    cursor: checkpoint.cursor,
                    sequence: checkpoint.sequence,
                    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
                  }
              }
              const settled = yield* threadInteractions.settleResult({
                targetTurnId: turn.id,
                result,
                now: yield* Clock.currentTimeMillis,
              })
              if (settled !== undefined) currentRoute = settled
            }
            if (currentRoute.kind !== "reply" || currentRoute.delivery !== "ready") continue
            const delivered = yield* Effect.exit(
              threadInteractions.deliverResult({
                targetTurnId: turn.id,
                deliveredTurnId: Turn.TurnId.make(`thread-result:${turn.id}`),
                queueCapacity: pendingTurnCapacity,
                now: yield* Clock.currentTimeMillis,
              }),
            )
            if (delivered._tag === "Failure") {
              retry = true
              continue
            }
            const deliveredValue: any = delivered.value
            if (deliveredValue.deliveredTurnId === undefined) continue
            const deliveredTurn = yield* turns.get(deliveredValue.deliveredTurnId)
            if (deliveredTurn?.status === "accepted") yield* rootTurnOwner.accepted(deliveredTurn.id)
          }
          const last = routes.at(-1)
          if (last === undefined || routes.length < 100) break
          after = { targetTurnId: last.targetTurnId }
        }
        return retry
      })
      return yield* reconcileThreadResults()
    })
