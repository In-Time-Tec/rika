import * as ThreadView from "@rika/product/thread-view"
import { steeringUnitKeyPrefix } from "@rika/product/execution-projection"
import * as ExecutionStatus from "@rika/product/execution-status"
import { Function, Result, Schema } from "effect"
import { maxInMemoryTranscriptUnits, trimTranscriptTimeline } from "@rika/terminal/terminal-timeline-bounds"
import { runningToolsActivity as transcriptActivity } from "@rika/terminal/terminal-message"
import { applyRootUnits, applyTurnDelta } from "@rika/terminal/terminal-transcript-presentation"
import type { Model } from "@rika/terminal/terminal-state"
import { update as updateModel } from "@rika/terminal/terminal-state-reducer"
import { overlayPendingSubmissions } from "@rika/terminal/terminal-submission-state"
import type { State, TranscriptEvent, Update } from "./service"
import * as ModelPreview from "./model-preview"

const unchanged = (state: State): Update => ({ state, preserveAnchor: false })

const activeUnitActivity = (
  entry: ThreadView.ThreadViewTurnState | undefined,
  modelPreview: ModelPreview.Overlay | undefined,
  model: Model,
): Model["activity"] => {
  if (entry === undefined) return undefined
  const previewActivity = ModelPreview.activity(modelPreview, String(entry.turn.id))
  if (previewActivity !== undefined) {
    if (previewActivity.textBytes > 0) return { _tag: "Streaming", bytes: previewActivity.textBytes }
    if (previewActivity.reasoningBytes > 0) return { _tag: "Thinking", bytes: previewActivity.reasoningBytes }
  }
  const activity = transcriptActivity(model)
  return (activity.subagents ?? 0) === 0 && (activity.tools ?? 0) === 0 ? { _tag: "Waiting" } : activity
}

const clearTimeline = (model: Model): Model => ({
  ...model,
  entries: [],
  blocks: [],
  items: [],
  seenEventIds: [],
  childExecutionOutcomes: {},
  eventCursor: undefined,
})

const project = (
  model: Model,
  view: ThreadView.ThreadViewAccumulator,
  preserveOptimisticState: boolean,
  modelPreview?: ModelPreview.Overlay,
): Model => {
  const snapshot = view.snapshot()
  const active = snapshot.turns.find(
    (entry) =>
      entry.turn.status === "accepted" ||
      entry.turn.status === "running" ||
      entry.turn.status === "cancelling" ||
      entry.turn.status === "waiting",
  )
  const editing = model.editingTurnId !== undefined && snapshot.pending.some((item) => item.id === model.editingTurnId)
  const authoritativeSteering = snapshot.turns.flatMap((entry) =>
    (entry.pendingSteering ?? []).map((steering) => ({
      ...steering,
      turnId: String(entry.turn.id),
    })),
  )
  const authoritativeRequestIds = new Set(authoritativeSteering.map((steering) => steering.requestId))
  const settledRequestIds = new Set(
    snapshot.turns.flatMap((entry) => (entry.settledSteering ?? []).map((steering) => steering.requestId)),
  )
  const unitKeys = new Set(snapshot.turns.flatMap((entry) => entry.units.map((unit) => unit.key)))
  const steeringRequests = model.steeringRequests.filter(
    (request) =>
      !authoritativeRequestIds.has(request.requestId) &&
      !settledRequestIds.has(request.requestId) &&
      ![...unitKeys].some((key) => key.startsWith(`${steeringUnitKeyPrefix(request.turnId, request.requestId)}:`)),
  )
  let next: Model = {
    ...clearTimeline(model),
    currentThreadId: String(snapshot.thread.id),
    currentThreadTitle: snapshot.thread.title,
    activeTurnId: active === undefined ? undefined : String(active.turn.id),
    busy: active !== undefined,
    activity: undefined,
    pendingSteering: authoritativeSteering,
    steeringRequests: preserveOptimisticState ? steeringRequests : [],
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
        model.threads.findIndex(
          (thread) => Schema.is(Schema.Struct({ id: Schema.String }))(thread) && thread.id === snapshot.thread.id,
        ),
      ),
    },
    threadPreview: { _tag: "Idle" },
  }
  for (const entry of snapshot.turns) next = applyRootUnits(next, String(entry.turn.id), entry.units)
  const previewUnits = ModelPreview.units(modelPreview, view)
  if (previewUnits.length > 0) next = applyRootUnits(next, String(previewUnits[0]!.turnId), previewUnits)
  if (preserveOptimisticState) next = overlayPendingSubmissions(next, model)
  next = { ...next, activity: activeUnitActivity(active, modelPreview, next) }
  if (active === undefined && model.activeTurnId !== undefined) {
    const settled = snapshot.turns.find((entry) => String(entry.turn.id) === model.activeTurnId)?.turn
    if (settled?.status === "completed") next = updateModel(next, { _tag: "ExecutionCompleted", turnId: settled.id })
    if (settled?.status === "failed") {
      // The snapshot carries the run's real failure in the last Error unit; a generic status
      // sentence would discard it at the same boundary the wire schema was built to protect.
      const turn = snapshot.turns.find((entry) => String(entry.turn.id) === model.activeTurnId)
      const errorUnit = [...(turn?.units ?? [])]
        .reverse()
        .find((unit) => unit.content._tag === "Block" && unit.content.block._tag === "Error")
      const errorContent = errorUnit?.content
      const errorBlock =
        errorContent?._tag === "Block" && errorContent.block._tag === "Error" ? errorContent.block : undefined
      const message =
        errorBlock?.detail !== undefined && errorBlock.detail.length > 0
          ? errorBlock.detail
          : (errorBlock?.title ?? "Execution failed")
      const retryable = errorBlock?.retryable ?? false
      next = updateModel(next, {
        _tag: "ExecutionFailed",
        turnId: settled.id,
        failure: {
          tag: "TurnFailed",
          category: errorBlock?.category ?? "operation",
          message,
          retryable,
          retry: retryable ? "automatic" : "none",
          actor: "environment",
        },
      })
    }
    if (settled?.status === "cancelled")
      next = updateModel(next, { _tag: "ExecutionCancelled", turnId: settled.id, agentResponseArrived: false })
  }
  const usage = snapshot.usage.state
  const contextUsage = ((): NonNullable<Model["contextUsage"]> => {
    if (usage.context !== undefined && snapshot.usage.contextCapacity !== undefined)
      return {
        _tag: "Available" as const,
        inputTokens: usage.context.inputTokens,
        inputCacheRead: usage.tokens?.input.cacheRead ?? 0,
        inputTotal: usage.tokens?.input.total ?? 0,
        contextWindow: snapshot.usage.contextCapacity.contextWindow,
        reserveTokens: snapshot.usage.contextCapacity.reserveTokens,
      }
    if (usage.contextPending) return { _tag: "Loading" as const }
    if (snapshot.turns.length === 0 && snapshot.pending.length === 0) return { _tag: "NotStarted" as const }
    return { _tag: "Unavailable" as const }
  })()
  next = updateModel(next, { _tag: "ContextUsageReplaced", contextUsage })
  const includedAttempts = usage.includedAttempts ?? 0
  const costUsd = usage.costNanoUsd === undefined ? undefined : usage.costNanoUsd / 1_000_000_000
  const usageCost = ((): NonNullable<Model["usageCost"]> => {
    if (costUsd !== undefined)
      return { _tag: "Available", usd: costUsd, unpricedAttempts: usage.unpricedAttempts, includedAttempts }
    if (includedAttempts > 0) return { _tag: "Included", includedAttempts }
    return { _tag: "Unavailable" }
  })()
  return trimTranscriptTimeline(
    {
      ...next,
      usageCost,
      usageTokens:
        usage.tokens?.total === undefined
          ? { _tag: "Unavailable" }
          : { _tag: "Available", total: usage.tokens.total, uncountedAttempts: usage.uncountedAttempts },
      usageTime: usage.active,
    },
    maxInMemoryTranscriptUnits,
  )
}

const projectPatch = (
  model: Model,
  view: ThreadView.ThreadViewAccumulator,
  delta: ThreadView.ThreadViewDelta,
  previousPreviewUnits: ReadonlyArray<import("@rika/transcript/transcript-unit").Unit>,
  nextPreviewUnits: ReadonlyArray<import("@rika/transcript/transcript-unit").Unit>,
  modelPreview: ModelPreview.Overlay | undefined,
): Model => {
  let next = model
  const previewTurnId = nextPreviewUnits[0]?.turnId ?? previousPreviewUnits[0]?.turnId
  if (previewTurnId !== undefined && previousPreviewUnits.length > 0)
    next = applyTurnDelta(next, String(previewTurnId), {
      upsert: [],
      remove: previousPreviewUnits.map((unit) => unit.key),
    })
  for (const turn of delta.turns)
    next = applyTurnDelta(next, turn.turnId, {
      upsert: turn.upsert,
      remove: turn.remove,
    })
  if (previewTurnId !== undefined && nextPreviewUnits.length > 0)
    next = applyTurnDelta(next, String(previewTurnId), {
      upsert: nextPreviewUnits,
      remove: [],
    })
  const active = view.activeTurn()
  const editing = model.editingTurnId !== undefined && view.pending.some((item) => item.id === model.editingTurnId)
  const changedTurnIds = new Set(delta.turns.map((turn) => turn.turnId))
  const pendingSteering = [
    ...model.pendingSteering.filter((steering) => !changedTurnIds.has(String(steering.turnId))),
    ...delta.turns.flatMap((turn) =>
      (turn.current?.pendingSteering ?? []).map((steering) => ({ ...steering, turnId: turn.turnId })),
    ),
  ]
  const authoritativeRequestIds = new Set(pendingSteering.map((steering) => steering.requestId))
  const settledRequestIds = new Set(
    delta.turns.flatMap((turn) => (turn.current?.settledSteering ?? []).map((steering) => steering.requestId)),
  )
  const changedUnitKeys = delta.turns.flatMap((turn) => turn.upsert.map((unit) => unit.key))
  const steeringRequests = model.steeringRequests.filter(
    (request) =>
      !authoritativeRequestIds.has(request.requestId) &&
      !settledRequestIds.has(request.requestId) &&
      !changedUnitKeys.some((key) => key.startsWith(`${steeringUnitKeyPrefix(request.turnId, request.requestId)}:`)),
  )
  const previousActiveTurnId = model.activeTurnId
  next = {
    ...next,
    currentThreadId: String(view.thread.id),
    currentThreadTitle: view.thread.title,
    activeTurnId: active === undefined ? undefined : String(active.turn.id),
    busy: active !== undefined,
    activity: undefined,
    pendingSteering,
    steeringRequests,
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
  next = { ...next, activity: activeUnitActivity(active, modelPreview, next) }
  if (active === undefined && previousActiveTurnId !== undefined) {
    const settled = view.turn(previousActiveTurnId)?.turn
    if (settled?.status === "completed") next = updateModel(next, { _tag: "ExecutionCompleted", turnId: settled.id })
    if (settled?.status === "failed") {
      const errorUnit = [...view.units(previousActiveTurnId)]
        .reverse()
        .find((unit) => unit.content._tag === "Block" && unit.content.block._tag === "Error")
      const errorContent = errorUnit?.content
      const errorBlock =
        errorContent?._tag === "Block" && errorContent.block._tag === "Error" ? errorContent.block : undefined
      const message =
        errorBlock?.detail !== undefined && errorBlock.detail.length > 0
          ? errorBlock.detail
          : (errorBlock?.title ?? "Execution failed")
      const retryable = errorBlock?.retryable ?? false
      next = updateModel(next, {
        _tag: "ExecutionFailed",
        turnId: settled.id,
        failure: {
          tag: "TurnFailed",
          category: errorBlock?.category ?? "operation",
          message,
          retryable,
          retry: retryable ? "automatic" : "none",
          actor: "environment",
        },
      })
    }
    if (settled?.status === "cancelled")
      next = updateModel(next, { _tag: "ExecutionCancelled", turnId: settled.id, agentResponseArrived: false })
  }
  const usage = view.usage.state
  const contextUsage = ((): NonNullable<Model["contextUsage"]> => {
    if (usage.context !== undefined && view.usage.contextCapacity !== undefined)
      return {
        _tag: "Available" as const,
        inputTokens: usage.context.inputTokens,
        inputCacheRead: usage.tokens?.input.cacheRead ?? 0,
        inputTotal: usage.tokens?.input.total ?? 0,
        contextWindow: view.usage.contextCapacity.contextWindow,
        reserveTokens: view.usage.contextCapacity.reserveTokens,
      }
    if (usage.contextPending) return { _tag: "Loading" as const }
    if (view.turnCount === 0 && view.pending.length === 0) return { _tag: "NotStarted" as const }
    return { _tag: "Unavailable" as const }
  })()
  next = updateModel(next, { _tag: "ContextUsageReplaced", contextUsage })
  const includedAttempts = usage.includedAttempts ?? 0
  const costUsd = usage.costNanoUsd === undefined ? undefined : usage.costNanoUsd / 1_000_000_000
  const usageCost = ((): NonNullable<Model["usageCost"]> => {
    if (costUsd !== undefined)
      return { _tag: "Available", usd: costUsd, unpricedAttempts: usage.unpricedAttempts, includedAttempts }
    if (includedAttempts > 0) return { _tag: "Included", includedAttempts }
    return { _tag: "Unavailable" }
  })()
  return trimTranscriptTimeline(
    {
      ...next,
      usageCost,
      usageTokens:
        usage.tokens?.total === undefined
          ? { _tag: "Unavailable" }
          : { _tag: "Available", total: usage.tokens.total, uncountedAttempts: usage.uncountedAttempts },
      usageTime: usage.active,
    },
    maxInMemoryTranscriptUnits,
  )
}

const updateStateImpl = (state: State, event: TranscriptEvent): Update => {
  if (event._tag === "ThreadRefolding")
    return {
      state: {
        ...state,
        model: updateModel(state.model, {
          _tag: "ThreadRefolding",
          threadId: String(event.threadId),
          refolding: event.refolding,
        }),
      },
      preserveAnchor: false,
    }
  if (event._tag === "ExecutionModelPreviewChanged") {
    if (state.view === undefined || event.threadId !== state.view.thread.id) return unchanged(state)
    const turn = state.view.turn(String(event.turnId))
    if (
      turn === undefined ||
      (turn.turn.status !== "accepted" &&
        turn.turn.status !== "running" &&
        turn.turn.status !== "cancelling" &&
        turn.turn.status !== "waiting")
    )
      return unchanged(state)
    const modelPreview = ModelPreview.replace(state.modelPreview, String(event.turnId), event.preview)
    if (modelPreview === state.modelPreview) return unchanged(state)
    const previous = ModelPreview.units(state.modelPreview, state.view)
    const next = ModelPreview.units(modelPreview, state.view)
    const model = applyTurnDelta(state.model, String(event.turnId), {
      upsert: next,
      remove: previous.filter((unit) => !next.some((candidate) => candidate.key === unit.key)).map((unit) => unit.key),
    })
    return {
      state: {
        ...state,
        modelPreview,
        model: {
          ...model,
          activity: activeUnitActivity(turn, modelPreview, model),
        },
      },
      preserveAnchor: false,
    }
  }
  if (event._tag === "ResyncRequired") {
    const foreign = state.view !== undefined && event.threadId !== state.view.thread.id
    return {
      state: foreign ? state : clearPreviewStateImpl(state, undefined),
      preserveAnchor: false,
      resync: true,
      rejection: foreign ? "thread" : "gap",
    }
  }
  const snapshotRegressesTerminalTurn = (snapshot: ThreadView.ThreadViewSnapshot) =>
    state.view !== undefined &&
    snapshot.turns.some((candidate) => {
      const existing = state.view!.turn(String(candidate.turn.id))?.turn
      return (
        existing !== undefined &&
        ExecutionStatus.isTerminalStatus(existing.status) &&
        !ExecutionStatus.isTerminalStatus(candidate.turn.status)
      )
    })
  const snapshotAdvancesTerminalTurn = (snapshot: ThreadView.ThreadViewSnapshot) => {
    if (
      state.model.activeTurnId !== undefined &&
      !snapshot.turns.some((candidate) => ExecutionStatus.isActiveStatus(candidate.turn.status))
    )
      return true
    return (
      state.view !== undefined &&
      snapshot.turns.some((candidate) => {
        const existing = state.view!.turn(String(candidate.turn.id))?.turn
        const candidateIsTerminal = ExecutionStatus.isTerminalStatus(candidate.turn.status)
        return (
          (state.model.activeTurnId === String(candidate.turn.id) && candidateIsTerminal) ||
          (existing !== undefined && !ExecutionStatus.isTerminalStatus(existing.status) && candidateIsTerminal)
        )
      })
    )
  }
  if (event._tag === "ThreadViewSnapshot") {
    const sameThread = state.view?.thread.id === event.snapshot.thread.id
    if (
      sameThread &&
      state.view !== undefined &&
      event.snapshot.revision < state.view.revision &&
      !snapshotAdvancesTerminalTurn(event.snapshot)
    )
      return unchanged(state)
    if (sameThread && snapshotRegressesTerminalTurn(event.snapshot)) return unchanged(state)
    const hydrated = ThreadView.fromSnapshot(event.snapshot)
    if (Result.isFailure(hydrated))
      return {
        state: clearPreviewStateImpl(state, undefined),
        preserveAnchor: false,
        resync: true,
        rejection: "gap",
      }
    const view = hydrated.success
    const modelPreview = ModelPreview.reconcile(state.modelPreview, view)
    const preserveOptimisticState =
      state.view === undefined
        ? state.model.currentThreadId === undefined || state.model.currentThreadId === String(event.snapshot.thread.id)
        : sameThread
    return {
      state: {
        ...state,
        view,
        modelPreview,
        model: project(state.model, view, preserveOptimisticState, modelPreview),
      },
      preserveAnchor: sameThread,
    }
  }
  if (state.view === undefined)
    return {
      state: clearPreviewStateImpl(state, undefined),
      preserveAnchor: false,
      resync: true,
      rejection: "gap",
    }
  const previousPreviewUnits = ModelPreview.units(state.modelPreview, state.view)
  const applied = state.view.apply(event.patch)
  if (Result.isFailure(applied)) {
    const foreign = applied.failure._tag === "ThreadViewForeignThread"
    return {
      state: foreign ? state : clearPreviewStateImpl(state, undefined),
      preserveAnchor: false,
      resync: true,
      rejection: foreign ? "thread" : "revision",
    }
  }
  const modelPreview = ModelPreview.reconcile(state.modelPreview, state.view)
  const nextPreviewUnits = ModelPreview.units(modelPreview, state.view)
  return {
    state: {
      ...state,
      modelPreview,
      model: projectPatch(
        state.model,
        state.view,
        applied.success,
        previousPreviewUnits,
        nextPreviewUnits,
        modelPreview,
      ),
    },
    preserveAnchor: false,
  }
}

const clearPreviewStateImpl = (state: State, turnId: string | undefined): State => {
  if (state.modelPreview === undefined || (turnId !== undefined && state.modelPreview.turnId !== turnId)) return state
  if (state.view === undefined) return { ...state, modelPreview: undefined }
  const units = ModelPreview.units(state.modelPreview, state.view)
  const model = applyTurnDelta(state.model, state.modelPreview.turnId, {
    upsert: [],
    remove: units.map((unit) => unit.key),
  })
  const active = state.view.activeTurn()
  return {
    ...state,
    modelPreview: undefined,
    model: { ...model, activity: activeUnitActivity(active, undefined, model) },
  }
}

export const clearPreviewState: {
  (turnId: string | undefined): (state: State) => State
  (state: State, turnId: string | undefined): State
} = Function.dual(2, clearPreviewStateImpl)

export const updateState: {
  (arg0: State, arg1: TranscriptEvent): Update
  (arg1: TranscriptEvent): (arg0: State) => Update
} = Function.dual(2, updateStateImpl)
