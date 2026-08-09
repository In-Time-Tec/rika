import * as ThreadView from "@rika/product/thread-view"
import { Function, Result } from "effect"
import { maxInMemoryTranscriptUnits, trimTranscriptTimeline } from "@rika/terminal/terminal-timeline-bounds"
import { applyRootUnits } from "@rika/terminal/terminal-transcript-presentation"
import type { Model, ThreadItem } from "@rika/terminal/terminal-state"
import { update as updateModel } from "@rika/terminal/terminal-state-reducer"
import type { State, TranscriptEvent, Update } from "./interactive-controller"

const unchanged = (state: State): Update => ({ state, preserveAnchor: false })

const activeUnitActivity = (entry: ThreadView.ThreadViewTurn | undefined): Model["activity"] => {
  if (entry === undefined) return undefined
  let subagents = 0
  let tools = 0
  for (const unit of entry.units) {
    if (unit.content._tag !== "Block") continue
    const block = unit.content.block
    // A cell is how work happens now, so a running one is what the reader is waiting on. Counting
    // only the tool call it used to be leaves the line saying "Waiting" for the whole of a long cell.
    if (block._tag === "Cell" && block.status === "running") tools += 1
    else if (block._tag === "ToolCall" && block.status === "running") {
      if (block.presentation.family === "agent") subagents += 1
      else tools += 1
    } else if (
      block._tag === "SubagentCard" &&
      (block.status === "running" || block.status === "waiting" || block.status === "cancelling")
    )
      subagents += 1
  }
  return subagents === 0 && tools === 0 ? { _tag: "Waiting" } : { _tag: "RunningTools", subagents, tools }
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

const project = (model: Model, snapshot: ThreadView.ThreadViewSnapshot): Model => {
  const active = snapshot.turns.find(
    (entry) =>
      entry.turn.status === "accepted" ||
      entry.turn.status === "running" ||
      entry.turn.status === "cancelling" ||
      entry.turn.status === "waiting",
  )
  const editing = model.editingTurnId !== undefined && snapshot.pending.some((item) => item.id === model.editingTurnId)
  let next: Model = {
    ...clearTimeline(model),
    currentThreadId: String(snapshot.thread.id),
    currentThreadTitle: snapshot.thread.title,
    activeTurnId: active === undefined ? undefined : String(active.turn.id),
    busy: active !== undefined,
    activity: activeUnitActivity(active),
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
  if (event._tag === "ResyncRequired")
    return {
      state,
      preserveAnchor: false,
      resync: true,
      rejection: state.view !== undefined && event.threadId !== state.view.thread.id ? "thread" : "gap",
    }
  if (event._tag === "ThreadViewSnapshot") {
    const sameThread = state.view?.thread.id === event.snapshot.thread.id
    if (sameThread && state.view !== undefined && event.snapshot.revision < state.view.revision) return unchanged(state)
    return {
      state: {
        ...state,
        view: event.snapshot,
        model: project(state.model, event.snapshot),
      },
      preserveAnchor: sameThread,
    }
  }
  if (state.view === undefined) return { state, preserveAnchor: false, resync: true, rejection: "gap" }
  const applied = ThreadView.apply(state.view, event.patch)
  if (Result.isFailure(applied))
    return {
      state,
      preserveAnchor: false,
      resync: true,
      rejection: applied.failure._tag === "ThreadViewForeignThread" ? "thread" : "revision",
    }
  return {
    state: { ...state, view: applied.success, model: project(state.model, applied.success) },
    preserveAnchor: false,
  }
}

export const updateState: {
  (arg0: State, arg1: TranscriptEvent): Update
  (arg1: TranscriptEvent): (arg0: State) => Update
} = Function.dual(2, updateStateImpl)
