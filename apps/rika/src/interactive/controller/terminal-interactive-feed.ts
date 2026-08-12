import * as ThreadView from "@rika/product/thread-view"
import { steeringUnitKeyPrefix } from "@rika/product/execution-projection"
import { Function, Result } from "effect"
import { maxInMemoryTranscriptUnits, trimTranscriptTimeline } from "@rika/terminal/terminal-timeline-bounds"
import { runningToolsActivity as transcriptActivity } from "@rika/terminal/terminal-message"
import { applyRootUnits, applyTurnDelta } from "@rika/terminal/terminal-transcript-presentation"
import type { Model, ThreadItem } from "@rika/terminal/terminal-state"
import { update as updateModel } from "@rika/terminal/terminal-state-reducer"
import { overlayPendingSubmissions } from "@rika/terminal/terminal-submission-state"
import type { State, TranscriptEvent, Update } from "./interactive-controller"
import * as ModelPreview from "./interactive-model-preview"

const unchanged = (state: State): Update => ({ state, preserveAnchor: false })

const activeUnitActivity = (
  entry: ThreadView.ThreadViewTurn | undefined,
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

const project = (model: Model, snapshot: ThreadView.ThreadViewSnapshot, modelPreview?: ModelPreview.Overlay): Model => {
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
    steeringRequests,
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
        (model.threads as ReadonlyArray<ThreadItem>).findIndex((thread) => thread.id === snapshot.thread.id),
      ),
    },
    threadPreview: { _tag: "Idle" },
  }
  for (const entry of snapshot.turns) next = applyRootUnits(next, String(entry.turn.id), entry.units)
  const previewUnits = ModelPreview.units(modelPreview, snapshot)
  if (previewUnits.length > 0) next = applyRootUnits(next, String(previewUnits[0]!.turnId), previewUnits)
  if (model.currentThreadId === undefined || model.currentThreadId === String(snapshot.thread.id))
    next = overlayPendingSubmissions(next, model)
  next = { ...next, activity: activeUnitActivity(active, modelPreview, next) }
  if (active === undefined && model.activeTurnId !== undefined) {
    const settled = snapshot.turns.find((entry) => String(entry.turn.id) === model.activeTurnId)?.turn
    if (settled?.status === "completed") next = updateModel(next, { _tag: "ExecutionCompleted", turnId: settled.id })
    if (settled?.status === "failed") {
      // The snapshot carries the run's real failure in the last Error unit; a generic status
      // sentence would discard it at the same boundary the wire schema was built to protect.
      const turn = snapshot.turns.find((entry) => String(entry.turn.id) === model.activeTurnId)
      const errorUnit = [...(turn?.units ?? [])].reverse().find((unit) => {
        const content = unit.content as { _tag?: string; block?: { _tag?: string } }
        return content._tag === "Block" && content.block?._tag === "Error"
      })
      const errorBlock = (
        errorUnit?.content as
          | { block?: { title?: string; detail?: string; category?: string; retryable?: boolean } }
          | undefined
      )?.block
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
        contextWindow: snapshot.usage.contextCapacity.contextWindow,
        reserveTokens: snapshot.usage.contextCapacity.reserveTokens,
      }
    if (usage.contextPending) return { _tag: "Loading" as const }
    if (snapshot.turns.length === 0 && snapshot.pending.length === 0) return { _tag: "NotStarted" as const }
    return { _tag: "Unavailable" as const }
  })()
  next = updateModel(next, { _tag: "ContextUsageReplaced", contextUsage })
  const costUsd = usage.costNanoUsd === undefined ? undefined : usage.costNanoUsd / 1_000_000_000
  return trimTranscriptTimeline(
    {
      ...next,
      costUsd,
      usageCost:
        costUsd === undefined
          ? { _tag: "Unavailable" }
          : { _tag: "Available", usd: costUsd, unpricedAttempts: usage.unpricedAttempts },
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
    const turn = state.view.turns.find((candidate) => candidate.turn.id === event.turnId)
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
  if (event._tag === "ThreadViewSnapshot") {
    const sameThread = state.view?.thread.id === event.snapshot.thread.id
    if (sameThread && state.view !== undefined && event.snapshot.revision < state.view.revision) return unchanged(state)
    const modelPreview = ModelPreview.reconcile(state.modelPreview, event.snapshot)
    return {
      state: {
        ...state,
        view: event.snapshot,
        modelPreview,
        model: project(state.model, event.snapshot, modelPreview),
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
  const applied = ThreadView.apply(state.view, event.patch)
  if (Result.isFailure(applied)) {
    const foreign = applied.failure._tag === "ThreadViewForeignThread"
    return {
      state: foreign ? state : clearPreviewStateImpl(state, undefined),
      preserveAnchor: false,
      resync: true,
      rejection: foreign ? "thread" : "revision",
    }
  }
  const modelPreview = ModelPreview.reconcile(state.modelPreview, applied.success)
  return {
    state: {
      ...state,
      view: applied.success,
      modelPreview,
      model: project(state.model, applied.success, modelPreview),
    },
    preserveAnchor: false,
  }
}

const clearPreviewStateImpl = (state: State, turnId: string | undefined): State => {
  if (state.modelPreview === undefined || (turnId !== undefined && state.modelPreview.turnId !== turnId)) return state
  return {
    ...state,
    modelPreview: undefined,
    model: state.view === undefined ? state.model : project(state.model, state.view),
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
