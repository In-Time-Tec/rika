import * as ThreadView from "@rika/product/thread-view"
import * as ExecutionStatus from "@rika/product/execution-status"
import { Function, Result } from "effect"
import { applyTurnDelta } from "@rika/terminal/terminal-transcript-presentation"
import { update as updateModel } from "@rika/terminal/terminal-state-reducer"
import type { State, TranscriptEvent, Update } from "./service"
import { FeedProjection } from "./feed-projection"
import * as ModelPreview from "./model-preview"

const unchanged = (state: State): Update => ({ state, preserveAnchor: false })

const clearPreviewStateImpl = (state: State, turnId: string | undefined): State => {
  if (state.modelPreview === undefined || (turnId !== undefined && state.modelPreview.turnId !== turnId)) return state
  if (state.view === undefined) return { ...state, modelPreview: undefined }
  const units = ModelPreview.units(state.modelPreview, state.view)
  const model = applyTurnDelta(state.model, state.modelPreview.turnId, {
    upsert: [],
    remove: units.map((unit) => unit.key),
  })
  return {
    ...state,
    modelPreview: undefined,
    model: { ...model, activity: FeedProjection.activeUnitActivity(state.view.activeTurn(), undefined, model) },
  }
}

const resync = (state: State, rejection: "gap" | "thread" | "revision", preserveState = false): Update => ({
  state: preserveState ? state : clearPreviewStateImpl(state, undefined),
  preserveAnchor: false,
  resync: true,
  rejection,
})

const applyPreview = (
  state: State,
  event: Extract<TranscriptEvent, { readonly _tag: "ExecutionModelPreviewChanged" }>,
): Update => {
  if (state.view === undefined || event.threadId !== state.view.thread.id) return unchanged(state)
  const turn = state.view.turn(String(event.turnId))
  if (turn === undefined || !ExecutionStatus.isActiveStatus(turn.turn.status)) return unchanged(state)
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
      model: { ...model, activity: FeedProjection.activeUnitActivity(turn, modelPreview, model) },
    },
    preserveAnchor: false,
  }
}

const snapshotRegressesTerminalTurn = (state: State, snapshot: ThreadView.ThreadViewSnapshot): boolean =>
  state.view !== undefined &&
  snapshot.turns.some((candidate) => {
    const existing = state.view?.turn(String(candidate.turn.id))?.turn
    return (
      existing !== undefined &&
      ExecutionStatus.isTerminalStatus(existing.status) &&
      !ExecutionStatus.isTerminalStatus(candidate.turn.status)
    )
  })

const snapshotAdvancesTerminalTurn = (state: State, snapshot: ThreadView.ThreadViewSnapshot): boolean => {
  if (
    state.model.activeTurnId !== undefined &&
    !snapshot.turns.some((candidate) => ExecutionStatus.isActiveStatus(candidate.turn.status))
  )
    return true
  if (state.view === undefined) return false
  return snapshot.turns.some((candidate) => {
    const existing = state.view?.turn(String(candidate.turn.id))?.turn
    const terminal = ExecutionStatus.isTerminalStatus(candidate.turn.status)
    return (
      (state.model.activeTurnId === String(candidate.turn.id) && terminal) ||
      (existing !== undefined && !ExecutionStatus.isTerminalStatus(existing.status) && terminal)
    )
  })
}

const applySnapshot = (
  state: State,
  event: Extract<TranscriptEvent, { readonly _tag: "ThreadViewSnapshot" }>,
): Update => {
  const sameThread = state.view?.thread.id === event.snapshot.thread.id
  const stale =
    sameThread &&
    state.view !== undefined &&
    event.snapshot.revision < state.view.revision &&
    !snapshotAdvancesTerminalTurn(state, event.snapshot)
  if (stale || (sameThread && snapshotRegressesTerminalTurn(state, event.snapshot))) return unchanged(state)
  const hydrated = ThreadView.fromSnapshot(event.snapshot)
  if (Result.isFailure(hydrated)) return resync(state, "gap")
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
      model: FeedProjection.projectSnapshot(state.model, view, preserveOptimisticState, modelPreview),
    },
    preserveAnchor: sameThread,
  }
}

const applyPatch = (state: State, event: Extract<TranscriptEvent, { readonly _tag: "ThreadViewPatch" }>): Update => {
  if (state.view === undefined) return resync(state, "gap")
  const previousPreviewUnits = ModelPreview.units(state.modelPreview, state.view)
  const applied = state.view.apply(event.patch)
  if (Result.isFailure(applied)) {
    const foreign = applied.failure._tag === "ThreadViewForeignThread"
    return resync(state, foreign ? "thread" : "revision", foreign)
  }
  const modelPreview = ModelPreview.reconcile(state.modelPreview, state.view)
  const nextPreviewUnits = ModelPreview.units(modelPreview, state.view)
  return {
    state: {
      ...state,
      modelPreview,
      model: FeedProjection.projectPatch(
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

const updateStateImpl = (state: State, event: TranscriptEvent): Update => {
  switch (event._tag) {
    case "ThreadRefolding":
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
    case "ExecutionModelPreviewChanged":
      return applyPreview(state, event)
    case "ResyncRequired": {
      const foreign = state.view !== undefined && event.threadId !== state.view.thread.id
      return resync(state, foreign ? "thread" : "gap", foreign)
    }
    case "ThreadViewSnapshot":
      return applySnapshot(state, event)
    case "ThreadViewPatch":
      return applyPatch(state, event)
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
