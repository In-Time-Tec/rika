import * as ThreadInteractionRepository from "@rika/product/thread-interaction-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import * as ExecutionStatus from "../../execution/contract/execution-status"
import { Effect, Context } from "effect"
import { operationError } from "../operation-error"
import { makeExecutionLifecycle } from "./product-operation-execution-lifecycle"
import { makeExecutionProjection } from "./product-operation-execution-projection"
import { makeExecutionReview } from "./product-operation-execution-review"
import { makeExecutionContext } from "./product-operation-execution-context"
import { makeThreadResultReconciliation } from "./thread-result-reconciliation"

export const makeProductOperationExecution = (
  input: any,
): Effect.Effect<Readonly<Record<string, unknown>>, Error, never> =>
  Effect.gen(function* () {
    const threadInteractions =
      input.options.threadInteractionRepositoryLayer === undefined
        ? undefined
        : Context.get(input.dependencyContext, ThreadInteractionRepository.Service)
    yield* Effect.provideService(
      Context.get(input.dependencyContext, TurnRepository.Service).resetQueueClaims,
      TurnRepository.Service,
      Context.get(input.dependencyContext, TurnRepository.Service),
    )
    const lifecycle = yield* makeExecutionLifecycle(input)
    const projection = yield* makeExecutionProjection({ ...input, ...lifecycle })
    const review = yield* makeExecutionReview({ ...input, ...lifecycle, ...projection })
    const context = yield* makeExecutionContext({
      ...input,
      ...lifecycle,
      ...projection,
      ...review,
      threadInteractions,
      isTerminalStatus: ExecutionStatus.isTerminalStatus,
    })
    const reconcileThreadResults = makeThreadResultReconciliation({
      threadInteractions,
      executionDependencies: input.executionDependencies,
      ensureIngest: input.ensureIngest,
      awaitIngestSettled: input.awaitIngestSettled,
      pendingTurnCapacity: input.pendingTurnCapacity,
      rootTurnOwner: input.rootTurnOwner,
      dependencyContext: input.dependencyContext,
      isTerminalStatus: ExecutionStatus.isTerminalStatus,
    })
    return { ...lifecycle, ...projection, ...review, ...context, reconcileThreadResults }
  }).pipe(Effect.mapError((error) => operationError(String(error), error)))
