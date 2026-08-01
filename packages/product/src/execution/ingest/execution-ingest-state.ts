import * as TranscriptPage from "@rika/product/transcript-page"
import * as ExecutionEvent from "@rika/product/execution-event"
import type * as Thread from "@rika/product/thread-record"
import type * as Turn from "@rika/product/turn-record"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import type * as IngestProjectionTypes from "./execution-projection-types"
import type { Snapshot } from "../../usage/usage-snapshot"
import type { RootExecution } from "../../usage/usage-event"
import type { UsageFold } from "../../usage/usage-fold"
import type { Failure } from "./execution-ingest-failure"
import type { ProjectionChange } from "./execution-ingest-event"
import type { ProjectionWatchOverflow } from "./execution-ingest-watch"
import type { Cause, Deferred, Latch, Queue, Semaphore } from "effect"

export type Settled = NonNullable<TranscriptPage.ExecutionCheckpoint["status"]>
export type InterruptedOutcome = NonNullable<TranscriptUnit.Unit["executionOutcome"]> & {
  readonly status: "failed" | "cancelled"
}

export interface Node {
  readonly executionId: string
  readonly key: string
  readonly parentKey: string | undefined
  readonly fold: TranscriptProjection.ProjectionFold
  readonly durableCursors: Map<string, number>
  cursor: string | undefined
  sequence: number
  status: Settled | undefined
  resumed: boolean
  caught: boolean
  attachment: IngestProjectionTypes.Attachment | undefined
}

export interface Pipeline {
  readonly threadId: Thread.ThreadId
  readonly turnId: Turn.TurnId
  readonly rootKey: string
  readonly streamId: string
  readonly nodes: Map<string, Node>
  readonly order: Array<string>
  readonly finished: Deferred.Deferred<void, Failure>
  readonly rootSettled: Latch.Latch
  readonly rootCommitted: Deferred.Deferred<void, Failure>
  readonly readersFinished: Latch.Latch
  readonly abandoned: Latch.Latch
  readonly wake: Queue.Queue<void>
  readonly committing: Semaphore.Semaphore
  readonly catchUp: boolean
  readonly refolding: boolean
  readonly refoldFromVersion: number | undefined
  fork: (effect: import("effect").Effect.Effect<void>) => void
  persistedGeneration: number | undefined
  turn: Turn.AgentExecutionTurn
  active: number
  pending: number
  accepting: boolean
  stopped: boolean
  reading: number
  delivered: Array<ExecutionEvent.Event> | undefined
  usageSnapshot: Snapshot
  usageRevision: number
  usageSourceComplete: boolean
  usageRefoldFromVersion: number | undefined
  usagePending: Array<RootExecution & { readonly event: ExecutionEvent.Event }>
  usageFold: UsageFold
  usageNotificationPending: boolean
  delta: IngestProjectionTypes.ProjectionDelta
  failure: Failure | undefined
  patchRevision: number
  streamClosed: boolean
  changeVersion: number
  pendingVersion: number
  persistedVersion: number
  readonly flushWaiters: Array<{
    readonly version: number
    readonly deferred: Deferred.Deferred<void, Failure>
  }>
  readonly unitIndex: Map<string, TranscriptUnit.Unit>
  readonly unitOwners: Map<string, string>
  readonly unresolvedByParent: Map<string, Set<string>>
  readonly runningNodes: Set<string>
}

export interface Watcher {
  readonly id: number
  readonly queue: Queue.Queue<ProjectionChange, ProjectionWatchOverflow | Cause.Done>
}

export const recordChange = (pipeline: Pipeline): void => {
  pipeline.changeVersion += 1
  pipeline.pendingVersion = pipeline.changeVersion
}

export const finishReaders = (pipeline: Pipeline): void => {
  if (pipeline.active <= 0) pipeline.readersFinished.openUnsafe()
}
