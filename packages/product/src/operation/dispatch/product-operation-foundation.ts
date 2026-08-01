import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import * as UsageRepository from "@rika/product/usage-repository"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import { persistedThreadUsage } from "../interactive/interactive-session-transcript-runtime"
import * as RootTurnOwner from "../../thread/queue/root-turn-owner"
import * as ThreadToolService from "../../thread/tool/thread-tool-service"
import * as UsageProjection from "../../usage/usage-projection"
import * as UsageSnapshot from "../../usage/usage-snapshot"
import * as UsageCodec from "../../usage/usage-snapshot-codec"
import { Context, Effect, Layer, Result, Ref, Semaphore } from "effect"
import { buildProductOperationDependencies } from "./product-operation-foundation-dependencies"
import { makeProductOperationAdmission } from "./product-operation-admission"
import { makeProductOperationIngest } from "./product-operation-ingest"
import { AgentDepth } from "@rika/product/execution-service"
import { isTerminalStatus } from "../../execution/contract/execution-status"

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
  const usageRepository = dependencies.usageRepository
  const publishThreadUsage = Effect.fn("ProductOperation.publishThreadUsage")(function* (
    value: UsageSnapshot.TurnUsage | undefined,
  ) {
    if (value === undefined) return
    const thread = yield* usageRepository.readThread(value.threadId)
    const global = yield* usageRepository.readGlobal
    if (thread.costNanoUsd === undefined && thread.tokens === undefined && thread.activeMillis === undefined) return
    publishInteractiveActivity(0, {
      _tag: "ThreadUsageUpdated",
      selectionEpoch: 0,
      threadId: Thread.ThreadId.make(value.threadId),
      revision: thread.revision,
      ...persistedThreadUsage(thread),
    })
    if (value.costNanoUsd !== undefined && thread.costNanoUsd !== undefined && global.costNanoUsd !== undefined)
      publishInteractiveActivity(0, {
        _tag: "TitleCostUpdated",
        threadId: Thread.ThreadId.make(value.threadId),
        turnId: Turn.TurnId.make(value.turnId),
        turnCostUsd: value.costNanoUsd / 1_000_000_000,
        threadCostUsd: thread.costNanoUsd / 1_000_000_000,
        globalCostUsd: global.costNanoUsd / 1_000_000_000,
      })
  })
  const titleExecutionId = (turnId: Turn.TurnId) => AgentDepth.childExecutionId(String(turnId), "title")
  const commitUsageSource = Effect.fn("ProductOperation.commitUsageSource")(function* (
    sourceId: string,
    threadId: string,
    turnId: string,
    events: ReadonlyArray<ExecutionBackend.Event>,
    terminal: boolean,
  ) {
    yield* usageRepository.admitSource(sourceId, turnId, threadId)
    while (true) {
      const stored = yield* usageRepository.loadSourceFold(sourceId, turnId)
      if (stored === undefined)
        return yield* UsageRepository.RepositoryError.make({ message: `Usage source ${sourceId} was not admitted` })
      const decoded =
        stored.foldJson === undefined ? Result.succeed(UsageSnapshot.empty) : UsageCodec.deserialize(stored.foldJson)
      if (Result.isFailure(decoded)) return yield* decoded.failure
      const folded = UsageProjection.foldBatch(
        decoded.success,
        events.map((event) => ({ threadId, turnId, event })),
        terminal ? new Set([sourceId]) : new Set(),
      )
      if (Result.isFailure(folded)) return yield* folded.failure
      const foldJson = UsageCodec.serialize(folded.success)
      const totals = { ...UsageProjection.materialize(folded.success, turnId, threadId), sourceComplete: terminal }
      if (
        foldJson === stored.foldJson &&
        (yield* usageRepository.readSource(sourceId, turnId))?.sourceComplete === terminal
      )
        return yield* usageRepository.readSource(sourceId, turnId)
      const committed = yield* usageRepository.commitSource(sourceId, turnId, stored.revision, foldJson, totals)
      if (committed._tag === "Applied") return committed.value
    }
  })
  const usage = yield* makeProductOperationIngest({
    acquiredBackend,
    dependencyContext,
    usageRepository,
    ownerScope,
    publishInteractiveActivity,
    titleExecutionId,
    commitUsageSource,
    isTerminalStatus,
    ingestFailureMessage:
      "Rika lost its place in this thread's event history and stopped recording it. Reopen the thread to rebuild it.",
    transcripts: Context.get(dependencyContext, TranscriptRepository.Service),
    turns: Context.get(dependencyContext, TurnRepository.Service),
    publishThreadUsage,
  })
  const executionDependencies = Context.merge(
    dependencyContext,
    Context.make(ExecutionBackend.Service, acquiredBackend),
  )
  return {
    titleExecutionId,
    pendingTurnCapacity: Math.max(0, Math.floor(options.pendingTurnCapacity ?? 64)),
    rootTurnOwner,
    withExecutionAdmission,
    commitUsageSource,
    publishThreadUsage,
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
    usageRepository,
    ...usage,
  }
})
