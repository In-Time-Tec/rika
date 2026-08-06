import * as ThreadView from "@rika/product/thread-view"
import { Function, Result } from "effect"
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
    if (block._tag === "ToolCall" && block.status === "running") {
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
  let next: Model = {
    ...clearTimeline(model),
    currentThreadId: String(snapshot.thread.id),
    currentThreadTitle: snapshot.thread.title,
    activeTurnId: active === undefined ? undefined : String(active.turn.id),
    busy: active !== undefined,
    activity: activeUnitActivity(active),
    editingTurnId: undefined,
    editReturn: undefined,
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
    if (settled?.status === "failed")
      next = updateModel(next, { _tag: "ExecutionFailed", turnId: settled.id, message: "Execution failed" })
    if (settled?.status === "cancelled")
      next = updateModel(next, { _tag: "ExecutionCancelled", turnId: settled.id, agentResponseArrived: false })
  }
  const usage = snapshot.usage.state
  const contextUsage =
    usage.context === undefined || snapshot.usage.contextCapacity === undefined
      ? { _tag: "Unavailable" as const }
      : {
          _tag: "Available" as const,
          inputTokens: usage.context.inputTokens,
          contextWindow: snapshot.usage.contextCapacity.contextWindow,
          reserveTokens: snapshot.usage.contextCapacity.reserveTokens,
        }
  next = updateModel(next, { _tag: "ContextUsageReplaced", contextUsage })
  const costUsd = usage.costNanoUsd === undefined ? undefined : usage.costNanoUsd / 1_000_000_000
  return {
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
  }
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
