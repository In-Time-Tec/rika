import * as TurnRepository from "@rika/product/turn-repository"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as RootTurnOwner from "../../thread/queue/root-turn-owner"
import * as LiveThreadProjection from "../../thread/projection/live-thread-projection"
import { Context, Effect, Layer, Ref, Scope, Semaphore } from "effect"
import { buildProductOperationDependencies } from "./product-operation-foundation-dependencies"
import { makeProductOperationAdmission } from "./product-operation-admission"
import type { ProductLayerOptions } from "./product-operation-options"

export interface ProductOperationFoundationInput {
  readonly options: ProductLayerOptions<Error, Error, Error, Error, Error>
  readonly ownerScope: Scope.Scope
  readonly hub: LiveThreadProjection.Interface
}

export const makeProductOperationFoundation = Effect.fn("ProductOperation.makeFoundation")(function* (
  input: ProductOperationFoundationInput,
) {
  const { options, ownerScope: rawOwnerScope, hub } = input
  const ownerScope: Scope.Scope = rawOwnerScope
  const dependencies = yield* buildProductOperationDependencies<Error, Error, Error, Error, Error>({
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
  )
  const backendLayer = Layer.succeed(ExecutionGateway.Service, acquiredBackend)
  const executionDependencies = Context.merge(
    dependencyContext,
    Context.make(ExecutionGateway.Service, acquiredBackend),
  )
  return {
    pendingTurnCapacity: Math.max(0, Math.floor(options.pendingTurnCapacity ?? 64)),
    hub,
    rootTurnOwner,
    withExecutionAdmission,
    extensionService: dependencies.extensionService,
    acquiredDependencies: dependencies.acquiredDependencies,
    replacementAdmission,
    replacementState,
    rawBackend: dependencies.rawBackend,
    executionSessionLifecycle: dependencies.executionSessionLifecycle,
    acquiredBackend,
    backendLayer,
    dependencyContext,
    executionDependencies,
  }
})
