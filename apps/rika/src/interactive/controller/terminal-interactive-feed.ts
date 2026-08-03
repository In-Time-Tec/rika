import * as Turn from "@rika/product/turn-record"
import * as ThreadResult from "@rika/product/thread-result"
import { Function, HashMap } from "effect"
import { applyTurnDelta } from "@rika/terminal/terminal-transcript-presentation"
import type { Model, ThreadItem } from "@rika/terminal/terminal-state"
import { update as updateModel } from "@rika/terminal/terminal-state-reducer"
import type { State, ProjectionStream, TranscriptEvent, Update } from "./interactive-controller"
import {
  activeSeedEntries,
  project,
  projectionEntries,
  projectionFromEntries,
  displayedEntries,
  reconcileTranscriptBlocks,
  cleared,
} from "./interactive-transcript-projection"
import {
  boundWindow,
  cursorForEntry,
  normalizeEntries,
  projectedRootIds,
  replayTurnsForWindow,
  projectionFromStream,
  revisionsForWindow,
  sameCursor,
} from "./interactive-transcript-window"
import { activityAfterOrigin } from "./interactive-activity"
const unchanged = (state: State): Update => ({ state, preserveAnchor: false })
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
  if (event._tag === "ThreadUsageUpdated") {
    if (event.selectionEpoch !== state.selectionEpoch || event.threadId !== state.model.currentThreadId)
      return unchanged(state)
    if (state.usageRevision !== undefined && event.revision < state.usageRevision) return unchanged(state)
    let contextUsage = state.model.contextUsage
    if (event.context !== undefined) {
      contextUsage = event.context
      if (event.context._tag === "Unavailable" && state.model.contextUsage?._tag === "Available")
        contextUsage = state.model.contextUsage
    }
    const availableUsageCost = event.cost._tag === "Available" ? event.cost : state.lastAvailableUsageCost
    const threadCostUsd =
      availableUsageCost?._tag === "Available" ? availableUsageCost.usd : (state.threadCostUsd ?? state.model.costUsd)
    const usageCost = availableUsageCost ?? event.cost
    const lastAvailableUsageCost = event.cost._tag === "Available" ? event.cost : state.lastAvailableUsageCost
    const { costUsd: _, ...withoutCost } = state.model
    const contextModel =
      contextUsage === undefined
        ? state.model
        : updateModel(state.model, { _tag: "ContextUsageReplaced", contextUsage })
    return {
      state: {
        ...state,
        usageRevision: event.revision,
        ...(threadCostUsd === undefined ? {} : { threadCostUsd }),
        ...(lastAvailableUsageCost === undefined ? {} : { lastAvailableUsageCost }),
        model: updateModel(
          {
            ...contextModel,
            ...withoutCost,
            contextAnimation: contextModel.contextAnimation,
            usageCost,
            usageTokens: event.tokens,
            usageTime: event.time,
            contextUsage,
            ...(threadCostUsd === undefined ? {} : { costUsd: threadCostUsd }),
          },
          { _tag: "UsageReported" },
        ),
      },
      preserveAnchor: false,
    }
  }
  if (event._tag === "TurnSettled") {
    if (event.selectionEpoch !== state.selectionEpoch) return { state, preserveAnchor: false, rejection: "epoch" }
    if (state.model.currentThreadId !== String(event.threadId))
      return { state, preserveAnchor: false, rejection: "thread" }
    if (event.activitySequence <= (state.activitySequence ?? 0)) return unchanged(state)
    const activeTurnId = state.model.activeTurnId
    if (activeTurnId !== String(event.turnId))
      return { state: { ...state, activitySequence: event.activitySequence }, preserveAnchor: false }
    let model: Model
    if (event.status === "completed")
      model = updateModel(state.model, { _tag: "ExecutionCompleted", turnId: String(event.turnId) })
    else if (event.status === "failed")
      model = updateModel(state.model, {
        _tag: "ExecutionFailed",
        turnId: String(event.turnId),
        message: "Execution failed",
      })
    else
      model = updateModel(state.model, {
        _tag: "ExecutionCancelled",
        turnId: String(event.turnId),
        agentResponseArrived: event.agentResponseArrived ?? false,
      })
    return {
      state: { ...state, activitySequence: event.activitySequence, model },
      preserveAnchor: false,
    }
  }
  if (event._tag === "SelectionLoaded") {
    if (event.selectionEpoch < state.selectionEpoch) return unchanged(state)
    if (
      event.selectionEpoch === state.selectionEpoch &&
      state.model.currentThreadId === event.thread.id &&
      event.entries.some((entry) => entry.projectionRevision < (state.revisions.get(entry.turn.id) ?? -1))
    )
      return unchanged(state)
    const sameThread = state.model.currentThreadId === event.thread.id
    const lifecycleFresh = event.activitySequence >= (state.activitySequence ?? 0)
    const activeTurn = lifecycleFresh ? event.activeTurn : undefined
    const projectionTurn =
      event.activeTurn !== undefined && (lifecycleFresh || state.model.activeTurnId === event.activeTurn.id)
        ? event.activeTurn
        : undefined
    const keepNewerQueue =
      event.selectionEpoch === state.selectionEpoch &&
      state.model.queueThreadId === event.thread.id &&
      (state.model.queueRevision ?? -1) > event.queueRevision
    const queue = keepNewerQueue ? state.model.queue : event.queue
    const queueRevision = keepNewerQueue ? state.model.queueRevision : event.queueRevision
    const entries = normalizeEntries(event.entries)
    const preservedUsageCost = sameThread
      ? (state.lastAvailableUsageCost ??
        (state.model.usageCost?._tag === "Available" ? state.model.usageCost : undefined))
      : undefined
    const preservedContextUsage =
      sameThread && state.model.contextUsage?._tag === "Available" ? state.model.contextUsage : undefined
    const preservedUsageTokens =
      sameThread && state.model.usageTokens?._tag === "Available" ? state.model.usageTokens : undefined
    const preservedUsageTime =
      sameThread && state.model.usageTime?._tag === "Available" ? state.model.usageTime : undefined
    let lifecycle: Pick<Model, "activeTurnId" | "busy" | "activity">
    if (lifecycleFresh)
      lifecycle = {
        activeTurnId: activeTurn?.id,
        busy: activeTurn !== undefined,
        activity: activeTurn === undefined ? undefined : { _tag: "Waiting" },
      }
    else if (sameThread)
      lifecycle = { activeTurnId: state.model.activeTurnId, busy: state.model.busy, activity: state.model.activity }
    else lifecycle = { activeTurnId: undefined, busy: false, activity: undefined }
    const model = cleared({
      ...state.model,
      usageCost: preservedUsageCost ?? { _tag: "Loading" as const },
      usageTokens: preservedUsageTokens ?? { _tag: "Loading" as const },
      usageTime: preservedUsageTime ?? { _tag: "Loading" as const },
      contextUsage: preservedContextUsage ?? { _tag: "Loading" as const },
      contextAnimation: sameThread
        ? state.model.contextAnimation
        : { flashTicks: 0, flashed75: false, flashed90: false },
      ...lifecycle,
      currentThreadId: String(event.thread.id),
      currentThreadTitle: event.thread.title,
      editingTurnId: undefined,
      editReturn: undefined,
      queue: [...queue],
      queueSelection: queue.some((item) => item.id === state.model.queueSelection)
        ? state.model.queueSelection
        : queue.at(-1)?.id,
      queueThreadId: String(event.thread.id),
      queueRevision,
      threadSidebar: {
        ...state.model.threadSidebar,
        selected: Math.max(
          0,
          (state.model.threads as ReadonlyArray<ThreadItem>).findIndex((thread) => thread.id === event.thread.id),
        ),
      },
      threadPreview: { _tag: "Idle" },
    })
    const selectedCostUsd =
      event.threadCostUsd ?? (sameThread ? (state.threadCostUsd ?? preservedUsageCost?.usd) : undefined)
    const {
      threadCostUsd: _threadCostUsd,
      lastAvailableUsageCost: _lastAvailableUsageCost,
      ...stateWithoutRetainedUsage
    } = state
    const activeProjection =
      projectionTurn === undefined
        ? undefined
        : projectionFromEntries(
            normalizeEntries([...entries, ...activeSeedEntries(projectionTurn, entries)]),
            projectionTurn.id,
            projectionTurn.prompt,
          )
    const history =
      projectionTurn === undefined ? entries : entries.filter((entry) => entry.turn.id !== projectionTurn.id)
    const boundedSelection = boundWindow(history, "oldest")
    const selected = boundedSelection.entries
    const replayTurns = new Map([
      ...selected.map((entry) => [entry.turn.id, entry.turn] as const),
      ...(projectionTurn === undefined ? [] : [[projectionTurn.id, projectionTurn] as const]),
    ])
    const liveProjections = new Map(
      projectionTurn === undefined || activeProjection === undefined
        ? []
        : ([[projectionTurn.id, activeProjection]] as const),
    )
    const projected = project(
      model,
      displayedEntries(selected, replayTurns, liveProjections, undefined, projectionTurn?.id),
      selectedCostUsd,
    )
    const activeScopedReload =
      projectionTurn !== undefined && event.hasOlder && entries.every((entry) => entry.turn.id === projectionTurn.id)
    const previousActiveTurnId = state.model.activeTurnId
    if (sameThread && activeScopedReload && state.model.items.length > 0) {
      let retainedCandidates = displayedEntries(
        state.entries,
        state.replayTurns,
        state.liveProjections,
        state.projectionStreams,
        previousActiveTurnId,
      )
      const streamedRoots = projectedRootIds(state.projectionStreams)
      for (const [rootTurnId, projection] of state.liveProjections) {
        if (streamedRoots.has(rootTurnId)) continue
        const turn = state.replayTurns.get(rootTurnId)
        if (turn === undefined) continue
        retainedCandidates = [
          ...retainedCandidates.filter((entry) => String(entry.turn.id) !== rootTurnId),
          ...projectionEntries(turn, projection),
        ]
      }
      const retained = boundWindow(
        normalizeEntries([...retainedCandidates, ...selected]).filter(
          (entry) => projectionTurn === undefined || entry.turn.id !== projectionTurn.id,
        ),
        "oldest",
      )
      const retainedReplayTurns = replayTurnsForWindow(
        retained.entries,
        state.replayTurns,
        undefined,
        projectionTurn?.id,
      )
      const retainedRevisions = new Map(
        revisionsForWindow(retained.entries, projectionTurn?.id, state.revisions, undefined),
      )
      if (projectionTurn !== undefined && activeProjection !== undefined)
        retainedRevisions.set(projectionTurn.id, activeProjection.revision)
      const nextReplayTurns = new Map([...retainedReplayTurns, [projectionTurn.id, projectionTurn] as const])
      const retainedModel = reconcileTranscriptBlocks(
        project(
          model,
          displayedEntries(retained.entries, nextReplayTurns, liveProjections, undefined, projectionTurn.id),
          selectedCostUsd,
        ),
      )
      return {
        state: {
          ...stateWithoutRetainedUsage,
          selectionEpoch: event.selectionEpoch,
          activitySequence: lifecycleFresh ? event.activitySequence : (state.activitySequence ?? 0),
          model: retainedModel,
          replayTurns: nextReplayTurns,
          entries: retained.entries,
          revisions: retainedRevisions,
          liveProjections,
          projectionStreams: new Map(),
          hasOlder: event.hasOlder || retained.evicted,
          oldestCursor:
            state.oldestCursor !== undefined &&
            retained.entries.some((entry) => sameCursor(cursorForEntry(entry), state.oldestCursor))
              ? state.oldestCursor
              : cursorForEntry(retained.entries[0]),
          newestCursor: cursorForEntry(retained.entries.at(-1)),
          ...(selectedCostUsd === undefined ? {} : { threadCostUsd: selectedCostUsd }),
          ...(preservedUsageCost === undefined ? {} : { lastAvailableUsageCost: preservedUsageCost }),
        },
        preserveAnchor: true,
        discarded: true,
      }
    }
    return {
      state: {
        selectionEpoch: event.selectionEpoch,
        activitySequence: lifecycleFresh ? event.activitySequence : (state.activitySequence ?? 0),
        model: projected,
        replayTurns,
        entries: selected,
        revisions: new Map([
          ...selected.map((entry) => [entry.turn.id, entry.projectionRevision] as const),
          ...(projectionTurn === undefined || activeProjection === undefined
            ? []
            : ([[projectionTurn.id, activeProjection.revision]] as const)),
        ]),
        liveProjections,
        projectionStreams: new Map(),
        hasOlder: event.hasOlder || boundedSelection.evicted,
        hasNewer: event.hasNewer ?? false,
        oldestCursor: event.oldestCursor ?? cursorForEntry(selected[0]),
        newestCursor: event.newestCursor,
        ...(selectedCostUsd === undefined ? {} : { threadCostUsd: selectedCostUsd }),
        ...(preservedUsageCost === undefined ? {} : { lastAvailableUsageCost: preservedUsageCost }),
      },
      preserveAnchor: false,
    }
  }
  if (event._tag === "TranscriptPagePrepended") {
    if (event.selectionEpoch !== state.selectionEpoch) return unchanged(state)
    if (state.model.currentThreadId !== event.threadId) return unchanged(state)
    const projected = projectedRootIds(state.projectionStreams)
    const bounded = boundWindow(
      normalizeEntries([...state.entries, ...event.entries]).filter(
        (entry) => entry.turn.id !== state.model.activeTurnId && !projected.has(String(entry.turn.id)),
      ),
      "newest",
    )
    const entries = bounded.entries
    const threadCostUsd = event.threadCostUsd ?? state.threadCostUsd
    const { threadCostUsd: _threadCostUsd, ...stateWithoutCost } = state
    const replayTurns = replayTurnsForWindow(
      entries,
      state.replayTurns,
      state.projectionStreams,
      state.model.activeTurnId,
    )
    const liveProjections = new Map(
      [...state.liveProjections].filter(([turnId]) => turnId === state.model.activeTurnId || !replayTurns.has(turnId)),
    )
    return {
      state: {
        ...stateWithoutCost,
        model: reconcileTranscriptBlocks(
          project(
            cleared(state.model),
            displayedEntries(entries, replayTurns, liveProjections, state.projectionStreams, state.model.activeTurnId),
            threadCostUsd,
          ),
        ),
        replayTurns,
        entries,
        revisions: revisionsForWindow(entries, state.model.activeTurnId, state.revisions, state.projectionStreams),
        liveProjections,
        ...(threadCostUsd === undefined ? {} : { threadCostUsd }),
        hasOlder: event.hasOlder,
        hasNewer: state.hasNewer === true || bounded.evicted,
        oldestCursor: event.oldestCursor ?? cursorForEntry(entries[0]),
        newestCursor: bounded.evicted ? cursorForEntry(entries.at(-1)) : state.newestCursor,
      },
      preserveAnchor: true,
    }
  }
  if (event._tag === "TranscriptPageAppended") {
    if (event.selectionEpoch !== state.selectionEpoch || state.model.currentThreadId !== event.threadId)
      return unchanged(state)
    if (!sameCursor(event.requestedAfter, state.newestCursor)) return unchanged(state)
    const projected = projectedRootIds(state.projectionStreams)
    const bounded = boundWindow(
      normalizeEntries([...state.entries, ...event.entries]).filter(
        (entry) => entry.turn.id !== state.model.activeTurnId && !projected.has(String(entry.turn.id)),
      ),
      "oldest",
    )
    const entries = bounded.entries
    const threadCostUsd = event.threadCostUsd ?? state.threadCostUsd
    const replayTurns = replayTurnsForWindow(
      entries,
      state.replayTurns,
      state.projectionStreams,
      state.model.activeTurnId,
    )
    const liveProjections = new Map(
      [...state.liveProjections].filter(([turnId]) => turnId === state.model.activeTurnId || !replayTurns.has(turnId)),
    )
    return {
      state: {
        ...state,
        model: reconcileTranscriptBlocks(
          project(
            cleared(state.model),
            displayedEntries(entries, replayTurns, liveProjections, state.projectionStreams, state.model.activeTurnId),
            threadCostUsd,
          ),
        ),
        replayTurns,
        entries,
        revisions: revisionsForWindow(entries, state.model.activeTurnId, state.revisions, state.projectionStreams),
        liveProjections,
        hasOlder: state.hasOlder === true || bounded.evicted,
        hasNewer: event.hasNewer,
        oldestCursor: cursorForEntry(entries[0]),
        newestCursor: event.newestCursor ?? cursorForEntry(entries.at(-1)),
        ...(threadCostUsd === undefined ? {} : { threadCostUsd }),
      },
      preserveAnchor: false,
    }
  }
  if (event._tag === "TranscriptProjectionStarted") {
    if (event.selectionEpoch !== state.selectionEpoch || state.model.currentThreadId !== event.threadId)
      return unchanged(state)
    const rootTurnId = String(event.rootTurnId)
    if (event.turn.id !== event.rootTurnId || event.turn.threadId !== event.threadId)
      return { state, preserveAnchor: false, resync: true }
    if (state.projectionStreams?.has(rootTurnId) === true) return { state, preserveAnchor: false, resync: true }
    const turn = event.turn
    const replayTurns = new Map([...state.replayTurns, [rootTurnId, turn] as const])
    const stream: ProjectionStream = {
      _tag: "Open",
      streamId: event.streamId,
      patchRevision: event.patchRevision,
      state: event.state,
      units: HashMap.fromIterable(event.units.map((unit) => [unit.key, unit] as const)),
      ...(event.rootStatus === undefined ? {} : { rootStatus: event.rootStatus }),
    }
    const projectionStreams = new Map([
      ...(state.projectionStreams ?? new Map<string, ProjectionStream>()),
      [rootTurnId, stream] as const,
    ])
    const entries = state.entries.filter((entry) => String(entry.turn.id) !== rootTurnId)
    const liveProjections = new Map(state.liveProjections)
    liveProjections.delete(rootTurnId)
    const model = reconcileTranscriptBlocks(
      project(
        cleared(state.model),
        displayedEntries(entries, replayTurns, liveProjections, projectionStreams, state.model.activeTurnId),
        state.threadCostUsd,
      ),
    )
    return {
      state: {
        ...state,
        model,
        replayTurns,
        entries,
        revisions: new Map([...state.revisions, [rootTurnId, event.state.revision] as const]),
        liveProjections,
        projectionStreams,
      },
      preserveAnchor: false,
    }
  }
  if (event._tag === "TranscriptProjectionPatched") {
    if (event.selectionEpoch !== state.selectionEpoch || state.model.currentThreadId !== event.threadId)
      return unchanged(state)
    const rootTurnId = String(event.rootTurnId)
    const current = state.projectionStreams?.get(rootTurnId)
    if (
      current === undefined ||
      current._tag !== "Open" ||
      current.streamId !== event.streamId ||
      current.patchRevision !== event.baseRevision ||
      event.patchRevision !== event.baseRevision + 1
    )
      return { state, preserveAnchor: false, resync: true }
    if (current.rootStatus !== undefined && event.rootStatus !== undefined && current.rootStatus !== event.rootStatus)
      return { state, preserveAnchor: false, resync: true }
    const currentTurn = state.replayTurns.get(rootTurnId)
    if (
      event.turn !== undefined &&
      (currentTurn === undefined ||
        event.turn.id !== event.rootTurnId ||
        event.turn.threadId !== event.threadId ||
        event.turn._tag !== currentTurn._tag)
    )
      return { state, preserveAnchor: false, resync: true }
    const replayTurns =
      event.turn === undefined ? state.replayTurns : new Map([...state.replayTurns, [rootTurnId, event.turn] as const])
    let units = current.units
    for (const key of event.delta.remove) units = HashMap.remove(units, key)
    for (const unit of event.delta.upsert) units = HashMap.set(units, unit.key, unit)
    const stream: ProjectionStream = {
      _tag: "Open",
      streamId: event.streamId,
      patchRevision: event.patchRevision,
      state: event.state,
      units,
      ...((event.rootStatus ?? current.rootStatus) === undefined
        ? {}
        : { rootStatus: event.rootStatus ?? current.rootStatus }),
    }
    const projectionStreams = new Map([
      ...(state.projectionStreams ?? new Map<string, ProjectionStream>()),
      [rootTurnId, stream] as const,
    ])
    let model = applyTurnDelta(state.model, rootTurnId, event.delta)
    if (model.activeTurnId === rootTurnId && model.busy)
      model = {
        ...model,
        activity: activityAfterOrigin(state.model.activity, event.origin, event.state, model),
      }
    if (event.origin._tag === "Event") {
      let compactionStatus: "running" | "complete" | "failed" | "cancelled" | undefined
      switch (event.origin.type) {
        case "agent.compaction.started":
          compactionStatus = "running"
          break
        case "agent.compaction.completed":
        case "agent.compaction.committed":
          compactionStatus = "complete"
          break
        case "agent.compaction.failed":
          compactionStatus = "failed"
          break
        case "agent.compaction.cancelled":
          compactionStatus = "cancelled"
          break
      }
      if (compactionStatus !== undefined)
        model = updateModel(model, { _tag: "CompactionChanged", status: compactionStatus })
    }
    if (
      event.origin._tag === "Event" &&
      event.origin.type === "steering.delivered" &&
      event.origin.steeringSequences !== undefined
    )
      model = updateModel(model, {
        _tag: "SteeringDelivered",
        turnId: rootTurnId,
        sequences: event.origin.steeringSequences,
      })
    return {
      state: {
        ...state,
        model,
        replayTurns,
        revisions: new Map([...state.revisions, [rootTurnId, event.state.revision] as const]),
        projectionStreams,
      },
      preserveAnchor: false,
    }
  }
  if (event._tag === "TranscriptProjectionStopped") {
    if (event.selectionEpoch !== state.selectionEpoch) return { state, preserveAnchor: false, rejection: "epoch" }
    if (state.model.currentThreadId !== event.threadId) return { state, preserveAnchor: false, rejection: "thread" }
    const rootTurnId = String(event.rootTurnId)
    const current = state.projectionStreams?.get(rootTurnId)
    if (current === undefined || current._tag !== "Open" || current.streamId !== event.streamId)
      return { state, preserveAnchor: false, resync: true, rejection: "stream" }
    if (current.patchRevision !== event.patchRevision)
      return { state, preserveAnchor: false, resync: true, rejection: "patchRevision" }
    if (current.rootStatus !== event.status)
      return { state, preserveAnchor: false, resync: true, rejection: "rootStatus" }
    const turn = state.replayTurns.get(rootTurnId)
    let terminalTurn: Turn.AgentExecutionTurn | ThreadResult.TerminalRecordedShellTurn | undefined
    if (turn !== undefined) {
      if (ThreadResult.TurnResult.isAgentExecution(turn)) terminalTurn = { ...turn, status: event.status }
      else if (ThreadResult.TurnResult.isTerminalRecordedShell(turn) && turn.status === event.status)
        terminalTurn = turn
    }
    if (terminalTurn === undefined) return { state, preserveAnchor: false, resync: true }
    const projectionStreams = new Map<string, ProjectionStream>(state.projectionStreams)
    projectionStreams.set(rootTurnId, {
      _tag: "Stopped",
      streamId: current.streamId,
      patchRevision: current.patchRevision,
      boundary: { _tag: "Stopped", status: event.status },
    })
    const bounded = boundWindow(
      normalizeEntries([
        ...state.entries.filter((entry) => String(entry.turn.id) !== rootTurnId),
        ...projectionEntries(terminalTurn, projectionFromStream(current)),
      ]),
      "oldest",
    )
    const activeTurnId = state.model.activeTurnId
    const knownTurns = new Map([...state.replayTurns, [rootTurnId, terminalTurn] as const])
    const replayTurns = replayTurnsForWindow(bounded.entries, knownTurns, projectionStreams, activeTurnId)
    const liveProjections = new Map(state.liveProjections)
    liveProjections.delete(rootTurnId)
    const model = project(
      cleared(state.model),
      displayedEntries(bounded.entries, replayTurns, liveProjections, projectionStreams, activeTurnId),
      state.threadCostUsd,
    )
    return {
      state: {
        ...state,
        model,
        replayTurns,
        entries: bounded.entries,
        revisions: revisionsForWindow(bounded.entries, activeTurnId, state.revisions, projectionStreams),
        liveProjections,
        projectionStreams,
        hasOlder: state.hasOlder === true || bounded.evicted,
      },
      preserveAnchor: false,
    }
  }
  if (event._tag === "TranscriptProjectionFailed") {
    if (event.selectionEpoch !== state.selectionEpoch || state.model.currentThreadId !== event.threadId)
      return unchanged(state)
    const rootTurnId = String(event.rootTurnId)
    const current = state.projectionStreams?.get(rootTurnId)
    if (
      current === undefined ||
      current._tag !== "Open" ||
      current.streamId !== event.streamId ||
      current.patchRevision !== event.patchRevision
    )
      return { state, preserveAnchor: false, resync: true }
    const projectionStreams = new Map<string, ProjectionStream>(state.projectionStreams)
    projectionStreams.set(rootTurnId, {
      ...current,
      _tag: "Failed",
      boundary: {
        _tag: "Failed",
        executionId: event.executionId,
        reason: event.reason,
        message: event.message,
      },
    })
    return {
      state: { ...state, projectionStreams },
      preserveAnchor: false,
      resync: true,
    }
  }
  if (event.selectionEpoch !== state.selectionEpoch || state.model.currentThreadId !== event.threadId)
    return unchanged(state)
  return unchanged(state)
}

export const updateState: {
  (event: TranscriptEvent): (state: State) => Update
  (state: State, event: TranscriptEvent): Update
} = Function.dual(2, updateStateImpl)
