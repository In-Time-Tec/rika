import * as TurnRepository from "@rika/product/turn-repository"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as RootTurnOwner from "../../thread/queue/root-turn-owner"
import * as ThreadToolService from "../../thread/tool/thread-tool-service"
import { Context, Effect, Layer, Ref, Semaphore } from "effect"
import { buildProductOperationDependencies } from "./product-operation-foundation-dependencies"
import { makeProductOperationAdmission } from "./product-operation-admission"
import { makeProductOperationIngest } from "./product-operation-ingest"

const workflowReplacementKey = (runId: string, ownerTurnId?: string, workspace?: string) =>
  JSON.stringify([runId, ownerTurnId, workspace])

export const makeProductOperationFoundation = Effect.fn("ProductOperation.makeFoundation")(function* (input: any) {
  const { options, ownerScope, publishInteractiveActivity } = input
  const dependencies = yield* buildProductOperationDependencies({ options, ownerScope })
  const replacementAdmission = yield* Semaphore.make(1)
  const replacementState = yield* Ref.make({ closed: false, active: 0 })
  const activeWorkflows = new Map<
    string,
    { readonly runId: string; readonly ownerTurnId?: string; readonly workspace?: string }
  >()
  const admission = makeProductOperationAdmission({
    rawBackend: dependencies.rawBackend,
    replacementAdmission,
    replacementState,
    activeWorkflows,
    workflowReplacementKey,
  })
  const { acquiredBackend, withExecutionAdmission } = admission
  const dependencyContext = dependencies.dependencyContext
  const rootTurnOwner = yield* RootTurnOwner.make(
    Context.get(dependencyContext, TurnRepository.Service),
    acquiredBackend,
    ownerScope,
  )
  const backendLayer = Layer.succeed(ExecutionBackend.Service, acquiredBackend)
  if (options.threadToolGateway !== undefined) {
    const threadToolService = yield* ThreadToolService.make({ scheduler: rootTurnOwner }).pipe(
      Effect.provide(Context.merge(dependencyContext, Context.make(ExecutionBackend.Service, acquiredBackend))),
    )
    yield* options.threadToolGateway.install(threadToolService)
  }
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
    Context.make(ExecutionBackend.Service, acquiredBackend),
  )
  return {
    pendingTurnCapacity: Math.max(0, Math.floor(options.pendingTurnCapacity ?? 64)),
    rootTurnOwner,
    withExecutionAdmission,
    extensionService: dependencies.extensionService,
    acquiredDependencies: dependencies.acquiredDependencies,
    replacementAdmission,
    replacementState,
    activeWorkflows,
    rawBackend: dependencies.rawBackend,
    acquiredBackend,
    backendLayer,
    dependencyContext,
    executionDependencies,
    usageRepository: dependencies.usageRepository,
    ...usage,
  }
})
