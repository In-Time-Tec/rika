import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as Turn from "@rika/product/turn-record"
import * as UsageRepository from "@rika/product/usage-repository"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Deferred, Effect, Result } from "effect"
import * as IngestProjection from "./execution-projection-state"
import type { Pipeline, Node } from "./execution-ingest-state"
import type { Options } from "./execution-ingest-service"
import type { IngestFailure } from "./execution-ingest-failure"
import * as UsageProjection from "../../usage/usage-projection"
import * as UsageFold from "../../usage/usage-fold"
import * as UsageSnapshot from "../../usage/usage-snapshot"
import * as UsageCodec from "../../usage/usage-snapshot-codec"
import * as UsageEvent from "../../usage/usage-event"

export interface Commit {
  readonly threadId: import("@rika/product/thread-record").ThreadId
  readonly rootTurnId: import("@rika/product/turn-record").TurnId
  readonly revision: number
  readonly terminal: boolean
  readonly usageChanged: boolean
  readonly refolded: boolean
}

export interface Refold {
  readonly threadId: import("@rika/product/thread-record").ThreadId
  readonly rootTurnId: import("@rika/product/turn-record").TurnId
  readonly phase: "started" | "finished"
}

export interface CommitDependencies {
  readonly options: Options
  readonly fail: (pipeline: Pipeline, node: Node, reason: IngestFailure["reason"], message: string) => void
  readonly failProjection: (pipeline: Pipeline, failure: UsageEvent.ProjectionFailure) => void
  readonly resolveFlushWaiters: (pipeline: Pipeline) => void
  readonly projectionVersion: number
  readonly fullyConsumed: (nodes: ReadonlyMap<string, Node>) => boolean
}

export const make = (dependencies: CommitDependencies) => {
  let commitUsage: (
    pipeline: Pipeline,
    terminal: boolean,
  ) => Effect.Effect<boolean, UsageEvent.ProjectionFailure | UsageRepository.RepositoryError>
  commitUsage = Effect.fn("ExecutionIngestService.commitUsage")(function* (pipeline: Pipeline, terminal: boolean) {
    if (
      pipeline.usagePending.length === 0 &&
      pipeline.usageRefoldFromVersion === undefined &&
      pipeline.usageSourceComplete === terminal
    )
      return false
    const pending = pipeline.usagePending.slice()
    const desired = UsageFold.snapshotUsageFold(pipeline.usageFold)
    const complete = terminal
    const totals = {
      ...UsageProjection.materialize(desired, String(pipeline.turnId), String(pipeline.threadId)),
      sourceComplete: complete,
    }
    const foldJson = UsageCodec.serialize(desired)
    const sourceId = String(pipeline.turnId)
    const write =
      pipeline.usageRefoldFromVersion === undefined
        ? dependencies.options.usage.commitSource(
            sourceId,
            String(pipeline.turnId),
            pipeline.usageRevision,
            foldJson,
            totals,
          )
        : dependencies.options.usage.replaceSource(
            sourceId,
            String(pipeline.turnId),
            String(pipeline.threadId),
            pipeline.usageRefoldFromVersion,
            pipeline.usageRevision,
            foldJson,
            totals,
          )
    const result = yield* write
    if (result._tag === "Applied") {
      pipeline.usageSnapshot = desired
      pipeline.usageRevision = result.value.revision
      pipeline.usageSourceComplete = result.value.sourceComplete
      pipeline.usageRefoldFromVersion = undefined
      pipeline.usagePending.splice(0, pending.length)
      return true
    }
    const current = result.value ?? (yield* dependencies.options.usage.readSource(sourceId, String(pipeline.turnId)))
    if (current === undefined || current.projectionVersion !== UsageSnapshot.projectionVersion)
      return yield* UsageEvent.ProjectionFailure.make({
        message: `Usage source ${sourceId} has unsupported projection version`,
        reason: "unsupported-version",
      })
    const decoded =
      current.foldJson === undefined ? Result.succeed(UsageSnapshot.empty) : UsageCodec.deserialize(current.foldJson)
    if (Result.isFailure(decoded)) return yield* decoded.failure
    const replayed = UsageProjection.foldBatch(
      decoded.success,
      pending,
      terminal ? new Set(pipeline.nodes.keys()) : new Set(),
    )
    if (Result.isFailure(replayed)) return yield* replayed.failure
    pipeline.usageSnapshot = decoded.success
    pipeline.usageFold = UsageFold.restoreUsageFold(replayed.success)
    pipeline.usageRevision = current.revision
    pipeline.usageSourceComplete = current.sourceComplete
    pipeline.usageRefoldFromVersion = undefined
    if (replayed.success === decoded.success && current.sourceComplete === complete) {
      pipeline.usagePending.splice(0, pending.length)
      return false
    }
    return yield* commitUsage(pipeline, terminal)
  })

  const commit = (pipeline: Pipeline) =>
    pipeline.committing.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (pipeline.stopped) return
          if (
            (pipeline.refolding || pipeline.catchUp) &&
            (!dependencies.fullyConsumed(pipeline.nodes) || pipeline.reading > 0)
          )
            return
          if (
            pipeline.delta.units.size === 0 &&
            pipeline.delta.checkpoints.size === 0 &&
            pipeline.usagePending.length === 0 &&
            pipeline.usageRefoldFromVersion === undefined &&
            !pipeline.usageNotificationPending
          ) {
            dependencies.resolveFlushWaiters(pipeline)
            if (pipeline.reading <= 0) Deferred.doneUnsafe(pipeline.rootCommitted, Effect.void)
            return
          }
          const root = pipeline.nodes.get(pipeline.rootKey)!
          const turnResult = yield* Effect.result(dependencies.options.turns.get(pipeline.turnId))
          if (turnResult._tag === "Failure") {
            dependencies.fail(pipeline, root, "repository", String(turnResult.failure))
            return
          }
          const turn = turnResult.success
          if (turn === undefined) {
            dependencies.fail(
              pipeline,
              root,
              "checkpoint",
              `Turn ${pipeline.turnId} disappeared while its projection was committing`,
            )
            return
          }
          if (!Turn.isAgentExecution(turn)) {
            dependencies.fail(
              pipeline,
              root,
              "checkpoint",
              `Recorded shell turn ${pipeline.turnId} cannot enter execution ingest`,
            )
            return
          }
          pipeline.turn = turn
          const unresolved = [...pipeline.nodes.values()].filter(
            (node) => node.parentKey !== undefined && node.attachment === undefined,
          )
          if (unresolved.length > 0 && dependencies.fullyConsumed(pipeline.nodes) && pipeline.reading <= 0) {
            const key = unresolved[0]!.key
            dependencies.fail(
              pipeline,
              pipeline.nodes.get(key)!,
              "attachment",
              `Execution ${key} has no final parent tool`,
            )
            return
          }
          const projectionState = TranscriptProjection.Fold.snapshotFoldState(root.fold)
          const dirty = pipeline.delta
          const dirtyVersion = pipeline.pendingVersion
          pipeline.delta = { units: new Map(), checkpoints: new Set() }
          pipeline.pendingVersion = 0
          pipeline.pending = 0
          const checkpoint = (node: Node): TranscriptRepository.ExecutionCheckpoint => ({
            executionKey: node.key,
            executionId: node.executionId,
            cursor: node.cursor ?? "",
            sequence: node.sequence,
            ...(node.status === undefined ? {} : { status: node.status }),
            state: TranscriptProjection.Fold.snapshotFoldState(node.fold),
            ...(node.attachment === undefined
              ? {}
              : {
                  attachment: {
                    parentExecutionKey: node.parentKey!,
                    parentUnitKey: node.attachment.parentUnitKey,
                    parentId: node.attachment.parentId,
                    parentOrderKey: TranscriptOrdering.encodeUnitOrder(node.attachment.parentOrder),
                  },
                }),
          })
          const terminal = dependencies.fullyConsumed(pipeline.nodes)
          const usageChanged =
            pipeline.usagePending.length > 0 || (terminal && pipeline.usageSnapshot.activeEvents.size === 0)
          const deferred = new Map<string, { readonly owner: string; readonly unit?: TranscriptUnit.Unit }>()
          const upsert = [...dirty.units].flatMap(([key, mutation]) => {
            if (mutation.unit === undefined) return []
            const node = pipeline.nodes.get(mutation.owner)
            const unit = mutation.unit
            if (node === undefined || unit === undefined) return []
            if (node.parentKey !== undefined && node.attachment === undefined) {
              deferred.set(key, mutation)
              return []
            }
            return [IngestProjection.globalizeUnit(node, unit, node.attachment)]
          })
          for (const [key, mutation] of deferred) pipeline.delta.units.set(key, mutation)
          const changedCheckpoints = [...dirty.checkpoints].flatMap((key) => {
            const node = pipeline.nodes.get(key)
            if (node === undefined) return []
            if (node.parentKey !== undefined && node.attachment === undefined) {
              pipeline.delta.checkpoints.add(key)
              return []
            }
            return [checkpoint(node)]
          })
          const deferredChanges = deferred.size > 0 || pipeline.delta.checkpoints.size > 0
          if (deferredChanges) pipeline.pendingVersion = Math.max(pipeline.pendingVersion, dirtyVersion)
          const removals = [...dirty.units].flatMap(([key, mutation]) => (mutation.unit === undefined ? [key] : []))
          if (
            !pipeline.refolding &&
            upsert.length === 0 &&
            removals.length === 0 &&
            changedCheckpoints.length === 0 &&
            pipeline.usagePending.length === 0 &&
            pipeline.usageRefoldFromVersion === undefined
          )
            return
          let usageCommitted = false
          if (pipeline.usagePending.length > 0 || terminal || pipeline.usageRefoldFromVersion !== undefined) {
            const usageResult = yield* Effect.result(commitUsage(pipeline, terminal))
            if (usageResult._tag === "Failure") {
              if (usageResult.failure._tag === "UsageProjectionFailure")
                dependencies.failProjection(pipeline, usageResult.failure)
              else dependencies.fail(pipeline, root, "repository", String(usageResult.failure))
              return
            }
            usageCommitted = usageResult.success
          }
          if (upsert.length === 0 && removals.length === 0 && changedCheckpoints.length === 0) {
            const notifyUsage = usageCommitted || usageChanged || pipeline.usageNotificationPending
            if (notifyUsage) {
              dependencies.options.onCommitted?.({
                threadId: pipeline.threadId,
                rootTurnId: pipeline.turnId,
                revision: projectionState.revision,
                terminal,
                usageChanged: true,
                refolded: pipeline.refolding,
              })
              pipeline.usageNotificationPending = false
            }
            if (pipeline.reading <= 0 && pipeline.delta.units.size === 0 && pipeline.delta.checkpoints.size === 0)
              Deferred.doneUnsafe(pipeline.rootCommitted, Effect.void)
            return
          }
          const write: Effect.Effect<TranscriptRepository.RefoldWriteResult, TranscriptRepository.RepositoryError> =
            pipeline.refolding
              ? dependencies.options.transcripts.replaceForRefold(
                  turn,
                  {
                    ...projectionState,
                    units: IngestProjection.globalProjectionUnits(
                      pipeline.nodes,
                      pipeline.order,
                      new Map(
                        [...pipeline.nodes].flatMap(([key, node]) =>
                          node.attachment === undefined ? [] : [[key, node.attachment] as const],
                        ),
                      ),
                    ),
                  },
                  {
                    executionCheckpoints: [...pipeline.nodes.values()]
                      .filter((node) => node.parentKey === undefined || node.attachment !== undefined)
                      .map(checkpoint),
                    projectionVersion: dependencies.projectionVersion,
                    expectedProjectionVersion: pipeline.refoldFromVersion!,
                    expectedGeneration: pipeline.persistedGeneration!,
                  },
                )
              : dependencies.options.transcripts
                  .commitDelta(
                    turn,
                    projectionState,
                    {
                      upsert,
                      remove: removals,
                    },
                    {
                      executionCheckpoints: changedCheckpoints,
                      projectionVersion: dependencies.projectionVersion,
                      expectedGeneration: pipeline.persistedGeneration,
                    },
                  )
                  .pipe(
                    Effect.map(
                      (result): TranscriptRepository.RefoldWriteResult =>
                        result === "stale" ? { _tag: "Stale" } : { _tag: "Committed", turn },
                    ),
                  )
          const result = yield* Effect.result(write)
          if (result._tag === "Failure") {
            dependencies.fail(pipeline, root, "repository", String(result.failure))
            return
          }
          if (result.success._tag === "Stale") {
            dependencies.fail(pipeline, root, "checkpoint", `Turn ${pipeline.turnId} lost projection write authority`)
            return
          }
          pipeline.turn = result.success.turn
          pipeline.persistedGeneration = (pipeline.persistedGeneration ?? -1) + 1
          if (!deferredChanges) {
            pipeline.persistedVersion = Math.max(pipeline.persistedVersion, dirtyVersion)
            dependencies.resolveFlushWaiters(pipeline)
          }
          const notifyUsage = usageCommitted || usageChanged || pipeline.usageNotificationPending
          dependencies.options.onCommitted?.({
            threadId: pipeline.threadId,
            rootTurnId: pipeline.turnId,
            revision: projectionState.revision,
            terminal,
            usageChanged: notifyUsage,
            refolded: pipeline.refolding,
          })
          pipeline.usageNotificationPending = false
          if (pipeline.reading <= 0 && pipeline.delta.units.size === 0 && pipeline.delta.checkpoints.size === 0)
            Deferred.doneUnsafe(pipeline.rootCommitted, Effect.void)
          yield* Effect.logDebug("execution.ingest.committed").pipe(
            Effect.annotateLogs({
              "rika.thread.id": String(pipeline.threadId),
              "rika.turn.id": String(pipeline.turnId),
              "rika.ingest.revision": projectionState.revision,
              "rika.ingest.executions": pipeline.nodes.size,
              "rika.ingest.terminal": terminal,
            }),
          )
        }),
      ),
    )
  return commit
}
