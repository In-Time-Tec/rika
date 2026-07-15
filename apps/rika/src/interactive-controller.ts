import type * as Operation from "@rika/app/operation"
import type * as TranscriptRepository from "@rika/persistence/transcript-repository"
import type * as Turn from "@rika/persistence/turn"
import { ExecutionEvents, ViewState } from "@rika/tui"
import { Function } from "effect"

type TranscriptEvent = Extract<
  Operation.InteractiveEvent,
  | { readonly _tag: "TranscriptPageReceived" }
  | { readonly _tag: "TranscriptPagePrepended" }
  | { readonly _tag: "TranscriptPatched" }
  | { readonly _tag: "TranscriptResyncRequired" }
>

export interface State {
  readonly model: ViewState.Model
  readonly replayTurns: ReadonlyMap<string, Turn.Turn>
  readonly entries: ReadonlyArray<TranscriptRepository.Entry>
  readonly revisions: ReadonlyMap<string, number>
}

export interface Update {
  readonly state: State
  readonly preserveAnchor: boolean
}

const cleared = (model: ViewState.Model): ViewState.Model => ({
  ...model,
  entries: [],
  blocks: [],
  items: [],
  seenEventIds: [],
  seenExecutionEventKeys: [],
  eventCursor: undefined,
})

const project = (model: ViewState.Model, entries: ReadonlyArray<TranscriptRepository.Entry>) => {
  const next = ExecutionEvents.projectUnits(
    model,
    entries.map((entry) => entry.unit),
  )
  const costs = new Map<string, number>()
  for (const entry of entries)
    if (entry.projectionCostUsd !== undefined) costs.set(entry.turn.id, entry.projectionCostUsd)
  const costUsd = [...costs.values()].reduce((total, cost) => total + cost, 0)
  return costUsd === 0 ? next : { ...next, costUsd: (next.costUsd ?? 0) + costUsd }
}

const prependProjection = (
  model: ViewState.Model,
  entries: ReadonlyArray<TranscriptRepository.Entry>,
): ViewState.Model => {
  const older = project(
    cleared({
      ...model,
      activeTurnId: undefined,
      busy: false,
      busyStatus: undefined,
      costUsd: undefined,
      toolCallDrafts: [],
    }),
    entries,
  )
  const mergedEntries = [...older.entries]
  const mergedBlocks = [...older.blocks] as Array<ViewState.TranscriptBlock>
  const mergedItems = [...older.items] as Array<ViewState.TranscriptItem>
  const mutableBlocks = new Map<string, number>()
  for (const [index, block] of mergedBlocks.entries())
    if (block._tag === "ToolCall" || block._tag === "Permission")
      mutableBlocks.set(`${block._tag}\u0000${block.id}`, index)
  for (const item of model.items as ReadonlyArray<ViewState.TranscriptItem>) {
    if (item._tag === "Entry") {
      const entry = model.entries[item.index]
      if (entry === undefined) continue
      mergedItems.push({ ...item, index: mergedEntries.length })
      mergedEntries.push(entry)
      continue
    }
    const block = model.blocks[item.index] as ViewState.TranscriptBlock | undefined
    if (block === undefined) continue
    if (block._tag === "ToolResult") {
      const index = mutableBlocks.get(`ToolCall\u0000${block.id}`)
      const requested = index === undefined ? undefined : mergedBlocks[index]
      if (index !== undefined && requested?._tag === "ToolCall") {
        mergedBlocks[index] = {
          ...requested,
          output: block.output,
          status: block.failed ? "failed" : "complete",
        }
        continue
      }
    }
    if (block._tag === "ToolCall" || block._tag === "Permission") {
      const key = `${block._tag}\u0000${block.id}`
      const index = mutableBlocks.get(key)
      const current = index === undefined ? undefined : mergedBlocks[index]
      if (index !== undefined && current?._tag === block._tag) {
        mergedBlocks[index] = { ...current, ...block } as ViewState.TranscriptBlock
        continue
      }
      mutableBlocks.set(key, mergedBlocks.length)
    }
    mergedItems.push({ ...item, index: mergedBlocks.length })
    mergedBlocks.push(block)
  }
  return {
    ...model,
    entries: mergedEntries,
    blocks: mergedBlocks,
    items: mergedItems,
    ...(older.costUsd === undefined ? {} : { costUsd: (model.costUsd ?? 0) + older.costUsd }),
  }
}

const updateState = (state: State, event: TranscriptEvent): Update => {
  if (event._tag === "TranscriptPageReceived") {
    if (
      state.model.currentThreadId === event.thread.id &&
      event.entries.some((entry) => entry.projectionRevision < (state.revisions.get(entry.turn.id) ?? -1))
    )
      return { state, preserveAnchor: false }
    const activeTurn = event.entries
      .map((entry) => entry.turn)
      .find((turn) => turn.status === "accepted" || turn.status === "running" || turn.status === "waiting")
    const model = cleared({
      ...state.model,
      activeTurnId: activeTurn?.id,
      busy: activeTurn !== undefined,
      busyStatus: activeTurn === undefined ? undefined : "Working",
      currentThreadId: String(event.thread.id),
      currentThreadTitle: event.thread.title,
      threadSidebar: {
        ...state.model.threadSidebar,
        selected: Math.max(
          0,
          (state.model.threads as ReadonlyArray<ViewState.ThreadItem>).findIndex(
            (thread) => thread.id === event.thread.id,
          ),
        ),
      },
      threadPreview: ViewState.idle,
    })
    return {
      state: {
        model: project(model, event.entries),
        replayTurns: new Map(event.entries.map((entry) => [entry.turn.id, entry.turn])),
        entries: event.entries,
        revisions: new Map(event.entries.map((entry) => [entry.turn.id, entry.projectionRevision])),
      },
      preserveAnchor: false,
    }
  }
  if (event._tag === "TranscriptPagePrepended") {
    if (state.model.currentThreadId !== event.threadId) return { state, preserveAnchor: false }
    const known = new Set(state.entries.map((entry) => entry.unit.key))
    const costedTurns = new Set(
      state.entries.filter((entry) => entry.projectionCostUsd !== undefined).map((entry) => entry.turn.id),
    )
    const prepended = event.entries.filter((entry) => !known.has(entry.unit.key))
    const entries = [...prepended, ...state.entries]
    const projected = prepended.map((entry) =>
      costedTurns.has(entry.turn.id)
        ? { turn: entry.turn, unit: entry.unit, projectionRevision: entry.projectionRevision }
        : entry,
    )
    const revisions = new Map(state.revisions)
    for (const entry of prepended)
      revisions.set(entry.turn.id, Math.max(entry.projectionRevision, revisions.get(entry.turn.id) ?? -1))
    return {
      state: {
        model: prependProjection(state.model, projected),
        replayTurns: new Map([...prepended.map((entry) => [entry.turn.id, entry.turn] as const), ...state.replayTurns]),
        entries,
        revisions,
      },
      preserveAnchor: true,
    }
  }
  if (event._tag === "TranscriptPatched") {
    if (state.model.currentThreadId !== undefined && state.model.currentThreadId !== event.threadId)
      return { state, preserveAnchor: false }
    if (event.revision <= (state.revisions.get(event.turnId) ?? -1)) return { state, preserveAnchor: false }
    return {
      state: {
        ...state,
        model: ExecutionEvents.project(state.model, [{ ...event.event, turnId: event.turnId }]),
        revisions: new Map([...state.revisions, [event.turnId, event.revision]]),
      },
      preserveAnchor: false,
    }
  }
  if (state.model.currentThreadId !== event.threadId) return { state, preserveAnchor: false }
  return {
    state: {
      ...state,
      model: ViewState.update(state.model, { _tag: "ExecutionFailed", message: event.reason }),
    },
    preserveAnchor: false,
  }
}

export const update: {
  (event: TranscriptEvent): (state: State) => Update
  (state: State, event: TranscriptEvent): Update
} = Function.dual(2, updateState)
