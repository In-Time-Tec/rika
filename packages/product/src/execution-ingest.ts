import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import * as UsageRepository from "@rika/product/usage-repository"
import * as ExecutionBackend from "@rika/product/execution-service"
import { ExecutionId } from "./execution-identifier"
import * as ExecutionStatus from "./execution-status"
import * as TranscriptCorrelation from "@rika/transcript/child-parent-correlation"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptProjectionModel from "@rika/transcript/transcript-projection-model"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Latch,
  Queue,
  Result,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect"
import * as IngestProjection from "./execution-ingest-projection"
import * as UsageCost from "./usage-cost"

export const projectionVersion = 4

export const defaultCommitWindow = Duration.millis(250)
export const defaultCommitEvents = 64
export const defaultWatchCapacity = 2_048
const retainedFailureLimit = 128

export class IngestFailure extends Schema.TaggedErrorClass<IngestFailure>()("ExecutionIngestFailure", {
  message: Schema.String,
  threadId: Schema.String,
  turnId: Schema.String,
  executionId: Schema.String,
  reason: Schema.Literals(["cursor-rejected", "backend", "repository", "checkpoint", "attachment"]),
}) {}

export class ProjectionWatchOverflow extends Schema.TaggedErrorClass<ProjectionWatchOverflow>()(
  "ExecutionIngestProjectionWatchOverflow",
  {
    threadId: Schema.String,
    capacity: Schema.Int,
  },
) {}

export interface Root {
  readonly threadId: Thread.ThreadId
  readonly turnId: Turn.TurnId
}

export interface Discovery {
  readonly threadId: Thread.ThreadId
  readonly rootTurnId: Turn.TurnId
  readonly executionId: string
}

export type Failure = IngestFailure | UsageCost.ProjectionFailure

export type ProjectionSnapshot = IngestProjection.Snapshot
export type ProjectionPatch = IngestProjection.Patch
export type ProjectionChange =
  | IngestProjection.Change
  | {
      readonly _tag: "ProjectionFailed"
      readonly threadId: Thread.ThreadId
      readonly rootTurnId: Turn.TurnId
      readonly streamId: string
      readonly patchRevision: number
      readonly failure: Failure
    }

export interface ProjectionWatch {
  readonly snapshots: ReadonlyArray<ProjectionSnapshot>
  readonly refolding: boolean
  readonly changes: Stream.Stream<ProjectionChange, ProjectionWatchOverflow>
}

export interface Commit {
  readonly threadId: Thread.ThreadId
  readonly rootTurnId: Turn.TurnId
  readonly revision: number
  readonly terminal: boolean
  readonly usageChanged: boolean
  readonly refolded: boolean
}

export interface Refold {
  readonly threadId: Thread.ThreadId
  readonly rootTurnId: Turn.TurnId
  readonly phase: "started" | "finished"
}

export interface Options {
  readonly backend: ExecutionBackend.Interface
  readonly transcripts: TranscriptRepository.Interface
  readonly turns: TurnRepository.Interface
  readonly usage: UsageRepository.Interface
  readonly commitWindow?: Duration.Input
  readonly commitEvents?: number
  readonly watchCapacity?: number
  readonly onDiscovered?: (discovery: Discovery) => void
  readonly onCommitted?: (commit: Commit) => void
  readonly onRefold?: (refold: Refold) => void
  readonly onFailure?: (failure: Failure) => void
}

export interface Interface {
  readonly ensure: (root: Root) => Effect.Effect<void, Failure>
  readonly watchThread: (threadId: Thread.ThreadId) => Effect.Effect<ProjectionWatch, never, Scope.Scope>
  readonly deliver: (turnId: Turn.TurnId, event: ExecutionBackend.Event) => void
  readonly consumed: (turnId: Turn.TurnId) => Effect.Effect<void, Failure>
  readonly flush: (turnId: Turn.TurnId) => Effect.Effect<void, Failure>
  readonly settled: (turnId: Turn.TurnId) => Effect.Effect<void, Failure>
}

type Settled = NonNullable<TranscriptRepository.ExecutionCheckpoint["status"]>
type InterruptedOutcome = NonNullable<TranscriptUnit.Unit["executionOutcome"]> & {
  readonly status: "failed" | "cancelled"
}

const isInterruptedOutcome = (
  outcome: NonNullable<TranscriptUnit.Unit["executionOutcome"]>,
): outcome is InterruptedOutcome => outcome.status === "failed" || outcome.status === "cancelled"

interface Node {
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
  attachment: IngestProjection.Attachment | undefined
}

interface Pipeline {
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
  fork: (effect: Effect.Effect<void>) => void
  persistedGeneration: number | undefined
  turn: Turn.AgentExecutionTurn
  active: number
  pending: number
  accepting: boolean
  stopped: boolean
  reading: number
  delivered: Array<ExecutionBackend.Event> | undefined
  usageSnapshot: UsageCost.Snapshot
  usageRevision: number
  usageSourceComplete: boolean
  usageRefoldFromVersion: number | undefined
  usagePending: Array<UsageCost.RootExecution & { readonly event: ExecutionBackend.Event }>
  usageFold: UsageCost.UsageFold
  usageNotificationPending: boolean
  delta: IngestProjection.ProjectionDelta
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

interface Watcher {
  readonly id: number
  readonly queue: Queue.Queue<ProjectionChange, ProjectionWatchOverflow | Cause.Done>
}

const isTerminalStatus = ExecutionStatus.isTerminalStatus

const settledStatus = (status: ExecutionBackend.Status): Settled | undefined =>
  status === "completed" || status === "failed" || status === "cancelled" ? status : undefined

const spawnedChildIds = (event: ExecutionBackend.Event): ReadonlyArray<string> => {
  const ids = new Set<string>()
  const addAliases = (value: Readonly<Record<string, unknown>> | undefined) => {
    if (value === undefined) return
    for (const alias of ["child_execution_id", "child_run_id", "childId", "child_id"] as const) {
      const id = value[alias]
      if (typeof id === "string" && id.length > 0) ids.add(id)
    }
  }
  if (event.childExecutionId !== undefined && event.childExecutionId.length > 0) ids.add(event.childExecutionId)
  addAliases(event.data)
  const member = event.data?.member
  if (member !== null && typeof member === "object") addAliases(member as Readonly<Record<string, unknown>>)
  if (event.type === "child_fan_out.created" && Array.isArray(event.data?.children))
    for (const child of event.data.children)
      if (child !== null && typeof child === "object") addAliases(child as Readonly<Record<string, unknown>>)
  return [...ids]
}

const childProjectionOf = (
  key: string,
  units: ReadonlyArray<TranscriptUnit.Unit>,
  state?: TranscriptProjectionModel.ProjectionState,
): TranscriptProjectionModel.Projection =>
  state === undefined ? TranscriptProjection.Projection.empty(key, "") : { units, ...state }

const rootProjectionOf = (
  turn: Turn.AgentExecutionTurn,
  stored: TranscriptRepository.Projection,
  state: TranscriptProjectionModel.ProjectionState,
): TranscriptProjectionModel.Projection | string => {
  const rootUnits = stored.units.filter((unit) => unit.parentId === undefined)
  if (rootUnits.some((unit) => unit.turnId !== turn.id)) return `Transcript ${turn.id} has a foreign root unit`
  if (stored.units.some((unit) => unit.parentId !== undefined && unit.turnId === turn.id))
    return `Transcript ${turn.id} has a root unit attached beneath another execution`
  const promptKey = `turn:${String(turn.id)}:user`
  const expectedPrompt = TranscriptProjection.Projection.empty(String(turn.id), turn.prompt).units[0]!
  const prompts = rootUnits.filter((unit) => unit.key === promptKey)
  if (prompts.length !== 1) return `Transcript ${turn.id} has no unique root prompt`
  const prompt = prompts[0]!
  if (
    prompt.content._tag !== "Entry" ||
    prompt.content.role !== "user" ||
    prompt.content.text !== turn.prompt ||
    TranscriptOrdering.compareUnitOrder(prompt.order, expectedPrompt.order) !== 0
  )
    return `Transcript ${turn.id} has a contradictory root prompt`
  return {
    units: rootUnits,
    ...state,
  }
}

const restore = (
  turn: Turn.AgentExecutionTurn,
  stored: TranscriptRepository.Projection | undefined,
): { readonly nodes: Map<string, Node>; readonly order: Array<string>; readonly invalid?: string } => {
  const rootKey = TranscriptCorrelation.executionKey(String(turn.id))
  const checkpoints = new Map(
    (stored?.executionCheckpoints ?? []).map((checkpoint) => [checkpoint.executionKey, checkpoint]),
  )
  const rootCheckpoint = checkpoints.get(rootKey)
  if (stored !== undefined && rootCheckpoint === undefined)
    return { nodes: new Map(), order: [], invalid: `Transcript ${turn.id} has no root execution checkpoint` }
  if (rootCheckpoint?.attachment !== undefined)
    return { nodes: new Map(), order: [], invalid: `Transcript ${turn.id} has an attached root execution checkpoint` }
  if (
    stored !== undefined &&
    rootCheckpoint !== undefined &&
    !TranscriptProjection.Projection.sameProjectionState(
      TranscriptProjection.Projection.projectionState(stored),
      rootCheckpoint.state,
    )
  )
    return { nodes: new Map(), order: [], invalid: `Transcript ${turn.id} has contradictory root checkpoint state` }
  const rootCursor =
    rootCheckpoint === undefined || rootCheckpoint.cursor.length === 0 ? undefined : rootCheckpoint.cursor
  const rootProjection =
    stored === undefined || rootCheckpoint === undefined
      ? TranscriptProjection.Projection.empty(String(turn.id), turn.prompt)
      : rootProjectionOf(turn, stored, rootCheckpoint.state)
  if (typeof rootProjection === "string") return { nodes: new Map(), order: [], invalid: rootProjection }
  const root: Node = {
    executionId: rootCheckpoint?.executionId ?? String(turn.id),
    key: rootKey,
    parentKey: undefined,
    fold: TranscriptProjection.Fold.restoreProjectionFold(rootProjection),
    durableCursors: new Map(rootCursor === undefined ? [] : [[rootCursor, rootCheckpoint!.sequence]]),
    cursor: rootCursor,
    sequence: rootCheckpoint?.sequence ?? -1,
    status: rootCheckpoint?.status,
    resumed: false,
    caught: false,
    attachment: undefined,
  }
  const nodes = new Map<string, Node>([[rootKey, root]])
  const order = [rootKey]
  const groups = new Map<string, Array<TranscriptUnit.Unit>>()
  for (const unit of stored?.units ?? []) {
    if (unit.parentId === undefined) continue
    const key = TranscriptCorrelation.executionKey(unit.turnId)
    const group = groups.get(key)
    const local = IngestProjection.localizeUnit(unit)
    if (group === undefined) groups.set(key, [local])
    else group.push(local)
  }
  const candidates = new Set<string>([...groups.keys(), ...checkpoints.keys()])
  candidates.delete(rootKey)
  let remaining = [...candidates]
  while (remaining.length > 0) {
    const unresolved: Array<string> = []
    for (const key of remaining) {
      const checkpoint = checkpoints.get(key)
      const units = groups.get(key) ?? []
      if (checkpoint === undefined || checkpoint.attachment === undefined) {
        unresolved.push(key)
        continue
      }
      const parent = nodes.get(checkpoint.attachment.parentExecutionKey)
      const parentUnit = stored?.units.find((unit) => unit.key === checkpoint.attachment!.parentUnitKey)
      if (parent === undefined || parentUnit === undefined) {
        unresolved.push(key)
        continue
      }
      if (
        parentUnit.content._tag !== "Block" ||
        parentUnit.content.block._tag !== "ToolCall" ||
        parentUnit.content.block.id !== checkpoint.attachment.parentId ||
        TranscriptOrdering.encodeUnitOrder(parentUnit.order) !== checkpoint.attachment.parentOrderKey
      )
        return { nodes, order, invalid: `Transcript ${turn.id} has contradictory durable attachment for ${key}` }
      const cursor = checkpoint.cursor.length === 0 ? undefined : checkpoint.cursor
      nodes.set(key, {
        executionId: checkpoint.executionId,
        key,
        parentKey: checkpoint.attachment.parentExecutionKey,
        fold: TranscriptProjection.Fold.restoreProjectionFold(childProjectionOf(key, units, checkpoint.state)),
        durableCursors: new Map(cursor === undefined ? [] : [[cursor, checkpoint.sequence]]),
        cursor,
        sequence: checkpoint.sequence,
        status: checkpoint.status,
        resumed: false,
        caught: false,
        attachment: {
          parentId: checkpoint.attachment.parentId,
          parentUnitKey: parentUnit.key,
          parentToolId: checkpoint.attachment.parentId,
          parentOrder: parentUnit.order,
        },
      })
      order.push(key)
    }
    if (unresolved.length === remaining.length)
      return {
        nodes,
        order,
        invalid: `Transcript ${turn.id} has unattached execution checkpoints: ${unresolved.join(", ")}`,
      }
    remaining = unresolved
  }
  return { nodes, order }
}

const validateStoredAttachments = (
  turn: Turn.AgentExecutionTurn,
  stored: TranscriptRepository.Projection,
  nodes: ReadonlyMap<string, Node>,
  attachments: ReadonlyMap<string, IngestProjection.Attachment>,
): string | undefined => {
  const persisted = new Map(stored.units.map((unit) => [unit.key, unit]))
  for (const [key, node] of nodes) {
    if (node.parentKey === undefined) continue
    const attachment = attachments.get(key)
    if (attachment === undefined) return `Transcript ${turn.id} has no durable attachment for ${key}`
    for (const unit of TranscriptProjection.Fold.foldUnits(node.fold)) {
      const actual = persisted.get(unit.key)
      const expected = IngestProjection.globalizeUnit(node, unit, attachments.get(key))
      if (
        actual === undefined ||
        actual.turnId !== expected.turnId ||
        actual.parentId !== expected.parentId ||
        TranscriptOrdering.encodeUnitOrder(actual.order) !== TranscriptOrdering.encodeUnitOrder(expected.order)
      )
        return `Transcript ${turn.id} has a contradictory durable attachment for ${key}`
    }
  }
  return undefined
}

const bySequence = (left: ExecutionBackend.Event, right: ExecutionBackend.Event) => left.sequence - right.sequence

const fullyConsumed = (nodes: ReadonlyMap<string, Node>): boolean =>
  [...nodes.values()].every((node) => node.status !== undefined)

const interruptedAncestorOutcome = (nodes: ReadonlyMap<string, Node>, node: Node): InterruptedOutcome | undefined => {
  let parentKey = node.parentKey
  while (parentKey !== undefined) {
    const parent = nodes.get(parentKey)
    if (parent === undefined) return undefined
    const outcome = TranscriptProjection.Fold.foldExecutionOutcome(parent.fold)
    if (outcome !== undefined && isInterruptedOutcome(outcome)) return outcome
    parentKey = parent.parentKey
  }
  return undefined
}

const isDescendantOf = (nodes: ReadonlyMap<string, Node>, node: Node, ancestorKey: string): boolean => {
  let parentKey = node.parentKey
  while (parentKey !== undefined) {
    if (parentKey === ancestorKey) return true
    parentKey = nodes.get(parentKey)?.parentKey
  }
  return false
}

const attachments = (pipeline: Pipeline) =>
  new Map(
    [...pipeline.nodes].flatMap(([key, node]) =>
      node.attachment === undefined ? [] : ([[key, node.attachment]] as const),
    ),
  )

const recordChange = (pipeline: Pipeline) => {
  pipeline.changeVersion += 1
  pipeline.pendingVersion = pipeline.changeVersion
}

const finishReaders = (pipeline: Pipeline) => {
  if (pipeline.active <= 0) pipeline.readersFinished.openUnsafe()
}

export const make = Effect.fn("ExecutionIngest.make")(function* (options: Options) {
  const ownerScope = yield* Effect.scope
  const commitWindow = Duration.fromInputUnsafe(options.commitWindow ?? defaultCommitWindow)
  const commitEvents = Math.max(1, Math.floor(options.commitEvents ?? defaultCommitEvents))
  const watchCapacity = Math.max(1, Math.floor(options.watchCapacity ?? defaultWatchCapacity))
  const admission = yield* Semaphore.make(1)
  const pipelines = new Map<string, Pipeline>()
  const failedPipelines = new Map<string, Failure>()
  const watchers = new Map<string, Map<number, Watcher>>()
  let nextStreamId = 0
  let nextWatcherId = 0

  const snapshot = (pipeline: Pipeline): ProjectionSnapshot => {
    const root = pipeline.nodes.get(pipeline.rootKey)!
    return {
      threadId: pipeline.threadId,
      rootTurnId: pipeline.turnId,
      turn: pipeline.turn,
      streamId: pipeline.streamId,
      patchRevision: pipeline.patchRevision,
      state: IngestProjection.visibleState(root.fold),
      units: IngestProjection.globalProjectionUnits(pipeline.nodes, pipeline.order, attachments(pipeline)),
      ...(root.status === undefined ? {} : { rootStatus: root.status }),
    }
  }

  const publish = (pipeline: Pipeline, change: ProjectionChange) => {
    const key = String(pipeline.threadId)
    const threadWatchers = watchers.get(key)
    if (threadWatchers === undefined) return
    for (const watcher of threadWatchers.values()) {
      if (Queue.offerUnsafe(watcher.queue, change)) continue
      threadWatchers.delete(watcher.id)
      Queue.failCauseUnsafe(
        watcher.queue,
        Cause.fail(
          ProjectionWatchOverflow.make({
            threadId: key,
            capacity: watchCapacity,
          }),
        ),
      )
    }
    if (threadWatchers.size === 0) watchers.delete(key)
  }

  const publishPatch = (
    pipeline: Pipeline,
    origin: IngestProjection.ProjectionOrigin,
    visible: IngestProjection.VisibleDelta,
  ) => {
    const root = pipeline.nodes.get(pipeline.rootKey)!
    const baseRevision = pipeline.patchRevision
    pipeline.patchRevision += 1
    publish(pipeline, {
      _tag: "ProjectionPatched",
      patch: {
        threadId: pipeline.threadId,
        rootTurnId: pipeline.turnId,
        streamId: pipeline.streamId,
        baseRevision,
        patchRevision: pipeline.patchRevision,
        origin,
        state: IngestProjection.visibleState(root.fold),
        delta: IngestProjection.globalDelta(pipeline.nodes, visible, attachments(pipeline)),
        ...(root.status === undefined ? {} : { rootStatus: root.status }),
      },
    })
  }

  const publishStarted = (pipeline: Pipeline) =>
    publish(pipeline, { _tag: "ProjectionStarted", snapshot: snapshot(pipeline) })

  const watchThread = (threadId: Thread.ThreadId) =>
    Effect.gen(function* () {
      const queue = yield* Queue.dropping<ProjectionChange, ProjectionWatchOverflow | Cause.Done>(watchCapacity)
      const registration = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const id = nextWatcherId
          nextWatcherId += 1
          const key = String(threadId)
          const threadWatchers = watchers.get(key) ?? new Map<number, Watcher>()
          threadWatchers.set(id, { id, queue })
          watchers.set(key, threadWatchers)
          const threadPipelines = [...pipelines.values()].filter((pipeline) => pipeline.threadId === threadId)
          return {
            id,
            key,
            snapshots: threadPipelines.map(snapshot),
            refolding: threadPipelines.some((pipeline) => pipeline.refolding),
          }
        }),
        ({ id, key }) =>
          Effect.sync(() => {
            const threadWatchers = watchers.get(key)
            threadWatchers?.delete(id)
            if (threadWatchers?.size === 0) watchers.delete(key)
          }).pipe(Effect.andThen(Queue.end(queue)), Effect.asVoid),
      )
      return {
        snapshots: registration.snapshots,
        refolding: registration.refolding,
        changes: Stream.fromQueue(queue),
      }
    })

  const retainFailure = (turnId: Turn.TurnId, failure: Failure) => {
    const key = String(turnId)
    failedPipelines.delete(key)
    failedPipelines.set(key, failure)
    while (failedPipelines.size > retainedFailureLimit) failedPipelines.delete(failedPipelines.keys().next().value!)
  }

  const wake = (pipeline: Pipeline) => {
    Queue.offerUnsafe(pipeline.wake, undefined)
  }

  const resolveFlushWaiters = (pipeline: Pipeline) => {
    const pending = pipeline.flushWaiters.filter((waiter) => {
      if (waiter.version > pipeline.persistedVersion) return true
      Deferred.doneUnsafe(waiter.deferred, Effect.void)
      return false
    })
    pipeline.flushWaiters.length = 0
    pipeline.flushWaiters.push(...pending)
  }

  const fail = (pipeline: Pipeline, node: Node, reason: IngestFailure["reason"], message: string) => {
    if (pipeline.failure !== undefined) return
    pipeline.stopped = true
    const failure = IngestFailure.make({
      message,
      threadId: String(pipeline.threadId),
      turnId: String(pipeline.turnId),
      executionId: node.executionId,
      reason,
    })
    pipeline.failure = failure
    retainFailure(pipeline.turnId, failure)
    options.onFailure?.(failure)
    for (const waiter of pipeline.flushWaiters) Deferred.doneUnsafe(waiter.deferred, Effect.fail(failure))
    pipeline.flushWaiters.length = 0
    Deferred.doneUnsafe(pipeline.rootCommitted, Effect.fail(failure))
    pipeline.rootSettled.openUnsafe()
    pipeline.abandoned.openUnsafe()
    wake(pipeline)
  }

  const failProjection = (pipeline: Pipeline, failure: UsageCost.ProjectionFailure) => {
    if (pipeline.failure !== undefined) return
    pipeline.stopped = true
    pipeline.failure = failure
    retainFailure(pipeline.turnId, failure)
    options.onFailure?.(failure)
    for (const waiter of pipeline.flushWaiters) Deferred.doneUnsafe(waiter.deferred, Effect.fail(failure))
    pipeline.flushWaiters.length = 0
    Deferred.doneUnsafe(pipeline.rootCommitted, Effect.fail(failure))
    pipeline.rootSettled.openUnsafe()
    pipeline.abandoned.openUnsafe()
    wake(pipeline)
  }

  const markCheckpoint = (pipeline: Pipeline, node: Node) => {
    pipeline.delta.checkpoints.add(node.key)
    recordChange(pipeline)
  }

  const resolveChild = (pipeline: Pipeline, parent: Node, child: Node, visible?: IngestProjection.VisibleDelta) => {
    if (parent.parentKey !== undefined && parent.attachment === undefined) {
      const waiting = pipeline.unresolvedByParent.get(parent.key) ?? new Set<string>()
      waiting.add(child.key)
      pipeline.unresolvedByParent.set(parent.key, waiting)
      return
    }
    const localParent = TranscriptProjection.Fold.parentToolForChild(parent.fold, parent.executionId, child.executionId)
    if (localParent === undefined) {
      if (child.attachment !== undefined)
        fail(pipeline, child, "attachment", `Execution ${child.executionId} lost its durable parent tool`)
      else {
        const waiting = pipeline.unresolvedByParent.get(parent.key) ?? new Set<string>()
        waiting.add(child.key)
        pipeline.unresolvedByParent.set(parent.key, waiting)
      }
      return
    }
    const parentUnit = IngestProjection.globalizeUnit(parent, localParent, parent.attachment)
    const block =
      localParent.content._tag === "Block" && localParent.content.block._tag === "ToolCall"
        ? localParent.content.block
        : undefined
    if (block === undefined) return
    if (child.attachment !== undefined) {
      if (
        child.attachment.parentId !== block.id ||
        child.attachment.parentUnitKey !== parentUnit.key ||
        TranscriptOrdering.encodeUnitOrder(child.attachment.parentOrder) !==
          TranscriptOrdering.encodeUnitOrder(parentUnit.order)
      )
        fail(pipeline, child, "attachment", `Execution ${child.executionId} changed its durable parent path`)
      return
    }
    child.attachment = {
      parentId: block.id,
      parentUnitKey: parentUnit.key,
      parentToolId: block.id,
      parentOrder: parentUnit.order,
    }
    pipeline.unresolvedByParent.get(parent.key)?.delete(child.key)
    markCheckpoint(pipeline, child)
    for (const unit of TranscriptProjection.Fold.foldUnits(child.fold)) {
      pipeline.delta.units.set(unit.key, { owner: child.key, unit })
      visible?.set(unit.key, { owner: child.key, unit })
    }
    for (const grandchildKey of pipeline.unresolvedByParent.get(child.key) ?? []) {
      const grandchild = pipeline.nodes.get(grandchildKey)
      if (grandchild !== undefined) resolveChild(pipeline, child, grandchild, visible)
    }
  }

  const recordMutation = (
    pipeline: Pipeline,
    node: Node,
    mutation: TranscriptProjection.FoldMutation,
    visible?: IngestProjection.VisibleDelta,
  ) => {
    if (!mutation.stateChanged && mutation.units.upsert.length === 0 && mutation.units.remove.length === 0) return
    if (visible !== undefined) IngestProjection.recordVisibleMutation(visible, node.key, mutation)
    for (const key of mutation.units.remove) {
      pipeline.delta.units.set(key, { owner: node.key })
      pipeline.unitIndex.delete(key)
      pipeline.unitOwners.delete(key)
    }
    for (const unit of mutation.units.upsert) {
      pipeline.delta.units.set(unit.key, { owner: node.key, unit })
      pipeline.unitIndex.set(unit.key, unit)
      pipeline.unitOwners.set(unit.key, node.key)
    }
    markCheckpoint(pipeline, node)
    if (TranscriptProjection.Fold.foldHasRunningUnits(node.fold)) pipeline.runningNodes.add(node.key)
    else pipeline.runningNodes.delete(node.key)
    for (const childKey of pipeline.unresolvedByParent.get(node.key) ?? []) {
      const child = pipeline.nodes.get(childKey)
      if (child !== undefined) resolveChild(pipeline, node, child, visible)
    }
  }

  const applyMutation = (
    pipeline: Pipeline,
    node: Node,
    mutation: TranscriptProjection.FoldMutation,
    visible?: IngestProjection.VisibleDelta,
  ) => {
    recordMutation(pipeline, node, mutation, visible)
    const outcome = interruptedAncestorOutcome(pipeline.nodes, node)
    if (outcome !== undefined && TranscriptProjection.Fold.foldHasRunningUnits(node.fold))
      recordMutation(pipeline, node, TranscriptProjection.Fold.applyAncestorOutcome(node.fold, outcome), visible)
  }

  const applyDescendantOutcome = (
    pipeline: Pipeline,
    ancestor: Node,
    outcome: InterruptedOutcome,
    visible?: IngestProjection.VisibleDelta,
  ) => {
    for (const key of pipeline.runningNodes) {
      if (key === ancestor.key) continue
      const node = pipeline.nodes.get(key)
      if (node !== undefined && isDescendantOf(pipeline.nodes, node, ancestor.key))
        applyMutation(pipeline, node, TranscriptProjection.Fold.applyAncestorOutcome(node.fold, outcome), visible)
    }
  }

  let commitUsage: (
    pipeline: Pipeline,
    terminal: boolean,
  ) => Effect.Effect<boolean, UsageCost.ProjectionFailure | UsageRepository.RepositoryError>
  commitUsage = Effect.fn("ExecutionIngest.commitUsage")(function* (pipeline: Pipeline, terminal: boolean) {
    if (
      pipeline.usagePending.length === 0 &&
      pipeline.usageRefoldFromVersion === undefined &&
      pipeline.usageSourceComplete === terminal
    )
      return false
    const pending = pipeline.usagePending.slice()
    const desired = UsageCost.snapshotUsageFold(pipeline.usageFold)
    const complete = terminal
    const totals = {
      ...UsageCost.materialize(desired, String(pipeline.turnId), String(pipeline.threadId)),
      sourceComplete: complete,
    }
    const foldJson = UsageCost.serialize(desired)
    const sourceId = String(pipeline.turnId)
    const write =
      pipeline.usageRefoldFromVersion === undefined
        ? options.usage.commitSource(sourceId, String(pipeline.turnId), pipeline.usageRevision, foldJson, totals)
        : options.usage.replaceSource(
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
    const current = result.value ?? (yield* options.usage.readSource(sourceId, String(pipeline.turnId)))
    if (current === undefined || current.projectionVersion !== UsageRepository.projectionVersion)
      return yield* UsageCost.ProjectionFailure.make({
        message: `Usage source ${sourceId} has unsupported projection version`,
        reason: "unsupported-version",
      })
    const decoded =
      current.foldJson === undefined ? Result.succeed(UsageCost.empty) : UsageCost.deserialize(current.foldJson)
    if (Result.isFailure(decoded)) return yield* decoded.failure
    const replayed = UsageCost.foldBatch(
      decoded.success,
      pending,
      terminal ? new Set(pipeline.nodes.keys()) : new Set(),
    )
    if (Result.isFailure(replayed)) return yield* replayed.failure
    pipeline.usageSnapshot = decoded.success
    pipeline.usageFold = UsageCost.restoreUsageFold(replayed.success)
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
          if ((pipeline.refolding || pipeline.catchUp) && (!fullyConsumed(pipeline.nodes) || pipeline.reading > 0))
            return
          if (
            pipeline.delta.units.size === 0 &&
            pipeline.delta.checkpoints.size === 0 &&
            pipeline.usagePending.length === 0 &&
            pipeline.usageRefoldFromVersion === undefined &&
            !pipeline.usageNotificationPending
          ) {
            resolveFlushWaiters(pipeline)
            if (pipeline.reading <= 0) Deferred.doneUnsafe(pipeline.rootCommitted, Effect.void)
            return
          }
          const root = pipeline.nodes.get(pipeline.rootKey)!
          const turnResult = yield* Effect.result(options.turns.get(pipeline.turnId))
          if (turnResult._tag === "Failure") {
            fail(pipeline, root, "repository", String(turnResult.failure))
            return
          }
          const turn = turnResult.success
          if (turn === undefined) {
            fail(
              pipeline,
              root,
              "checkpoint",
              `Turn ${pipeline.turnId} disappeared while its projection was committing`,
            )
            return
          }
          if (!Turn.isAgentExecution(turn)) {
            fail(pipeline, root, "checkpoint", `Recorded shell turn ${pipeline.turnId} cannot enter execution ingest`)
            return
          }
          pipeline.turn = turn
          const unresolved = [...pipeline.nodes.values()].filter(
            (node) => node.parentKey !== undefined && node.attachment === undefined,
          )
          if (unresolved.length > 0 && fullyConsumed(pipeline.nodes) && pipeline.reading <= 0) {
            const key = unresolved[0]!.key
            fail(pipeline, pipeline.nodes.get(key)!, "attachment", `Execution ${key} has no final parent tool`)
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
          const terminal = fullyConsumed(pipeline.nodes)
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
              if (usageResult.failure._tag === "UsageProjectionFailure") failProjection(pipeline, usageResult.failure)
              else fail(pipeline, root, "repository", String(usageResult.failure))
              return
            }
            usageCommitted = usageResult.success
          }
          if (upsert.length === 0 && removals.length === 0 && changedCheckpoints.length === 0) {
            const notifyUsage = usageCommitted || usageChanged || pipeline.usageNotificationPending
            if (notifyUsage) {
              options.onCommitted?.({
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
              ? options.transcripts.replaceForRefold(
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
                    projectionVersion,
                    expectedProjectionVersion: pipeline.refoldFromVersion!,
                    expectedGeneration: pipeline.persistedGeneration!,
                  },
                )
              : options.transcripts
                  .commitDelta(
                    turn,
                    projectionState,
                    {
                      upsert,
                      remove: removals,
                    },
                    {
                      executionCheckpoints: changedCheckpoints,
                      projectionVersion,
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
            fail(pipeline, root, "repository", String(result.failure))
            return
          }
          if (result.success._tag === "Stale") {
            fail(pipeline, root, "checkpoint", `Turn ${pipeline.turnId} lost projection write authority`)
            return
          }
          pipeline.turn = result.success.turn
          pipeline.persistedGeneration = (pipeline.persistedGeneration ?? -1) + 1
          if (!deferredChanges) {
            pipeline.persistedVersion = Math.max(pipeline.persistedVersion, dirtyVersion)
            resolveFlushWaiters(pipeline)
          }
          const notifyUsage = usageCommitted || usageChanged || pipeline.usageNotificationPending
          options.onCommitted?.({
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

  let startNode: (pipeline: Pipeline, node: Node) => void
  let release: (pipeline: Pipeline, root: Node) => void

  const finishPipeline = (pipeline: Pipeline) => {
    if (pipeline.streamClosed) return
    if (pipeline.failure === undefined && !fullyConsumed(pipeline.nodes))
      fail(
        pipeline,
        pipeline.nodes.get(pipeline.rootKey)!,
        "checkpoint",
        `Turn ${pipeline.turnId} stopped before every execution reached a durable terminal outcome`,
      )
    pipeline.streamClosed = true
    if (pipeline.failure === undefined) {
      const root = pipeline.nodes.get(pipeline.rootKey)!
      publish(pipeline, {
        _tag: "ProjectionStopped",
        threadId: pipeline.threadId,
        rootTurnId: pipeline.turnId,
        streamId: pipeline.streamId,
        patchRevision: pipeline.patchRevision,
        status: root.status!,
      })
      return
    }
    publish(pipeline, {
      _tag: "ProjectionFailed",
      threadId: pipeline.threadId,
      rootTurnId: pipeline.turnId,
      streamId: pipeline.streamId,
      patchRevision: pipeline.patchRevision,
      failure: pipeline.failure,
    })
  }

  const settlePipeline = (pipeline: Pipeline) =>
    Deferred.doneUnsafe(pipeline.finished, pipeline.failure === undefined ? Effect.void : Effect.fail(pipeline.failure))

  const caught = (pipeline: Pipeline, node: Node) => {
    if (node.caught) return
    node.caught = true
    pipeline.reading -= 1
    if (pipeline.reading <= 0) wake(pipeline)
  }

  const discover = (
    pipeline: Pipeline,
    parent: Node,
    childExecutionId: string,
    visible?: IngestProjection.VisibleDelta,
  ) => {
    const key = TranscriptCorrelation.executionKey(childExecutionId)
    if (key.length === 0 || key === parent.key || pipeline.nodes.has(key)) return
    const localVisible = visible ?? new Map<string, { readonly owner: string; readonly unit?: TranscriptUnit.Unit }>()
    const node: Node = {
      executionId: childExecutionId,
      key,
      parentKey: parent.key,
      fold: TranscriptProjection.Fold.restoreProjectionFold(childProjectionOf(key, [])),
      durableCursors: new Map(),
      cursor: undefined,
      sequence: -1,
      status: undefined,
      resumed: false,
      caught: false,
      attachment: undefined,
    }
    pipeline.nodes.set(key, node)
    pipeline.order.push(key)
    for (const unit of TranscriptProjection.Fold.foldUnits(node.fold)) {
      pipeline.unitIndex.set(unit.key, unit)
      pipeline.unitOwners.set(unit.key, node.key)
      pipeline.delta.units.set(unit.key, { owner: node.key, unit })
    }
    markCheckpoint(pipeline, node)
    resolveChild(pipeline, parent, node, localVisible)
    options.onDiscovered?.({ threadId: pipeline.threadId, rootTurnId: pipeline.turnId, executionId: childExecutionId })
    wake(pipeline)
    if (visible === undefined && localVisible.size > 0)
      publishPatch(pipeline, { _tag: "Discovery", executionId: childExecutionId }, localVisible)
    startNode(pipeline, node)
  }

  const accept = (pipeline: Pipeline, node: Node, event: ExecutionBackend.Event) => {
    if (pipeline.stopped || !pipeline.accepting) return
    try {
      if (event.executionId.length > 0 && !ExecutionId.ownsExecution(node.key, event.executionId)) return
      const visible: IngestProjection.VisibleDelta = new Map()
      if (TranscriptProjection.Fold.isTransientEvent(event)) {
        const mutation = TranscriptProjection.Fold.applyFoldEvent(node.fold, event)
        if (!mutation.stateChanged && mutation.units.upsert.length === 0 && mutation.units.remove.length === 0) return
        IngestProjection.recordVisibleMutation(visible, node.key, mutation)
        publishPatch(pipeline, IngestProjection.eventOrigin(node.executionId, event), visible)
        return
      }
      const cursorSequence = node.durableCursors.get(event.cursor)
      if (cursorSequence !== undefined) {
        if (cursorSequence !== event.sequence)
          fail(
            pipeline,
            node,
            "cursor-rejected",
            `Execution ${node.executionId} reused durable cursor ${event.cursor} from sequence ${cursorSequence} at sequence ${event.sequence}`,
          )
        return
      }
      if (event.sequence <= node.sequence) {
        if (node.resumed)
          fail(
            pipeline,
            node,
            "cursor-rejected",
            `Execution ${node.executionId} replayed sequence ${event.sequence} at or before consumed sequence ${node.sequence}`,
          )
        return
      }
      const observation = {
        threadId: String(pipeline.threadId),
        turnId: String(pipeline.turnId),
        event,
      }
      const terminal = ExecutionStatus.terminalEventStatus(event.type)
      const usage = UsageCost.applyUsageFoldEvent(pipeline.usageFold, observation)
      if (Result.isFailure(usage)) {
        failProjection(pipeline, usage.failure)
        return
      }
      node.resumed = false
      applyMutation(pipeline, node, TranscriptProjection.Fold.applyFoldEvent(node.fold, event), visible)
      node.durableCursors.set(event.cursor, event.sequence)
      node.cursor = event.cursor
      node.sequence = event.sequence
      markCheckpoint(pipeline, node)
      pipeline.pending += 1
      if (terminal !== undefined) {
        node.status = settledStatus(terminal)
        const outcome = TranscriptProjection.Fold.foldExecutionOutcome(node.fold)
        if (outcome === undefined)
          return fail(
            pipeline,
            node,
            "backend",
            `Execution ${node.executionId} emitted a terminal event without a projected outcome`,
          )
        if (isInterruptedOutcome(outcome)) applyDescendantOutcome(pipeline, node, outcome, visible)
        if (node.parentKey !== undefined) {
          const parent = pipeline.nodes.get(node.parentKey)
          if (parent !== undefined)
            applyMutation(
              pipeline,
              parent,
              TranscriptProjection.Fold.applyChildOutcome(parent.fold, node.executionId, outcome),
              visible,
            )
        }
        wake(pipeline)
        if (node.parentKey === undefined) pipeline.rootSettled.openUnsafe()
      } else if (pipeline.pending >= commitEvents) wake(pipeline)
      for (const childExecutionId of spawnedChildIds(event)) discover(pipeline, node, childExecutionId, visible)
      if (UsageCost.usageFoldChanged(pipeline.usageFold)) pipeline.usagePending.push(observation)
      publishPatch(pipeline, IngestProjection.eventOrigin(node.executionId, event), visible)
    } catch (cause) {
      fail(pipeline, node, "backend", String(cause))
    }
  }

  const pageNode = (pipeline: Pipeline, node: Node, reference: ExecutionBackend.ExecutionReference | undefined) =>
    Effect.gen(function* () {
      if (options.backend.pageEvents === undefined) {
        const result = yield* options.backend.replay(node.executionId, node.cursor, reference)
        for (const event of result.events.toSorted(bySequence)) accept(pipeline, node, event)
        return
      }
      const cursors = new Set<string>()
      let after = node.cursor
      while (!pipeline.stopped) {
        const page = yield* options.backend.pageEvents(node.executionId, "forward", after, 200, reference)
        for (const event of page.events.toSorted(bySequence)) accept(pipeline, node, event)
        if (!page.hasMore) return
        const next = page.newestCursor
        if (page.events.length === 0 || next === undefined || next === after || cursors.has(next))
          return fail(
            pipeline,
            node,
            "backend",
            `Execution ${node.executionId} reported more events after cursor ${after ?? "start"} but its page cursor did not advance`,
          )
        cursors.add(next)
        after = next
      }
    })

  const followNode = (pipeline: Pipeline, node: Node) =>
    Effect.gen(function* () {
      if (node.status !== undefined) return
      const reference = node.parentKey === undefined ? undefined : ExecutionBackend.executionReference
      const inspection = yield* options.backend.inspect(node.executionId, reference)
      if (inspection !== undefined) for (const child of inspection.children) discover(pipeline, node, child.executionId)
      const follow = options.backend.follow
      const owned = node.parentKey === undefined && !pipeline.catchUp
      if (owned) {
        if (inspection !== undefined) yield* pageNode(pipeline, node, reference)
        release(pipeline, node)
        caught(pipeline, node)
        if (pipeline.stopped || node.status !== undefined) return
        return yield* pipeline.rootSettled.await
      }
      if (follow === undefined) {
        yield* pageNode(pipeline, node, reference)
        if (pipeline.stopped || node.status !== undefined) return
        if (inspection === undefined || !isTerminalStatus(inspection.status)) {
          if (pipeline.catchUp)
            return fail(
              pipeline,
              node,
              "backend",
              `Execution ${node.executionId} ended catch-up without a durable terminal event`,
            )
          return
        }
        if (node.sequence < 0)
          return fail(
            pipeline,
            node,
            "backend",
            `Execution ${node.executionId} is terminal but exposed no durable events`,
          )
        return fail(
          pipeline,
          node,
          "backend",
          `Execution ${node.executionId} is terminal without a projected durable terminal outcome`,
        )
      }
      if (inspection === undefined || !isTerminalStatus(inspection.status)) caught(pipeline, node)
      while (!pipeline.stopped) {
        const before = node.cursor
        const delivered = new Set<string>()
        node.resumed = node.cursor !== undefined
        const result = yield* follow(
          node.executionId,
          node.cursor,
          (event) => {
            delivered.add(event.cursor)
            accept(pipeline, node, event)
          },
          reference,
          "execution",
        )
        for (const event of result.events) if (!delivered.has(event.cursor)) accept(pipeline, node, event)
        if (pipeline.stopped) return
        if (node.status !== undefined) return
        if (isTerminalStatus(result.status)) {
          if (node.sequence < 0)
            return fail(
              pipeline,
              node,
              "backend",
              `Execution ${node.executionId} is terminal but exposed no durable events`,
            )
          return fail(
            pipeline,
            node,
            "backend",
            `Execution ${node.executionId} is terminal without a projected durable terminal outcome`,
          )
        }
        if (node.cursor === before) return
      }
    })

  release = (pipeline, root) => {
    const held = pipeline.delivered
    if (held === undefined) return
    pipeline.delivered = undefined
    for (const event of held.toSorted((left, right) => left.sequence - right.sequence)) accept(pipeline, root, event)
  }

  startNode = (pipeline, node) => {
    pipeline.active += 1
    pipeline.reading += 1
    pipeline.fork(
      followNode(pipeline, node).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.suspend(() => {
                const message = String(Cause.squash(cause))
                fail(pipeline, node, "backend", message)
                return Effect.logWarning("execution.ingest.follow.failed").pipe(
                  Effect.annotateLogs({
                    "rika.thread.id": String(pipeline.threadId),
                    "rika.turn.id": String(pipeline.turnId),
                    "rika.execution.id": node.executionId,
                    "rika.failure.cause": message,
                  }),
                )
              }),
        ),
        Effect.ensuring(
          Effect.suspend(() => {
            if (node.parentKey === undefined) release(pipeline, node)
            caught(pipeline, node)
            return commit(pipeline)
          }),
        ),
        Effect.ensuring(
          Effect.suspend(() => {
            pipeline.active -= 1
            finishReaders(pipeline)
            return Effect.void
          }),
        ),
      ),
    )
  }

  const drive = (pipeline: Pipeline, pipelineScope: Scope.Closeable) =>
    Effect.gen(function* () {
      const committing = yield* Effect.forkChild(
        Effect.gen(function* () {
          while (true) {
            yield* Effect.raceFirst(Effect.sleep(commitWindow), Queue.take(pipeline.wake))
            yield* commit(pipeline)
          }
        }),
      )
      pipeline.active += 1
      pipeline.reading += 1
      const restored = pipeline.order.slice()
      for (const key of restored) {
        const node = pipeline.nodes.get(key)
        if (node !== undefined && (key === pipeline.rootKey || node.status === undefined)) startNode(pipeline, node)
      }
      pipeline.reading -= 1
      if (pipeline.reading <= 0) wake(pipeline)
      pipeline.active -= 1
      finishReaders(pipeline)
      yield* Effect.raceFirst(pipeline.readersFinished.await, pipeline.abandoned.await)
      yield* Fiber.interrupt(committing)
      yield* Scope.close(pipelineScope, Exit.void)
      pipeline.accepting = false
      yield* commit(pipeline)
      if (
        pipeline.failure === undefined &&
        (pipeline.delta.units.size > 0 ||
          pipeline.delta.checkpoints.size > 0 ||
          pipeline.usagePending.length > 0 ||
          pipeline.usageRefoldFromVersion !== undefined ||
          pipeline.usageNotificationPending)
      )
        fail(
          pipeline,
          pipeline.nodes.get(pipeline.rootKey)!,
          "checkpoint",
          `Turn ${pipeline.turnId} stopped before every accepted projection change became durable`,
        )
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() => {
          finishPipeline(pipeline)
          if (pipelines.get(String(pipeline.turnId)) === pipeline) pipelines.delete(String(pipeline.turnId))
          settlePipeline(pipeline)
          if (pipeline.refolding)
            options.onRefold?.({ threadId: pipeline.threadId, rootTurnId: pipeline.turnId, phase: "finished" })
          const failure = pipeline.failure
          const logged =
            failure === undefined
              ? Effect.void
              : Effect.logWarning("execution.ingest.stopped").pipe(
                  Effect.annotateLogs({
                    "rika.thread.id": failure.threadId,
                    "rika.turn.id": failure.turnId,
                    "rika.execution.id": failure.executionId,
                    "rika.ingest.reason": failure.reason,
                    "rika.failure.cause": failure.message,
                  }),
                )
          return logged.pipe(Effect.andThen(Scope.close(pipelineScope, Exit.void)))
        }),
      ),
    )

  const ensure = Effect.fn("ExecutionIngest.ensure")(function* (root: Root) {
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
        if (turn !== undefined && !Turn.isAgentExecution(turn))
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
        if (usageSource.projectionVersion > UsageRepository.projectionVersion)
          return yield* UsageCost.ProjectionFailure.make({
            message: `Usage source ${usageSourceId} has unsupported projection version ${usageSource.projectionVersion}`,
            reason: "unsupported-version",
            threadId: String(root.threadId),
            turnId: String(root.turnId),
          })
        const usageRefoldFromVersion =
          usageSource.projectionVersion < UsageRepository.projectionVersion ? usageSource.projectionVersion : undefined
        const usageDecoded =
          usageRefoldFromVersion !== undefined || usageSource.foldJson === undefined
            ? Result.succeed(UsageCost.empty)
            : UsageCost.deserialize(usageSource.foldJson)
        if (Result.isFailure(usageDecoded)) return yield* usageDecoded.failure
        const restored = restore(turn, refolding ? undefined : stored)
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
          const attachmentFailure = validateStoredAttachments(turn, stored, restored.nodes, restoredAttachments)
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
            if (ancestorOutcome !== undefined && TranscriptProjection.Fold.foldHasRunningUnits(node.fold))
              return yield* IngestFailure.make({
                message: `Transcript ${root.turnId} has running descendant state beneath a ${ancestorOutcome.status} execution`,
                threadId: String(root.threadId),
                turnId: String(root.turnId),
                executionId: node.executionId,
                reason: "checkpoint",
              })
            const outcome = TranscriptProjection.Fold.foldExecutionOutcome(node.fold)
            if (outcome === undefined) continue
            const parent = restored.nodes.get(node.parentKey)!
            const validation = TranscriptProjection.Fold.applyChildOutcome(parent.fold, node.executionId, outcome)
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
        const unitIndex = new Map<string, TranscriptUnit.Unit>()
        const unitOwners = new Map<string, string>()
        for (const [key, node] of restored.nodes)
          for (const unit of TranscriptProjection.Fold.foldUnits(node.fold)) {
            unitIndex.set(unit.key, unit)
            unitOwners.set(unit.key, key)
          }
        const pipelineScope = yield* Scope.make()
        nextStreamId += 1
        const pipeline: Pipeline = {
          threadId: root.threadId,
          turnId: root.turnId,
          rootKey: TranscriptCorrelation.executionKey(String(root.turnId)),
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
          usageFold: UsageCost.restoreUsageFold(usageDecoded.success),
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
            [...restored.nodes].flatMap(([key, node]) =>
              TranscriptProjection.Fold.foldHasRunningUnits(node.fold) ? [key] : [],
            ),
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
    consumed: Effect.fn("ExecutionIngest.consumed")(function* (turnId: Turn.TurnId) {
      const pipeline = pipelines.get(String(turnId))
      if (pipeline !== undefined) return yield* Deferred.await(pipeline.rootCommitted)
      const failure = failedPipelines.get(String(turnId))
      if (failure !== undefined) return yield* failure
    }),
    flush: Effect.fn("ExecutionIngest.flush")(function* (turnId: Turn.TurnId) {
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
    settled: Effect.fn("ExecutionIngest.settled")(function* (turnId: Turn.TurnId) {
      const pipeline = pipelines.get(String(turnId))
      if (pipeline !== undefined) return yield* Deferred.await(pipeline.finished)
      const failure = failedPipelines.get(String(turnId))
      if (failure !== undefined) return yield* failure
    }),
  } satisfies Interface
})
