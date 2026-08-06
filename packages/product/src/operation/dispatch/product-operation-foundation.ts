import * as TurnRepository from "@rika/product/turn-repository"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as RootTurnOwner from "../../thread/queue/root-turn-owner"
import { Context, Effect, Layer, Ref, Scope, Semaphore } from "effect"
import { buildProductOperationDependencies } from "./product-operation-foundation-dependencies"
import { makeProductOperationAdmission } from "./product-operation-admission"
import { makeProductOperationIngest } from "./product-operation-ingest"
import type { ProductLayerOptions } from "./product-operation-options"
import type { InteractiveEvent } from "../interactive/interactive-event"

export interface ProductOperationFoundationInput {
  readonly options: ProductLayerOptions<Error, Error, Error, Error, Error, Error>
  readonly ownerScope: Scope.Scope
  readonly publishInteractiveActivity: (origin: number, event: InteractiveEvent) => InteractiveEvent
  readonly publishTurnSettled: (
    turn: import("@rika/product/turn-record").Turn,
    responseArrived?: boolean,
  ) => Effect.Effect<void>
}

export const makeProductOperationFoundation = Effect.fn("ProductOperation.makeFoundation")(function* (
  input: ProductOperationFoundationInput,
) {
  const { options, ownerScope: rawOwnerScope, publishInteractiveActivity } = input
  const ownerScope: Scope.Scope = rawOwnerScope
  const dependencies = yield* buildProductOperationDependencies<Error, Error, Error, Error, Error, Error>({
    options,
    ownerScope,
  })
  const replacementAdmission = yield* Semaphore.make(1)
  const replacementState = yield* Ref.make({ closed: false, active: 0 })
  const admission = makeProductOperationAdmission({
    rawBackend: dependencies.rawBackend,
    replacementAdmission,
    replacementState,
  })
  const { acquiredBackend, withExecutionAdmission } = admission
  const dependencyContext = dependencies.dependencyContext
  const rootTurnOwner = yield* RootTurnOwner.make(
    Context.get(dependencyContext, TurnRepository.Service),
    Context.get(dependencyContext, TranscriptRepository.Service),
    acquiredBackend,
    ownerScope,
  ).pipe(Effect.provideService(Scope.Scope, ownerScope))
  const backendLayer = Layer.succeed(ExecutionGateway.Service, acquiredBackend)
  const usage = yield* makeProductOperationIngest({
    acquiredBackend,
    dependencyContext,
    usageRepository: dependencies.usageRepository,
    ownerScope,
    publishInteractiveActivity,
    ingestFailureMessage:
      "Rika lost its place in this thread's event history and stopped recording it. Reopen the thread to rebuild it.",
    transcripts: Context.get(dependencyContext, TranscriptRepository.Service),
    turns: Context.get(dependencyContext, TurnRepository.Service),
  })
  const executionDependencies = Context.merge(
    dependencyContext,
    Context.make(ExecutionGateway.Service, acquiredBackend),
  )
  return {
    pendingTurnCapacity: Math.max(0, Math.floor(options.pendingTurnCapacity ?? 64)),
    rootTurnOwner,
    withExecutionAdmission,
    extensionService: dependencies.extensionService,
    acquiredDependencies: dependencies.acquiredDependencies,
    replacementAdmission,
    replacementState,
    rawBackend: dependencies.rawBackend,
    acquiredBackend,
    backendLayer,
    dependencyContext,
    executionDependencies,
    usageRepository: dependencies.usageRepository,
    ...usage,
  }
})
