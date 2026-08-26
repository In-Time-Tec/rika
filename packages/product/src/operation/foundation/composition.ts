import * as TurnRepository from "@rika/product/turn-repository"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as RootTurnOwner from "../../thread/queue/root-owner"
import { Context, Effect, Layer, Scope } from "effect"
import { buildProductOperationDependencies } from "./dependencies"
import * as ProductOperationAdmission from "../dispatch/admission"
import type { ProductLayerOptions } from "./options"

export interface ProductOperationFoundationInput {
  readonly options: ProductLayerOptions<Error, Error, Error, Error, Error>
  readonly ownerScope: Scope.Scope
}

export const makeProductOperationFoundation = Effect.fn("ProductOperation.makeFoundation")(function* (
  input: ProductOperationFoundationInput,
) {
  const { options, ownerScope: rawOwnerScope } = input
  const ownerScope: Scope.Scope = rawOwnerScope
  const dependencies = yield* buildProductOperationDependencies<Error, Error, Error, Error, Error>({
    options,
    ownerScope,
  })
  const { acquiredBackend, closeAdmissions } = yield* ProductOperationAdmission.makeProductOperationAdmission({
    rawBackend: dependencies.rawBackend,
  })
  const dependencyContext = dependencies.dependencyContext
  const rootTurnOwner = yield* RootTurnOwner.make(
    Context.get(dependencyContext, TurnRepository.Service),
    Context.get(dependencyContext, TranscriptRepository.Service),
    acquiredBackend,
    ownerScope,
  ).pipe(Effect.provideService(Scope.Scope, ownerScope))
  const backendLayer = Layer.succeed(ExecutionGateway.Service, acquiredBackend)
  const executionDependencies = Context.merge(
    dependencyContext,
    Context.make(ExecutionGateway.Service, acquiredBackend),
  )
  return {
    pendingTurnCapacity: Math.max(0, Math.floor(options.pendingTurnCapacity ?? 64)),
    rootTurnOwner,
    closeAdmissions,
    extensionService: dependencies.extensionService,
    acquiredDependencies: dependencies.acquiredDependencies,
    rawBackend: dependencies.rawBackend,
    executionSessionLifecycle: dependencies.executionSessionLifecycle,
    acquiredBackend,
    backendLayer,
    dependencyContext,
    executionDependencies,
  }
})
