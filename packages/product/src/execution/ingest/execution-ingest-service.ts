import * as ThreadResult from "@rika/product/thread-result"
import type { Options } from "./execution-ingest-state"
import { Cause, Deferred, Duration, Effect, FiberSet, Latch, Queue, Result, Scope, Semaphore } from "effect"
import * as UsageFold from "../../usage/usage-fold"
import * as UsageSnapshot from "../../usage/usage-snapshot"
import * as UsageCodec from "../../usage/usage-snapshot-codec"
import * as UsageEvent from "../../usage/usage-event"
import * as IngestState from "./execution-ingest-state"
import * as IngestEvent from "./execution-ingest-event"
import * as EventFamily from "./execution-ingest-event-family"
import * as IngestRestore from "./execution-ingest-restore"
import * as IngestCommit from "./execution-ingest-commit"
import * as IngestWatch from "./execution-ingest-watch"
import * as IngestLifecycle from "./execution-ingest-lifecycle"
import * as IngestFailureRuntime from "./execution-ingest-failure"
import { IngestFailure, type Failure } from "./execution-ingest-failure"
import * as IngestStop from "./execution-ingest-stop"

export const projectionVersion = 4

export const defaultCommitWindow = Duration.millis(250)
export const defaultCommitEvents = 64
export const defaultWatchCapacity = 2_048

export interface Interface {
  readonly ensure: (root: IngestEvent.Root) => Effect.Effect<void, Failure>
  readonly watchThread: (
    threadId: IngestEvent.Root["threadId"],
  ) => Effect.Effect<IngestWatch.ProjectionWatch, never, Scope.Scope>
  readonly deliver: (turnId: IngestEvent.Root["turnId"], event: any) => void
  readonly consumed: (turnId: IngestEvent.Root["turnId"]) => Effect.Effect<void, Failure>
  readonly flush: (turnId: IngestEvent.Root["turnId"]) => Effect.Effect<void, Failure>
  readonly settled: (turnId: IngestEvent.Root["turnId"]) => Effect.Effect<void, Failure>
}

type InterruptedOutcome = IngestState.InterruptedOutcome
type Node = IngestState.Node
type Pipeline = IngestState.Pipeline

const isTerminalStatus = (status: string): boolean =>
  status === "completed" || status === "failed" || status === "cancelled"
const fullyConsumed = IngestEvent.fullyConsumed
const interruptedAncestorOutcome = (nodes: ReadonlyMap<string, Node>, node: Node): InterruptedOutcome | undefined =>
  IngestRestore.interruptedAncestorOutcome(nodes, node, EventFamily.isInterruptedOutcome)

export const make = Effect.fn("ExecutionIngestService.make")(function* (options: Options) {
  const ownerScope = yield* Effect.scope
  const commitWindow = Duration.fromInputUnsafe(options.commitWindow ?? defaultCommitWindow)
  const commitEvents = Math.max(1, Math.floor(options.commitEvents ?? defaultCommitEvents))
  const watchCapacity = Math.max(1, Math.floor(options.watchCapacity ?? defaultWatchCapacity))
  const admission = yield* Semaphore.make(1)
  const pipelines = new Map<string, Pipeline>()
  const failedPipelines = new Map<string, Failure>()
  let nextStreamId = 0
  const watch = IngestWatch.make(pipelines, watchCapacity)
  const { publish, publishPatch, publishStarted, watchThread } = watch

  const wake = (pipeline: Pipeline) => Queue.offerUnsafe(pipeline.wake, undefined)
  const resolveFlushWaiters = (pipeline: Pipeline) => {
    const pending = pipeline.flushWaiters.filter((waiter) => {
      if (waiter.version > pipeline.persistedVersion) return true
      Deferred.doneUnsafe(waiter.deferred, Effect.void)
      return false
    })
    pipeline.flushWaiters.length = 0
    pipeline.flushWaiters.push(...pending)
  }
  const failureRuntime = IngestFailureRuntime.make({ options, failedPipelines, wake })
  const { fail, failProjection } = failureRuntime

  const commit = IngestCommit.make({
    options,
    fail,
    failProjection,
    resolveFlushWaiters,
    projectionVersion,
    fullyConsumed,
  })
  const finishPipeline = (pipeline: Pipeline) => IngestStop.finish(pipeline, publish, fail, fullyConsumed)
  const settlePipeline = IngestStop.settle
  const events = IngestEvent.make({
    options,
    commit,
    fail,
    failProjection,
    publishPatch,
    publish,
    wake,
    commitEvents,
    finishPipeline,
    settlePipeline,
  })
  const { startNode, accept } = events

  const drive = (pipeline: Pipeline, pipelineScope: Scope.Closeable) =>
    IngestLifecycle.make(
      {
        options,
        pipelines,
        commit,
        startNode,
        wake,
        finishReaders: (current: IngestState.Pipeline) => {
          if (current.active <= 0) current.readersFinished.openUnsafe()
        },
        finishPipeline,
        settlePipeline,
        fail: (current: IngestState.Pipeline, node: IngestState.Node, _reason: "checkpoint", message: string) =>
          fail(current, node, "checkpoint", message),
      },
      pipeline,
      pipelineScope,
      commitWindow,
    )

  const ensure = Effect.fn("ExecutionIngestService.ensure")(function* (root: IngestEvent.Root) {
    yield* admission.withPermits(1)(
      Effect.gen(function* () {
        const live = pipelines.get(String(root.turnId))
        const turn = yield* options.turns.get(root.turnId).pipe(
          Effect.mapError((error) =>
            IngestFailure.make({
              message: String(error),
              threadId: String(root.threadId),
              turnId: String(root.turnId),
              executionId: String(root.turnId),
              reason: "repository",
            }),
          ),
        )
        if (turn !== undefined && !ThreadResult.TurnResult.isAgentExecution(turn))
          return yield* IngestFailure.make({
            message: `Recorded shell turn ${root.turnId} cannot enter execution ingest`,
            threadId: String(root.threadId),
            turnId: String(root.turnId),
            executionId: String(root.turnId),
            reason: "checkpoint",
          })
        if (live !== undefined) {
          if (turn !== undefined) live.turn = turn
          if (!live.catchUp && turn !== undefined && isTerminalStatus(turn.status)) live.rootSettled.openUnsafe()
          if (turn?.status === "cancelled") live.abandoned.openUnsafe()
          return
        }
        if (turn === undefined || turn.status === "queued") return
        const stored = yield* options.transcripts.get(root.turnId).pipe(
          Effect.mapError((error) =>
            IngestFailure.make({
              message: String(error),
              threadId: String(root.threadId),
              turnId: String(root.turnId),
              executionId: String(root.turnId),
              reason: "repository",
            }),
          ),
        )
        if (stored !== undefined && stored.projectionVersion > projectionVersion)
          return yield* IngestFailure.make({
            message: `Transcript ${root.turnId} has unsupported projection version ${stored.projectionVersion}`,
            threadId: String(root.threadId),
            turnId: String(root.turnId),
            executionId: String(root.turnId),
            reason: "checkpoint",
          })
        const refolding = stored !== undefined && stored.projectionVersion < projectionVersion
        const usageSourceId = String(root.turnId)
        const usageSource = yield* options.usage.readSource(usageSourceId, String(root.turnId)).pipe(
          Effect.flatMap((source) =>
            source === undefined
              ? options.usage.admitSource(usageSourceId, String(root.turnId), String(root.threadId))
              : Effect.succeed(source),
          ),
          Effect.mapError((error) =>
            IngestFailure.make({
              message: String(error),
              threadId: String(root.threadId),
              turnId: String(root.turnId),
              executionId: String(root.turnId),
              reason: "repository",
            }),
          ),
        )
        if (usageSource.projectionVersion > UsageSnapshot.projectionVersion)
          return yield* UsageEvent.ProjectionFailure.make({
            message: `Usage source ${usageSourceId} has unsupported projection version ${usageSource.projectionVersion}`,
            reason: "unsupported-version",
            threadId: String(root.threadId),
            turnId: String(root.turnId),
          })
        const usageRefoldFromVersion =
          usageSource.projectionVersion < UsageSnapshot.projectionVersion ? usageSource.projectionVersion : undefined
        const usageDecoded =
          usageRefoldFromVersion !== undefined || usageSource.foldJson === undefined
            ? Result.succeed(UsageSnapshot.empty)
            : UsageCodec.deserialize(usageSource.foldJson)
        if (Result.isFailure(usageDecoded)) return yield* usageDecoded.failure
        const restored = IngestRestore.restore(turn, refolding ? undefined : stored)
        if (restored.invalid !== undefined)
          return yield* IngestFailure.make({
            message: restored.invalid,
            threadId: String(root.threadId),
            turnId: String(root.turnId),
            executionId: String(root.turnId),
            reason: "checkpoint",
          })
        if (!refolding && stored !== undefined) {
          const restoredAttachments = new Map(
            [...restored.nodes].flatMap(([key, node]) =>
              node.attachment === undefined ? [] : [[key, node.attachment] as const],
            ),
          )
          const attachmentFailure = IngestRestore.validateStoredAttachments(
            turn,
            stored,
            restored.nodes,
            restoredAttachments,
          )
          if (attachmentFailure !== undefined)
            return yield* IngestFailure.make({
              message: attachmentFailure,
              threadId: String(root.threadId),
              turnId: String(root.turnId),
              executionId: String(root.turnId),
              reason: "attachment",
            })
          for (const key of restored.order) {
            const node = restored.nodes.get(key)!
            if (node.parentKey === undefined) continue
            const ancestorOutcome = interruptedAncestorOutcome(restored.nodes, node)
            if (ancestorOutcome !== undefined && IngestRestore.hasRunningUnits(node.fold))
              return yield* IngestFailure.make({
                message: `Transcript ${root.turnId} has running descendant state beneath a ${ancestorOutcome.status} execution`,
                threadId: String(root.threadId),
                turnId: String(root.turnId),
                executionId: node.executionId,
                reason: "checkpoint",
              })
            const outcome = IngestRestore.executionOutcome(node.fold)
            if (outcome === undefined) continue
            const parent = restored.nodes.get(node.parentKey)!
            const validation = IngestRestore.applyChildOutcome(parent.fold, node.executionId, outcome)
            if (validation.stateChanged || validation.units.upsert.length > 0 || validation.units.remove.length > 0)
              return yield* IngestFailure.make({
                message: `Transcript ${root.turnId} has a child outcome that contradicts its stored parent`,
                threadId: String(root.threadId),
                turnId: String(root.turnId),
                executionId: node.executionId,
                reason: "checkpoint",
              })
          }
        }
        failedPipelines.delete(String(root.turnId))
        if (!refolding && isTerminalStatus(turn.status) && fullyConsumed(restored.nodes)) return
        const unitIndex = new Map<string, import("@rika/transcript/transcript-unit").Unit>()
        const unitOwners = new Map<string, string>()
        for (const [key, node] of restored.nodes)
          for (const unit of IngestRestore.units(node.fold)) {
            unitIndex.set(unit.key, unit)
            unitOwners.set(unit.key, key)
          }
        const pipelineScope = yield* Scope.make()
        nextStreamId += 1
        const pipeline: Pipeline = {
          threadId: root.threadId,
          turnId: root.turnId,
          rootKey: IngestEvent.executionKey(String(root.turnId)),
          streamId: `projection-${nextStreamId}`,
          nodes: restored.nodes,
          order: restored.order,
          finished: yield* Deferred.make<void, Failure>(),
          rootSettled: Latch.makeUnsafe(false),
          rootCommitted: yield* Deferred.make<void, Failure>(),
          readersFinished: Latch.makeUnsafe(false),
          abandoned: Latch.makeUnsafe(false),
          wake: yield* Queue.bounded<void>(1),
          committing: yield* Semaphore.make(1),
          catchUp: isTerminalStatus(turn.status),
          refolding,
          refoldFromVersion: refolding ? stored.projectionVersion : undefined,
          fork: () => undefined,
          turn,
          persistedGeneration: stored?.checkpointGeneration,
          active: 0,
          pending: 0,
          accepting: true,
          stopped: false,
          reading: 0,
          delivered: isTerminalStatus(turn.status) ? undefined : [],
          usageSnapshot: usageDecoded.success,
          usageRevision: usageSource.revision,
          usageSourceComplete: usageSource.sourceComplete,
          usageRefoldFromVersion,
          usagePending: [],
          usageFold: UsageFold.restoreUsageFold(usageDecoded.success),
          usageNotificationPending: false,
          delta: {
            units: new Map(
              stored === undefined
                ? [...unitIndex].map(([key, unit]) => [key, { owner: unitOwners.get(key)!, unit }] as const)
                : [],
            ),
            checkpoints: new Set(stored === undefined || refolding ? restored.nodes.keys() : []),
          },
          failure: undefined,
          patchRevision: 0,
          streamClosed: false,
          changeVersion: stored === undefined || refolding ? 1 : 0,
          pendingVersion: stored === undefined || refolding ? 1 : 0,
          persistedVersion: 0,
          flushWaiters: [],
          unitIndex,
          unitOwners,
          unresolvedByParent: new Map(),
          runningNodes: new Set(
            [...restored.nodes].flatMap(([key, node]) => (IngestRestore.hasRunningUnits(node.fold) ? [key] : [])),
          ),
        }
        pipeline.fork = yield* FiberSet.makeRuntime<never, void, never>().pipe(
          Effect.provideService(Scope.Scope, pipelineScope),
        )
        pipelines.set(String(root.turnId), pipeline)
        publishStarted(pipeline)
        if (refolding) options.onRefold?.({ threadId: root.threadId, rootTurnId: root.turnId, phase: "started" })
        yield* Effect.forkIn(
          drive(pipeline, pipelineScope).pipe(
            Effect.catchCause((cause) =>
              Effect.suspend(() => {
                if (!Cause.hasInterruptsOnly(cause))
                  fail(pipeline, pipeline.nodes.get(pipeline.rootKey)!, "backend", Cause.pretty(cause))
                return Effect.logWarning("execution.ingest.failed").pipe(
                  Effect.annotateLogs({
                    "rika.thread.id": String(root.threadId),
                    "rika.turn.id": String(root.turnId),
                    "rika.failure.cause": Cause.pretty(cause),
                  }),
                )
              }),
            ),
          ),
          ownerScope,
        )
      }),
    )
  })

  return {
    ensure,
    watchThread,
    deliver: (turnId, event) => {
      const pipeline = pipelines.get(String(turnId))
      if (pipeline === undefined || !pipeline.accepting) return
      if (pipeline.delivered !== undefined) {
        pipeline.delivered.push(event)
        return
      }
      accept(pipeline, pipeline.nodes.get(pipeline.rootKey)!, event)
    },
    consumed: Effect.fn("ExecutionIngestService.consumed")(function* (turnId: IngestEvent.Root["turnId"]) {
      const pipeline = pipelines.get(String(turnId))
      if (pipeline !== undefined) return yield* Deferred.await(pipeline.rootCommitted)
      const failure = failedPipelines.get(String(turnId))
      if (failure !== undefined) return yield* failure
    }),
    flush: Effect.fn("ExecutionIngestService.flush")(function* (turnId: IngestEvent.Root["turnId"]) {
      const deferred = yield* Deferred.make<void, Failure>()
      const pipeline = pipelines.get(String(turnId))
      if (pipeline === undefined) {
        const failure = failedPipelines.get(String(turnId))
        if (failure !== undefined) return yield* failure
        return
      }
      if (pipeline.delivered !== undefined) yield* Deferred.await(pipeline.rootCommitted)
      if (pipeline.failure !== undefined) return yield* pipeline.failure
      const version = pipeline.changeVersion
      if (version <= pipeline.persistedVersion) return
      pipeline.flushWaiters.push({ version, deferred })
      wake(pipeline)
      return yield* Deferred.await(deferred)
    }),
    settled: Effect.fn("ExecutionIngestService.settled")(function* (turnId: IngestEvent.Root["turnId"]) {
      const pipeline = pipelines.get(String(turnId))
      if (pipeline !== undefined) return yield* Deferred.await(pipeline.finished)
      const failure = failedPipelines.get(String(turnId))
      if (failure !== undefined) return yield* failure
    }),
  } satisfies Interface
})
