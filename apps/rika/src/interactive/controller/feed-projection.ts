import * as ThreadView from "@rika/product/thread-view"
import { steeringUnitKeyPrefix } from "@rika/product/execution-projection"
import * as ExecutionStatus from "@rika/product/execution-status"
import { maxInMemoryTranscriptUnits, trimTranscriptTimeline } from "@rika/terminal/terminal-timeline-bounds"
import { finishingActivity, runningToolsActivity as transcriptActivity } from "@rika/terminal/terminal-message"
import { applyRootUnits, applyTurnDelta } from "@rika/terminal/terminal-transcript-presentation"
import type { Model } from "@rika/terminal/terminal-state"
import { update as updateModel } from "@rika/terminal/terminal-state-reducer"
import { overlayPendingSubmissions } from "@rika/terminal/terminal-submission-state"
import type { Unit } from "@rika/transcript/transcript-unit"
import * as ModelPreview from "./model-preview"

const finishingUnitActivity = (previousActivity: Model["activity"]): Model["activity"] => {
  if (
    previousActivity?._tag === "Finishing" ||
    previousActivity?._tag === "Thinking" ||
    previousActivity?._tag === "Streaming"
  )
    return finishingActivity(previousActivity)
  return finishingActivity(undefined)
}

const retainedActivity = (
  model: Model,
  active: ThreadView.ThreadViewTurnState | undefined,
  threadId: string,
): Model["activity"] =>
  model.currentThreadId === threadId && model.activeTurnId === String(active?.turn.id) ? model.activity : undefined

const activeUnitActivity = (
  entry: ThreadView.ThreadViewTurnState | undefined,
  modelPreview: ModelPreview.Overlay | undefined,
  model: Model,
  previousActivity: Model["activity"],
): Model["activity"] => {
  if (entry === undefined) return undefined
  if (entry.turn.status === "waiting") return { _tag: "Waiting" }
  const previewActivity = ModelPreview.activity(modelPreview, String(entry.turn.id))
  if (previewActivity?.active === true) {
    const { active: _, ...activity } = previewActivity
    return activity
  }
  const activity = transcriptActivity(model)
  if ((activity.subagents ?? 0) !== 0 || (activity.tools ?? 0) !== 0) return activity
  if (previewActivity !== undefined) {
    const { active: _, ...settledPreviewActivity } = previewActivity
    return settledPreviewActivity
  }
  const turnId = String(entry.turn.id)
  const latest = model.entries.findLast((candidate) => candidate.turnId === turnId)
  return latest?.role === "assistant" ? finishingUnitActivity(previousActivity) : { _tag: "Waiting" }
}

const clearTimeline = (model: Model): Model => ({
  ...model,
  entries: [],
  blocks: [],
  items: [],
  transcriptTruncated: false,
  seenEventIds: [],
  childExecutionOutcomes: {},
  eventCursor: undefined,
})

const latestErrorBlock = (units: ReadonlyArray<Unit>) =>
  units
    .flatMap((unit) =>
      unit.content._tag === "Block" && unit.content.block._tag === "Error" ? [unit.content.block] : [],
    )
    .at(-1)

const applySettlement = (
  projected: Model,
  previous: Model,
  active: ThreadView.ThreadViewTurnState | undefined,
  settled: ThreadView.ThreadViewTurnState | undefined,
  units: ReadonlyArray<Unit>,
): Model => {
  if (active !== undefined || settled === undefined) return projected
  if (settled.turn.status === "completed")
    return updateModel(projected, { _tag: "ExecutionCompleted", turnId: settled.turn.id })
  if (settled.turn.status === "cancelled")
    return updateModel(
      { ...projected, activeTurnId: previous.activeTurnId, busy: previous.busy },
      {
        _tag: "ExecutionCancelled",
        turnId: settled.turn.id,
        agentResponseArrived: units.some((unit) => unit.content._tag === "Block" || unit.content.role !== "user"),
      },
    )
  if (settled.turn.status !== "failed") return projected
  const error = latestErrorBlock(units)
  const retryable = error?.retryable === true
  return updateModel(projected, {
    _tag: "ExecutionFailed",
    turnId: settled.turn.id,
    failure: {
      tag: "TurnFailed",
      category: error?.category ?? "operation",
      message:
        error?.detail !== undefined && error.detail.length > 0 ? error.detail : (error?.title ?? "Execution failed"),
      retryable,
      retry: retryable ? "automatic" : "none",
      actor: "environment",
    },
  })
}

type Usage = ThreadView.ThreadViewSnapshot["usage"]

const contextUsage = (usage: Usage, started: boolean): NonNullable<Model["contextUsage"]> => {
  if (usage.state.context !== undefined && usage.contextCapacity !== undefined)
    return {
      _tag: "Available",
      inputTokens: usage.state.context.inputTokens,
      inputCacheRead: usage.state.tokens?.input.cacheRead ?? 0,
      inputTotal: usage.state.tokens?.input.total ?? 0,
      contextWindow: usage.contextCapacity.contextWindow,
      reserveTokens: usage.contextCapacity.reserveTokens,
    }
  if (usage.state.contextPending) return { _tag: "Loading" }
  return started ? { _tag: "Unavailable" } : { _tag: "NotStarted" }
}

const usageCost = (usage: Usage): NonNullable<Model["usageCost"]> => {
  const includedAttempts = usage.state.includedAttempts ?? 0
  if (usage.state.costNanoUsd !== undefined)
    return {
      _tag: "Available",
      usd: usage.state.costNanoUsd / 1_000_000_000,
      unpricedAttempts: usage.state.unpricedAttempts,
      includedAttempts,
    }
  return includedAttempts > 0 ? { _tag: "Included", includedAttempts } : { _tag: "Unavailable" }
}

const applyUsage = (model: Model, usage: Usage, started: boolean): Model => {
  const withContext = updateModel(model, {
    _tag: "ContextUsageReplaced",
    contextUsage: contextUsage(usage, started),
  })
  return trimTranscriptTimeline(
    {
      ...withContext,
      usageCost: usageCost(usage),
      usageTokens:
        usage.state.tokens?.total === undefined
          ? { _tag: "Unavailable" }
          : {
              _tag: "Available",
              total: usage.state.tokens.total,
              uncountedAttempts: usage.state.uncountedAttempts,
            },
      usageTime: usage.state.active,
    },
    maxInMemoryTranscriptUnits,
  )
}

const snapshotSteering = (model: Model, snapshot: ThreadView.ThreadViewSnapshot) => {
  const pending = snapshot.turns.flatMap((entry) =>
    (entry.pendingSteering ?? []).map((steering) => ({ ...steering, turnId: String(entry.turn.id) })),
  )
  const pendingIds = new Set(pending.map((steering) => steering.requestId))
  const settledIds = new Set(
    snapshot.turns.flatMap((entry) => (entry.settledSteering ?? []).map((steering) => steering.requestId)),
  )
  const unitKeys = snapshot.turns.flatMap((entry) => entry.units.map((unit) => unit.key))
  return {
    pending,
    requests: model.steeringRequests.filter(
      (request) =>
        !pendingIds.has(request.requestId) &&
        !settledIds.has(request.requestId) &&
        !unitKeys.some((key) => key.startsWith(`${steeringUnitKeyPrefix(request.turnId, request.requestId)}:`)),
    ),
  }
}

const snapshotBase = (
  model: Model,
  snapshot: ThreadView.ThreadViewSnapshot,
  preserveOptimisticState: boolean,
): Model => {
  const active = snapshot.turns.find((entry) => ExecutionStatus.isActiveStatus(entry.turn.status))
  const editing = model.editingTurnId !== undefined && snapshot.pending.some((item) => item.id === model.editingTurnId)
  const steering = snapshotSteering(model, snapshot)
  return {
    ...clearTimeline(model),
    transcriptTruncated: snapshot.hasOlder,
    currentThreadId: String(snapshot.thread.id),
    currentThreadTitle: snapshot.thread.title,
    activeTurnId: active === undefined ? undefined : String(active.turn.id),
    busy: active !== undefined,
    activity: undefined,
    pendingSteering: steering.pending,
    steeringRequests: preserveOptimisticState ? steering.requests : [],
    submittedDrafts: preserveOptimisticState ? model.submittedDrafts : [],
    editingTurnId: editing ? model.editingTurnId : undefined,
    editReturn: editing ? model.editReturn : undefined,
    queue: snapshot.pending.map((item) => ({ id: item.id, prompt: item.prompt })),
    queueSelection: snapshot.pending.some((item) => item.id === model.queueSelection)
      ? model.queueSelection
      : snapshot.pending.at(-1)?.id,
    queueThreadId: String(snapshot.thread.id),
    queueRevision: snapshot.revision,
    threadSidebar: {
      ...model.threadSidebar,
      selected: Math.max(
        0,
        model.threads.findIndex((thread) => thread.id === snapshot.thread.id),
      ),
    },
    threadPreview: { _tag: "Idle" },
  }
}

const projectSnapshot = (
  model: Model,
  view: ThreadView.ThreadViewAccumulator,
  preserveOptimisticState: boolean,
  modelPreview?: ModelPreview.Overlay,
): Model => {
  const snapshot = view.snapshot()
  const active = snapshot.turns.find((entry) => ExecutionStatus.isActiveStatus(entry.turn.status))
  let next = snapshotBase(model, snapshot, preserveOptimisticState)
  for (const entry of snapshot.turns) next = applyRootUnits(next, String(entry.turn.id), entry.units)
  const previewUnits = ModelPreview.units(modelPreview, view)
  if (previewUnits[0] !== undefined) next = applyRootUnits(next, previewUnits[0].turnId, previewUnits)
  if (preserveOptimisticState) next = overlayPendingSubmissions(next, model)
  next = {
    ...next,
    activity: activeUnitActivity(
      active,
      modelPreview,
      next,
      retainedActivity(model, active, String(snapshot.thread.id)),
    ),
  }
  const settled = snapshot.turns.find((entry) => String(entry.turn.id) === model.activeTurnId)
  next = applySettlement(next, model, active, settled, settled?.units ?? [])
  return applyUsage(next, snapshot.usage, snapshot.turns.length > 0 || snapshot.pending.length > 0)
}

const patchSteering = (model: Model, delta: ThreadView.ThreadViewDelta) => {
  const changedTurnIds = new Set(delta.turns.map((turn) => turn.turnId))
  const pending = [
    ...model.pendingSteering.filter((steering) => !changedTurnIds.has(steering.turnId)),
    ...delta.turns.flatMap((turn) =>
      (turn.current?.pendingSteering ?? []).map((steering) => ({ ...steering, turnId: turn.turnId })),
    ),
  ]
  const pendingIds = new Set(pending.map((steering) => steering.requestId))
  const settledIds = new Set(
    delta.turns.flatMap((turn) => (turn.current?.settledSteering ?? []).map((steering) => steering.requestId)),
  )
  const unitKeys = delta.turns.flatMap((turn) => turn.upsert.map((unit) => unit.key))
  return {
    pending,
    requests: model.steeringRequests.filter(
      (request) =>
        !pendingIds.has(request.requestId) &&
        !settledIds.has(request.requestId) &&
        !unitKeys.some((key) => key.startsWith(`${steeringUnitKeyPrefix(request.turnId, request.requestId)}:`)),
    ),
  }
}

const applyUnitDeltas = (
  model: Model,
  delta: ThreadView.ThreadViewDelta,
  previousPreviewUnits: ReadonlyArray<Unit>,
  nextPreviewUnits: ReadonlyArray<Unit>,
): Model => {
  let next = model
  const nextPreviewByKey = new Map(nextPreviewUnits.map((unit) => [unit.key, unit]))
  const previousPreviewByKey = new Map(previousPreviewUnits.map((unit) => [unit.key, unit]))
  const durableTranscriptChanged = delta.turns.some((turn) => turn.upsert.length > 0 || turn.remove.length > 0)
  const removedPreviewKeys = previousPreviewUnits
    .filter((unit) => durableTranscriptChanged || !nextPreviewByKey.has(unit.key))
    .map((unit) => unit.key)
  const previousPreviewTurnId = previousPreviewUnits[0]?.turnId
  if (previousPreviewTurnId !== undefined && removedPreviewKeys.length > 0)
    next = applyTurnDelta(next, previousPreviewTurnId, {
      upsert: [],
      remove: removedPreviewKeys,
    })
  for (const turn of delta.turns) next = applyTurnDelta(next, turn.turnId, { upsert: turn.upsert, remove: turn.remove })
  const durableKeys = new Set(delta.turns.flatMap((turn) => [...turn.remove, ...turn.upsert.map((unit) => unit.key)]))
  const changedPreviewUnits = nextPreviewUnits.filter((unit) => {
    if (durableTranscriptChanged) return true
    const previous = previousPreviewByKey.get(unit.key)
    if (previous === undefined || previous.revision !== unit.revision || durableKeys.has(unit.key)) return true
    if (previous.parentId !== unit.parentId || previous.content._tag !== unit.content._tag) return true
    if (previous.content._tag === "Entry" && unit.content._tag === "Entry")
      return previous.content.role !== unit.content.role || previous.content.text !== unit.content.text
    if (previous.content._tag !== "Block" || unit.content._tag !== "Block") return true
    const previousBlock = previous.content.block
    const nextBlock = unit.content.block
    return previousBlock._tag !== "Reasoning" || nextBlock._tag !== "Reasoning" || previousBlock.text !== nextBlock.text
  })
  const nextPreviewTurnId = nextPreviewUnits[0]?.turnId
  if (nextPreviewTurnId !== undefined && changedPreviewUnits.length > 0)
    next = applyTurnDelta(next, nextPreviewTurnId, { upsert: changedPreviewUnits, remove: [] })
  return next
}

const projectPatch = (
  model: Model,
  view: ThreadView.ThreadViewAccumulator,
  delta: ThreadView.ThreadViewDelta,
  previousPreviewUnits: ReadonlyArray<Unit>,
  nextPreviewUnits: ReadonlyArray<Unit>,
  modelPreview: ModelPreview.Overlay | undefined,
): Model => {
  const active = view.activeTurn()
  const editing = model.editingTurnId !== undefined && view.pending.some((item) => item.id === model.editingTurnId)
  const steering = patchSteering(model, delta)
  const projected = applyUnitDeltas(model, delta, previousPreviewUnits, nextPreviewUnits)
  let next: Model = {
    ...projected,
    transcriptTruncated: projected.transcriptTruncated === true || view.hasOlder,
    currentThreadId: String(view.thread.id),
    currentThreadTitle: view.thread.title,
    activeTurnId: active === undefined ? undefined : String(active.turn.id),
    busy: active !== undefined,
    activity: undefined,
    pendingSteering: steering.pending,
    steeringRequests: steering.requests,
    editingTurnId: editing ? model.editingTurnId : undefined,
    editReturn: editing ? model.editReturn : undefined,
    queue: view.pending.map((item) => ({ id: item.id, prompt: item.prompt })),
    queueSelection: view.pending.some((item) => item.id === model.queueSelection)
      ? model.queueSelection
      : view.pending.at(-1)?.id,
    queueThreadId: String(view.thread.id),
    queueRevision: view.revision,
  }
  if (model.currentThreadId === undefined || model.currentThreadId === String(view.thread.id))
    next = overlayPendingSubmissions(next, model)
  next = {
    ...next,
    activity: activeUnitActivity(active, modelPreview, next, retainedActivity(model, active, String(view.thread.id))),
  }
  const settled = view.turn(model.activeTurnId ?? "")
  next = applySettlement(next, model, active, settled, view.units(model.activeTurnId ?? ""))
  return applyUsage(next, view.usage, view.turnCount > 0 || view.pending.length > 0)
}

export const FeedProjection = { activeUnitActivity, projectPatch, projectSnapshot, retainedActivity }
