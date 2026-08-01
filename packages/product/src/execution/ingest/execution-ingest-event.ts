import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import * as ExecutionBackend from "../contract/execution-service"
import type { Node } from "./execution-ingest-state"
import type { InterruptedOutcome } from "./execution-ingest-state"

export const isInterruptedOutcome = (
  outcome: NonNullable<TranscriptUnit.Unit["executionOutcome"]>,
): outcome is InterruptedOutcome => outcome.status === "failed" || outcome.status === "cancelled"

export const childExecutionIds = (event: ExecutionBackend.Event): ReadonlyArray<string> => {
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

export const bySequence = (left: ExecutionBackend.Event, right: ExecutionBackend.Event) =>
  left.sequence - right.sequence

export const fullyConsumed = (nodes: ReadonlyMap<string, Node>): boolean =>
  [...nodes.values()].every((node) => node.status !== undefined)

import * as TranscriptCorrelation from "@rika/transcript/child-parent-correlation"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as ExecutionStatus from "../contract/execution-status"
import { ExecutionId } from "../contract/execution-identifier"
import { Cause, Effect, Result } from "effect"
import * as IngestProjection from "./execution-projection-state"
import * as IngestState from "./execution-ingest-state"
import type { VisibleDelta } from "./execution-projection-types"
import * as IngestRestore from "./execution-ingest-restore"
import type { Pipeline } from "./execution-ingest-state"
import type { Options, IngestFailure } from "./execution-ingest-service"
import * as UsageCost from "../../usage/usage-projection"

export interface EventDependencies {
  readonly options: Options
  readonly commit: (pipeline: Pipeline) => Effect.Effect<void, never>
  readonly fail: (pipeline: Pipeline, node: Node, reason: IngestFailure["reason"], message: string) => void
  readonly failProjection: (
    pipeline: Pipeline,
    failure: import("../../usage/usage-projection").ProjectionFailure,
  ) => void
  readonly publishPatch: (
    pipeline: Pipeline,
    origin: import("./execution-projection-contract").ProjectionOrigin,
    visible: VisibleDelta,
  ) => void
  readonly wake: (pipeline: Pipeline) => void
  readonly publish: (pipeline: Pipeline, change: import("./execution-ingest-service").ProjectionChange) => void
  readonly commitEvents: number
  readonly finishPipeline: (pipeline: Pipeline) => void
  readonly settlePipeline: (pipeline: Pipeline) => void
}

const interruptedAncestorOutcome = (nodes: ReadonlyMap<string, Node>, node: Node): InterruptedOutcome | undefined =>
  IngestRestore.interruptedAncestorOutcome(nodes, node, isInterruptedOutcome)
const spawnedChildIds = childExecutionIds
const isDescendant = (nodes: ReadonlyMap<string, Node>, node: Node, ancestorKey: string): boolean => {
  let parentKey = node.parentKey
  while (parentKey !== undefined) {
    if (parentKey === ancestorKey) return true
    parentKey = nodes.get(parentKey)?.parentKey
  }
  return false
}
const settledStatus = (
  status: ExecutionBackend.Status,
): NonNullable<import("@rika/product/transcript-repository").ExecutionCheckpoint["status"]> | undefined =>
  status === "completed" || status === "failed" || status === "cancelled" ? status : undefined
const isTerminalStatus = ExecutionStatus.isTerminalStatus
export const make = (dependencies: EventDependencies) => {
  const markCheckpoint = (pipeline: Pipeline, node: Node) => {
    pipeline.delta.checkpoints.add(node.key)
    IngestState.recordChange(pipeline)
  }

  const resolveChild = (pipeline: Pipeline, parent: Node, child: Node, visible?: VisibleDelta) => {
    if (parent.parentKey !== undefined && parent.attachment === undefined) {
      const waiting = pipeline.unresolvedByParent.get(parent.key) ?? new Set<string>()
      waiting.add(child.key)
      pipeline.unresolvedByParent.set(parent.key, waiting)
      return
    }
    const localParent = TranscriptProjection.Fold.parentToolForChild(parent.fold, parent.executionId, child.executionId)
    if (localParent === undefined) {
      if (child.attachment !== undefined)
        dependencies.fail(pipeline, child, "attachment", `Execution ${child.executionId} lost its durable parent tool`)
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
        dependencies.fail(
          pipeline,
          child,
          "attachment",
          `Execution ${child.executionId} changed its durable parent path`,
        )
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
    visible?: VisibleDelta,
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
    visible?: VisibleDelta,
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
    visible?: VisibleDelta,
  ) => {
    for (const key of pipeline.runningNodes) {
      if (key === ancestor.key) continue
      const node = pipeline.nodes.get(key)
      if (node !== undefined && isDescendant(pipeline.nodes, node, ancestor.key))
        applyMutation(pipeline, node, TranscriptProjection.Fold.applyAncestorOutcome(node.fold, outcome), visible)
    }
  }

  let startNode: (pipeline: Pipeline, node: Node) => void
  let release: (pipeline: Pipeline, root: Node) => void

  const caught = (pipeline: Pipeline, node: Node) => {
    if (node.caught) return
    node.caught = true
    pipeline.reading -= 1
    if (pipeline.reading <= 0) dependencies.wake(pipeline)
  }

  const discover = (pipeline: Pipeline, parent: Node, childExecutionId: string, visible?: VisibleDelta) => {
    const key = TranscriptCorrelation.executionKey(childExecutionId)
    if (key.length === 0 || key === parent.key || pipeline.nodes.has(key)) return
    const localVisible = visible ?? new Map<string, { readonly owner: string; readonly unit?: TranscriptUnit.Unit }>()
    const node: Node = {
      executionId: childExecutionId,
      key,
      parentKey: parent.key,
      fold: TranscriptProjection.Fold.restoreProjectionFold(TranscriptProjection.Projection.empty(key, "")),
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
    dependencies.options.onDiscovered?.({
      threadId: pipeline.threadId,
      rootTurnId: pipeline.turnId,
      executionId: childExecutionId,
    })
    dependencies.wake(pipeline)
    if (visible === undefined && localVisible.size > 0)
      dependencies.publishPatch(pipeline, { _tag: "Discovery", executionId: childExecutionId }, localVisible)
    startNode(pipeline, node)
  }

  const accept = (pipeline: Pipeline, node: Node, event: ExecutionBackend.Event) => {
    if (pipeline.stopped || !pipeline.accepting) return
    try {
      if (event.executionId.length > 0 && !ExecutionId.ownsExecution(node.key, event.executionId)) return
      const visible: VisibleDelta = new Map()
      if (TranscriptProjection.Fold.isTransientEvent(event)) {
        const mutation = TranscriptProjection.Fold.applyFoldEvent(node.fold, event)
        if (!mutation.stateChanged && mutation.units.upsert.length === 0 && mutation.units.remove.length === 0) return
        IngestProjection.recordVisibleMutation(visible, node.key, mutation)
        dependencies.publishPatch(pipeline, IngestProjection.eventOrigin(node.executionId, event), visible)
        return
      }
      const cursorSequence = node.durableCursors.get(event.cursor)
      if (cursorSequence !== undefined) {
        if (cursorSequence !== event.sequence)
          dependencies.fail(
            pipeline,
            node,
            "cursor-rejected",
            `Execution ${node.executionId} reused durable cursor ${event.cursor} from sequence ${cursorSequence} at sequence ${event.sequence}`,
          )
        return
      }
      if (event.sequence <= node.sequence) {
        if (node.resumed)
          dependencies.fail(
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
        dependencies.failProjection(pipeline, usage.failure)
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
          return dependencies.fail(
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
        dependencies.wake(pipeline)
        if (node.parentKey === undefined) pipeline.rootSettled.openUnsafe()
      } else if (pipeline.pending >= dependencies.commitEvents) dependencies.wake(pipeline)
      for (const childExecutionId of spawnedChildIds(event)) discover(pipeline, node, childExecutionId, visible)
      if (UsageCost.usageFoldChanged(pipeline.usageFold)) pipeline.usagePending.push(observation)
      dependencies.publishPatch(pipeline, IngestProjection.eventOrigin(node.executionId, event), visible)
    } catch (cause) {
      dependencies.fail(pipeline, node, "backend", String(cause))
    }
  }

  const pageNode = (pipeline: Pipeline, node: Node, reference: ExecutionBackend.ExecutionReference | undefined) =>
    Effect.gen(function* () {
      if (dependencies.options.backend.pageEvents === undefined) {
        const result = yield* dependencies.options.backend.replay(node.executionId, node.cursor, reference)
        for (const event of result.events.toSorted(bySequence)) accept(pipeline, node, event)
        return
      }
      const cursors = new Set<string>()
      let after = node.cursor
      while (!pipeline.stopped) {
        const page = yield* dependencies.options.backend.pageEvents(node.executionId, "forward", after, 200, reference)
        for (const event of page.events.toSorted(bySequence)) accept(pipeline, node, event)
        if (!page.hasMore) return
        const next = page.newestCursor
        if (page.events.length === 0 || next === undefined || next === after || cursors.has(next))
          return dependencies.fail(
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
      const inspection = yield* dependencies.options.backend.inspect(node.executionId, reference)
      if (inspection !== undefined) for (const child of inspection.children) discover(pipeline, node, child.executionId)
      const follow = dependencies.options.backend.follow
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
            return dependencies.fail(
              pipeline,
              node,
              "backend",
              `Execution ${node.executionId} ended catch-up without a durable terminal event`,
            )
          return
        }
        if (node.sequence < 0)
          return dependencies.fail(
            pipeline,
            node,
            "backend",
            `Execution ${node.executionId} is terminal but exposed no durable events`,
          )
        return dependencies.fail(
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
            return dependencies.fail(
              pipeline,
              node,
              "backend",
              `Execution ${node.executionId} is terminal but exposed no durable events`,
            )
          return dependencies.fail(
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
                dependencies.fail(pipeline, node, "backend", message)
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
            return dependencies.commit(pipeline)
          }),
        ),
        Effect.ensuring(
          Effect.suspend(() => {
            pipeline.active -= 1
            IngestState.finishReaders(pipeline)
            return Effect.void
          }),
        ),
      ),
    )
  }

  return {
    startNode,
    release,
    accept,
    finishPipeline: dependencies.finishPipeline,
    settlePipeline: dependencies.settlePipeline,
  }
}
