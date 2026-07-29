import { ExecutionStatus } from "@rika/tools"
import type * as Operation from "@rika/app/operation"
import type * as TranscriptRepository from "@rika/persistence/transcript-repository"
import type * as Turn from "@rika/persistence/turn"
import * as Transcript from "@rika/transcript"
import { TranscriptPresenter, ViewState } from "@rika/tui"
import { Effect, Function } from "effect"

type TranscriptEvent = Extract<
  Operation.InteractiveEvent,
  | { readonly _tag: "SelectionLoaded" }
  | { readonly _tag: "TranscriptReplaced" }
  | { readonly _tag: "TranscriptPagePrepended" }
  | { readonly _tag: "TranscriptPageAppended" }
  | { readonly _tag: "TranscriptPatched" }
  | { readonly _tag: "TranscriptResyncRequired" }
  | { readonly _tag: "ThreadUsageUpdated" }
  | { readonly _tag: "ThreadRefolding" }
>

type QueueEvent = Extract<
  Operation.InteractiveEvent,
  { readonly _tag: "QueueUpdated" } | { readonly _tag: "QueueFull" }
>

export interface State {
  readonly model: ViewState.Model
  readonly selectionEpoch: number
  readonly replayTurns: ReadonlyMap<string, Turn.Turn>
  readonly entries: ReadonlyArray<TranscriptRepository.Entry>
  readonly revisions: ReadonlyMap<string, number>
  readonly liveProjections: ReadonlyMap<string, Transcript.Projection>
  readonly transientEventCursors: ReadonlySet<string>
  readonly threadCostUsd?: number
  readonly usageRevision?: number
  readonly attachedChildRevisions?: ReadonlyMap<string, number>
  readonly hasOlder?: boolean
  readonly hasNewer?: boolean
  readonly oldestCursor?: TranscriptRepository.PageCursor | undefined
  readonly newestCursor?: TranscriptRepository.PageCursor | undefined
}

export const transcriptWindowEntryBudget = 400
export const transcriptWindowByteBudget = 4 * 1024 * 1024

const entryBytes = (entry: TranscriptRepository.Entry): number =>
  new TextEncoder().encode(JSON.stringify(entry)).byteLength
const cursorForEntry = (entry: TranscriptRepository.Entry | undefined): TranscriptRepository.PageCursor | undefined =>
  entry === undefined
    ? undefined
    : {
        createdAt: entry.turn.createdAt,
        turnId: entry.turn.id,
        sequence: entry.unit.order.sequence,
        part: entry.unit.order.part,
        key: entry.unit.key,
      }

const sameCursor = (
  left: TranscriptRepository.PageCursor | undefined,
  right: TranscriptRepository.PageCursor | undefined,
) =>
  left?.createdAt === right?.createdAt &&
  left?.turnId === right?.turnId &&
  left?.sequence === right?.sequence &&
  left?.part === right?.part &&
  left?.key === right?.key

const boundWindow = (
  entries: ReadonlyArray<TranscriptRepository.Entry>,
  edge: "oldest" | "newest",
): { readonly entries: ReadonlyArray<TranscriptRepository.Entry>; readonly evicted: boolean } => {
  const retained = [...entries]
  let bytes = retained.reduce((total, entry) => total + entryBytes(entry), 0)
  let evicted = false
  while (retained.length > transcriptWindowEntryBudget || bytes > transcriptWindowByteBudget) {
    const index = edge === "oldest" ? 0 : retained.length - 1
    bytes -= entryBytes(retained[index]!)
    retained.splice(index, 1)
    evicted = true
  }
  return { entries: retained, evicted }
}

export interface Update {
  readonly state: State
  readonly preserveAnchor: boolean
  readonly unattached?: ReadonlyArray<string>
  readonly discarded?: boolean
}

export const warnUnattached = (unattached: ReadonlyArray<string>): Effect.Effect<void> =>
  Effect.forEach(
    unattached,
    (turnId) =>
      Effect.logWarning("transcript.child.parent_missing").pipe(Effect.annotateLogs({ "rika.turn.id": turnId })),
    { discard: true },
  )

export interface QueueUpdate {
  readonly model: ViewState.Model
  readonly resync: boolean
}

export interface PaletteCommand {
  readonly id: string
  readonly category: string
  readonly label: string
  readonly action: unknown
}

export const paletteCommands = [
  { id: "new-thread", category: "thread", label: "New thread", action: { _tag: "NewThread" as const } },
] as const

export const installPaletteCommands = (commands: Array<PaletteCommand>): void => {
  for (const command of paletteCommands.toReversed())
    if (!commands.some((candidate) => candidate.id === command.id)) commands.unshift(command)
}

export const paletteCommand = (action: unknown): Operation.InteractiveCommand | undefined =>
  action !== null && typeof action === "object" && "_tag" in action && action._tag === "NewThread"
    ? { _tag: "NewThread" }
    : undefined

const updateQueueImpl = (model: ViewState.Model, event: QueueEvent): QueueUpdate => {
  if (event._tag === "QueueUpdated") {
    if (event.change._tag === "Reset")
      return {
        model: ViewState.resetQueue(model, event.threadId, event.revision, event.change.items),
        resync: false,
      }
    return ViewState.applyQueueDelta(model, event.threadId, event.revision, event.change, event.queuedCount)
  }
  const submittedPrompt = model.history.at(-1)
  const failed = ViewState.update(model, {
    _tag: "ExecutionFailed",
    message: `Queue full: ${event.count} pending prompts`,
  })
  return {
    model:
      submittedPrompt === undefined
        ? failed
        : ViewState.update(failed, { _tag: "ComposerReplaced", text: submittedPrompt }),
    resync: false,
  }
}

export const updateQueue: {
  (event: QueueEvent): (model: ViewState.Model) => QueueUpdate
  (model: ViewState.Model, event: QueueEvent): QueueUpdate
} = Function.dual(2, updateQueueImpl)

const removePromotedTurnImpl = (model: ViewState.Model, threadId: string, turnId: string): ViewState.Model => {
  if (!model.queue.some((item) => item.id === turnId)) return model
  const revision = (model.queueRevision ?? 0) + 1
  const applied = ViewState.applyQueueDelta(
    model,
    threadId,
    revision,
    { _tag: "Removed", turnId },
    model.queue.length - 1,
  )
  return applied.model.queue.some((item) => item.id === turnId)
    ? ViewState.resetQueue(
        model,
        threadId,
        revision,
        model.queue.filter((item) => item.id !== turnId),
      )
    : applied.model
}

export const removePromotedTurn: {
  (threadId: string, turnId: string): (model: ViewState.Model) => ViewState.Model
  (model: ViewState.Model, threadId: string, turnId: string): ViewState.Model
} = Function.dual(3, removePromotedTurnImpl)

const cleared = (model: ViewState.Model): ViewState.Model => ({
  ...model,
  entries: [],
  blocks: [],
  items: [],
  seenEventIds: [],
  seenExecutionEventKeys: [],
  childExecutionOutcomes: {},
  eventCursor: undefined,
})

const retaining = (model: ViewState.Model, previous: ViewState.Model): ViewState.Model => ({
  ...model,
  entries: previous.entries,
  blocks: previous.blocks,
  items: previous.items,
  seenEventIds: previous.seenEventIds,
  seenExecutionEventKeys: previous.seenExecutionEventKeys,
  childExecutionOutcomes: previous.childExecutionOutcomes,
  eventCursor: previous.eventCursor,
})

const activeSeedEntries = (
  activeTurn: Turn.Turn | undefined,
  entries: ReadonlyArray<TranscriptRepository.Entry>,
): ReadonlyArray<TranscriptRepository.Entry> => {
  if (activeTurn === undefined || entries.some((entry) => entry.turn.id === activeTurn.id)) return []
  const seed = Transcript.empty(activeTurn.id, activeTurn.prompt)
  return seed.units.map((unit) => ({
    turn: activeTurn,
    unit,
    projectionRevision: seed.revision,
    projectionModelPhase: seed.modelPhase,
  }))
}

const project = (
  model: ViewState.Model,
  entries: ReadonlyArray<TranscriptRepository.Entry>,
  displayCostUsd: number | undefined,
) => {
  const next = TranscriptPresenter.applyTurnUnits(
    model,
    entries.map((entry) => entry.unit),
  )
  const { costUsd: _, ...withoutCost } = next
  return displayCostUsd === undefined ? withoutCost : { ...withoutCost, costUsd: displayCostUsd }
}

const projectionEntries = (
  turn: Turn.Turn,
  projection: Transcript.Projection,
): ReadonlyArray<TranscriptRepository.Entry> =>
  projection.units.map((unit) => ({
    turn,
    unit,
    projectionRevision: projection.revision,
    projectionModelPhase: projection.modelPhase,
    ...(projection.costUsd === undefined ? {} : { projectionCostUsd: projection.costUsd }),
  }))

const displayedEntries = (
  entries: ReadonlyArray<TranscriptRepository.Entry>,
  replayTurns: ReadonlyMap<string, Turn.Turn>,
  liveProjections: ReadonlyMap<string, Transcript.Projection>,
  activeTurnId: string | undefined,
) => {
  if (activeTurnId === undefined) return entries
  const turn = replayTurns.get(activeTurnId)
  const projection = liveProjections.get(activeTurnId)
  return turn === undefined || projection === undefined
    ? entries
    : normalizeEntries([...entries, ...projectionEntries(turn, projection)])
}

const reconcileTranscriptBlocks = (model: ViewState.Model): ViewState.Model => {
  const blocks: Array<ViewState.TranscriptBlock> = []
  const items: Array<ViewState.TranscriptItem> = []
  const mutableBlocks = new Map<string, number>()
  for (const item of model.items as ReadonlyArray<ViewState.TranscriptItem>) {
    if (item._tag === "Entry") {
      items.push(item)
      continue
    }
    const block = model.blocks[item.index] as ViewState.TranscriptBlock | undefined
    if (block === undefined) continue
    if (block._tag === "ToolResult") {
      const index = mutableBlocks.get(`ToolCall\u0000${block.id}`)
      const requested = index === undefined ? undefined : blocks[index]
      if (index !== undefined && requested?._tag === "ToolCall") {
        blocks[index] = {
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
      const current = index === undefined ? undefined : blocks[index]
      if (index !== undefined && current?._tag === block._tag) {
        blocks[index] = { ...current, ...block } as ViewState.TranscriptBlock
        continue
      }
      mutableBlocks.set(key, blocks.length)
    }
    items.push({ ...item, index: blocks.length })
    blocks.push(block)
  }
  return { ...model, blocks, items }
}

const projections = (
  entries: ReadonlyArray<TranscriptRepository.Entry>,
): ReadonlyMap<string, Transcript.Projection> => {
  const grouped = new Map<string, Array<TranscriptRepository.Entry>>()
  for (const entry of entries) grouped.set(entry.turn.id, [...(grouped.get(entry.turn.id) ?? []), entry])
  return new Map(
    [...grouped].map(([turnId, values]) => {
      const latest = values.reduce((left, right) =>
        right.projectionRevision >= left.projectionRevision ? right : left,
      )
      const cost = values.find((entry) => entry.projectionCostUsd !== undefined)?.projectionCostUsd
      return [
        turnId,
        {
          units: values.map((entry) => entry.unit),
          revision: latest.projectionRevision,
          modelPhase: latest.projectionModelPhase,
          ...(cost === undefined ? {} : { costUsd: cost }),
        },
      ] as const
    }),
  )
}

const projectionFromEntries = (
  entries: ReadonlyArray<TranscriptRepository.Entry>,
  turnId: string,
  prompt: string,
): Transcript.Projection => projections(entries).get(turnId) ?? Transcript.empty(turnId, prompt)

const sourceText = (event: Transcript.SourceEvent): string => {
  if (typeof event.text === "string") return event.text
  const delta = event.data?.delta
  return typeof delta === "string" ? delta : ""
}

const sourceBlockId = (event: Transcript.SourceEvent, fallback: string): string => {
  const id = event.data?.tool_call_id ?? event.data?.call_id ?? event.data?.id
  return typeof id === "string" ? id : fallback
}

const activityAfter = (
  activity: ViewState.Activity | undefined,
  event: Transcript.SourceEvent,
  projection: Transcript.Projection,
  model: ViewState.Model,
): ViewState.Activity | undefined => {
  const runningActivity = ViewState.runningToolsActivity(model)
  const running =
    runningActivity._tag === "RunningTools" && (runningActivity.subagents ?? 0) + (runningActivity.tools ?? 0) > 0
  if (event.type.includes("reasoning"))
    return running
      ? runningActivity
      : ViewState.streamActivity(activity, "Thinking", sourceText(event), `reasoning:${projection.modelPhase}`)
  if (event.type === "model.output.delta")
    return running
      ? runningActivity
      : ViewState.streamActivity(activity, "Streaming", sourceText(event), `answer:${projection.modelPhase}`)
  if (event.type === "model.toolcall.delta")
    return running
      ? runningActivity
      : ViewState.streamActivity(activity, "Streaming", sourceText(event), sourceBlockId(event, "tool"))
  if (event.type === "tool.call.requested" || event.type === "tool.call.executing" || event.type === "tool.started")
    return runningActivity
  if (event.type === "tool.result.received") return running ? runningActivity : { _tag: "Waiting" }
  if (
    event.type === "execution.accepted" ||
    event.type === "execution.started" ||
    event.type === "model.input.prepared" ||
    event.type === "model.output.completed" ||
    event.type === "permission.ask.requested" ||
    event.type === "permission.ask.resolved" ||
    event.type === "tool.approval.requested" ||
    event.type === "tool.approval.resolved"
  )
    return running ? runningActivity : { _tag: "Waiting" }
  if (event.type === "execution.completed" || event.type === "execution.failed" || event.type === "execution.cancelled")
    return running ? runningActivity : undefined
  return running ? runningActivity : activity
}

const normalizeEntries = (
  entries: ReadonlyArray<TranscriptRepository.Entry>,
): ReadonlyArray<TranscriptRepository.Entry> => {
  const unique = new Map<string, TranscriptRepository.Entry>()
  for (const entry of entries) {
    const current = unique.get(entry.unit.key)
    if (current === undefined || entry.projectionRevision >= current.projectionRevision)
      unique.set(entry.unit.key, entry)
  }
  return [...unique.values()].toSorted(
    (left, right) =>
      left.turn.createdAt - right.turn.createdAt ||
      left.turn.id.localeCompare(right.turn.id) ||
      left.unit.order.sequence - right.unit.order.sequence ||
      left.unit.order.part - right.unit.order.part ||
      left.unit.key.localeCompare(right.unit.key),
  )
}

const updateState = (state: State, event: TranscriptEvent): Update => {
  if (event._tag === "ThreadRefolding")
    return {
      state: {
        ...state,
        model: ViewState.update(state.model, {
          _tag: "ThreadRefolding",
          threadId: String(event.threadId),
          refolding: event.refolding,
        }),
      },
      preserveAnchor: false,
    }
  if (event._tag === "ThreadUsageUpdated") {
    if (event.selectionEpoch !== state.selectionEpoch || event.threadId !== state.model.currentThreadId)
      return { state, preserveAnchor: false }
    if (state.usageRevision !== undefined && event.revision < state.usageRevision)
      return { state, preserveAnchor: false }
    const threadCostUsd = event.cost._tag === "Available" ? event.cost.usd : state.threadCostUsd
    const { costUsd: _, ...withoutCost } = state.model
    return {
      state: {
        ...state,
        usageRevision: event.revision,
        ...(threadCostUsd === undefined ? {} : { threadCostUsd }),
        model: {
          ...withoutCost,
          usageCost: event.cost,
          usageTokens: event.tokens,
          usageTime: event.time,
          ...(threadCostUsd === undefined ? {} : { costUsd: threadCostUsd }),
        },
      },
      preserveAnchor: false,
    }
  }
  if (event._tag === "SelectionLoaded") {
    if (event.selectionEpoch < state.selectionEpoch) return { state, preserveAnchor: false }
    if (
      event.selectionEpoch === state.selectionEpoch &&
      state.model.currentThreadId === event.thread.id &&
      event.entries.some((entry) => entry.projectionRevision < (state.revisions.get(entry.turn.id) ?? -1))
    )
      return { state, preserveAnchor: false }
    const activeTurn = event.activeTurn
    const keepNewerQueue =
      event.selectionEpoch === state.selectionEpoch &&
      state.model.queueThreadId === event.thread.id &&
      (state.model.queueRevision ?? -1) > event.queueRevision
    const queue = keepNewerQueue ? state.model.queue : event.queue
    const queueRevision = keepNewerQueue ? state.model.queueRevision : event.queueRevision
    const entries = normalizeEntries(event.entries)
    const sameSelection =
      event.selectionEpoch === state.selectionEpoch && state.model.currentThreadId === event.thread.id
    const model = cleared({
      ...state.model,
      ...(sameSelection
        ? {}
        : {
            usageCost: { _tag: "Loading" as const },
            usageTokens: { _tag: "Loading" as const },
            usageTime: { _tag: "Loading" as const },
          }),
      activeTurnId: activeTurn?.id,
      busy: activeTurn !== undefined,
      activity: activeTurn === undefined ? undefined : { _tag: "Waiting" },
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
          (state.model.threads as ReadonlyArray<ViewState.ThreadItem>).findIndex(
            (thread) => thread.id === event.thread.id,
          ),
        ),
      },
      threadPreview: ViewState.idle,
    })
    const selectedCostUsd = event.threadCostUsd ?? (sameSelection ? state.threadCostUsd : undefined)
    const activeProjection =
      activeTurn === undefined
        ? undefined
        : projectionFromEntries(
            normalizeEntries([...entries, ...activeSeedEntries(activeTurn, entries)]),
            activeTurn.id,
            activeTurn.prompt,
          )
    const history = activeTurn === undefined ? entries : entries.filter((entry) => entry.turn.id !== activeTurn.id)
    const boundedSelection = boundWindow(history, "oldest")
    const selected = boundedSelection.entries
    const replayTurns = new Map([
      ...selected.map((entry) => [entry.turn.id, entry.turn] as const),
      ...(activeTurn === undefined ? [] : [[activeTurn.id, activeTurn] as const]),
    ])
    const liveProjections = new Map(
      activeTurn === undefined || activeProjection === undefined ? [] : ([[activeTurn.id, activeProjection]] as const),
    )
    const projected = project(
      model,
      displayedEntries(selected, replayTurns, liveProjections, activeTurn?.id),
      selectedCostUsd,
    )
    if (
      state.model.currentThreadId === String(event.thread.id) &&
      projected.items.length === 0 &&
      state.model.items.length > 0
    )
      return {
        state: {
          ...state,
          selectionEpoch: event.selectionEpoch,
          model: retaining(model, state.model),
          replayTurns:
            activeTurn === undefined
              ? state.replayTurns
              : new Map([...state.replayTurns, [activeTurn.id, activeTurn] as const]),
          ...(selectedCostUsd === undefined ? {} : { threadCostUsd: selectedCostUsd }),
        },
        preserveAnchor: true,
        discarded: true,
      }
    return {
      state: {
        selectionEpoch: event.selectionEpoch,
        model: projected,
        replayTurns,
        entries: selected,
        revisions: new Map([
          ...selected.map((entry) => [entry.turn.id, entry.projectionRevision] as const),
          ...(activeTurn === undefined || activeProjection === undefined
            ? []
            : ([[activeTurn.id, activeProjection.revision]] as const)),
        ]),
        liveProjections,
        transientEventCursors: new Set(),
        hasOlder: event.hasOlder || boundedSelection.evicted,
        hasNewer: event.hasNewer ?? false,
        oldestCursor: event.oldestCursor ?? cursorForEntry(selected[0]),
        newestCursor: event.newestCursor,
        ...(selectedCostUsd === undefined ? {} : { threadCostUsd: selectedCostUsd }),
      },
      preserveAnchor: false,
    }
  }
  if (event._tag === "TranscriptReplaced") {
    if (event.selectionEpoch !== state.selectionEpoch || state.model.currentThreadId !== event.threadId)
      return { state, preserveAnchor: false }
    const replacement = normalizeEntries(event.entries).filter((entry) => entry.turn.id !== state.model.activeTurnId)
    const replacementTurns = new Set(replacement.map((entry) => entry.turn.id))
    const staleTurns = new Set(
      replacement
        .filter((entry) => entry.projectionRevision < (state.revisions.get(entry.turn.id) ?? -1))
        .map((entry) => entry.turn.id),
    )
    const bounded = boundWindow(
      normalizeEntries([
        ...replacement.filter((entry) => !staleTurns.has(entry.turn.id)),
        ...state.entries.filter((entry) => staleTurns.has(entry.turn.id) || !replacementTurns.has(entry.turn.id)),
      ]),
      "oldest",
    )
    const entries = bounded.entries
    const threadCostUsd = event.threadCostUsd ?? state.threadCostUsd
    const { threadCostUsd: _threadCostUsd, ...stateWithoutCost } = state
    const replayTurns = new Map([
      ...entries.map((entry) => [entry.turn.id, entry.turn] as const),
      ...[...state.replayTurns].filter(
        ([turnId]) => turnId === state.model.activeTurnId || !entries.some((entry) => entry.turn.id === turnId),
      ),
    ])
    const liveProjections = new Map(
      [...state.liveProjections].filter(([turnId]) => turnId === state.model.activeTurnId || !replayTurns.has(turnId)),
    )
    return {
      state: {
        ...stateWithoutCost,
        model: reconcileTranscriptBlocks(
          project(
            cleared(state.model),
            displayedEntries(entries, replayTurns, liveProjections, state.model.activeTurnId),
            threadCostUsd,
          ),
        ),
        replayTurns,
        entries,
        revisions: new Map(entries.map((entry) => [entry.turn.id, entry.projectionRevision])),
        liveProjections,
        hasOlder: state.hasOlder === true || bounded.evicted,
        oldestCursor: event.oldestCursor ?? cursorForEntry(entries[0]),
        ...(threadCostUsd === undefined ? {} : { threadCostUsd }),
      },
      preserveAnchor: true,
    }
  }
  if (event._tag === "TranscriptPagePrepended") {
    if (event.selectionEpoch !== state.selectionEpoch) return { state, preserveAnchor: false }
    if (state.model.currentThreadId !== event.threadId) return { state, preserveAnchor: false }
    const bounded = boundWindow(
      normalizeEntries([...state.entries, ...event.entries]).filter(
        (entry) => entry.turn.id !== state.model.activeTurnId,
      ),
      "newest",
    )
    const entries = bounded.entries
    const threadCostUsd = event.threadCostUsd ?? state.threadCostUsd
    const { threadCostUsd: _threadCostUsd, ...stateWithoutCost } = state
    const replayTurns = new Map([
      ...entries.map((entry) => [entry.turn.id, entry.turn] as const),
      ...[...state.replayTurns].filter(([turnId]) => turnId === state.model.activeTurnId),
    ])
    const liveProjections = new Map(
      [...state.liveProjections].filter(([turnId]) => turnId === state.model.activeTurnId || !replayTurns.has(turnId)),
    )
    return {
      state: {
        ...stateWithoutCost,
        model: reconcileTranscriptBlocks(
          project(
            cleared(state.model),
            displayedEntries(entries, replayTurns, liveProjections, state.model.activeTurnId),
            threadCostUsd,
          ),
        ),
        replayTurns,
        entries,
        revisions: new Map(entries.map((entry) => [entry.turn.id, entry.projectionRevision])),
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
      return { state, preserveAnchor: false }
    if (!sameCursor(event.requestedAfter, state.newestCursor)) return { state, preserveAnchor: false }
    const bounded = boundWindow(
      normalizeEntries([...state.entries, ...event.entries]).filter(
        (entry) => entry.turn.id !== state.model.activeTurnId,
      ),
      "oldest",
    )
    const entries = bounded.entries
    const threadCostUsd = event.threadCostUsd ?? state.threadCostUsd
    const replayTurns = new Map([
      ...entries.map((entry) => [entry.turn.id, entry.turn] as const),
      ...[...state.replayTurns].filter(([turnId]) => turnId === state.model.activeTurnId),
    ])
    const liveProjections = new Map(
      [...state.liveProjections].filter(([turnId]) => turnId === state.model.activeTurnId || !replayTurns.has(turnId)),
    )
    return {
      state: {
        ...state,
        model: reconcileTranscriptBlocks(
          project(
            cleared(state.model),
            displayedEntries(entries, replayTurns, liveProjections, state.model.activeTurnId),
            threadCostUsd,
          ),
        ),
        replayTurns,
        entries,
        revisions: new Map(entries.map((entry) => [entry.turn.id, entry.projectionRevision])),
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
  if (event._tag === "TranscriptPatched") {
    if (event.selectionEpoch !== state.selectionEpoch) return { state, preserveAnchor: false }
    if (state.model.currentThreadId !== undefined && state.model.currentThreadId !== event.threadId)
      return { state, preserveAnchor: false }
    const threadCostUsd = event.threadCostUsd ?? state.threadCostUsd
    const { threadCostUsd: _threadCostUsd, ...stateWithoutCost } = state
    const transient = Transcript.isTransientEvent(event.event)
    const transientEventKey = `${event.turnId}\u0000${event.event.cursor}`
    if (transient && state.transientEventCursors.has(transientEventKey)) return { state, preserveAnchor: false }
    const transientEventCursors = transient
      ? new Set([...state.transientEventCursors, transientEventKey])
      : state.transientEventCursors
    if (!transient && event.revision <= (state.revisions.get(event.turnId) ?? -1)) {
      if (event.threadCostUsd === undefined) return { state, preserveAnchor: false }
      const { costUsd: _costUsd, ...modelWithoutCost } = state.model
      return {
        state: {
          ...stateWithoutCost,
          model: threadCostUsd === undefined ? modelWithoutCost : { ...modelWithoutCost, costUsd: threadCostUsd },
          ...(threadCostUsd === undefined ? {} : { threadCostUsd }),
        },
        preserveAnchor: false,
      }
    }
    const revisions = transient
      ? state.revisions
      : new Map([...state.revisions, [event.turnId, event.revision]] as const)
    const turn = state.replayTurns.get(event.turnId)
    if (turn === undefined) {
      const previous = state.liveProjections.get(event.turnId) ?? Transcript.empty(event.turnId, "")
      const next = Transcript.applyEvent(previous, event.event)
      const liveProjections = new Map([...state.liveProjections, [event.turnId, next]] as const)
      const rootTurnId = event.rootTurnId
      const rootTurnCostUsd = event.rootTurnCostUsd
      const entries =
        rootTurnId === undefined || rootTurnCostUsd === undefined
          ? state.entries
          : state.entries.map((entry) =>
              entry.turn.id === rootTurnId ? { ...entry, projectionCostUsd: rootTurnCostUsd } : entry,
            )
      const attachmentProjections = new Map([...projections(entries), ...liveProjections])
      const childTerminal =
        event.event.type === "execution.completed" ||
        event.event.type === "execution.failed" ||
        event.event.type === "execution.cancelled"
      const attached = TranscriptPresenter.attachChildProjections(
        state.model,
        state.replayTurns,
        attachmentProjections,
        childTerminal
          ? TranscriptPresenter.emptyAttachments
          : (state.attachedChildRevisions ?? TranscriptPresenter.emptyAttachments),
      )
      const { costUsd: _costUsd, ...modelWithoutCost } = attached.model
      return {
        state: {
          ...stateWithoutCost,
          model: threadCostUsd === undefined ? modelWithoutCost : { ...modelWithoutCost, costUsd: threadCostUsd },
          entries,
          revisions,
          liveProjections,
          transientEventCursors,
          ...(threadCostUsd === undefined ? {} : { threadCostUsd }),
          attachedChildRevisions: attached.attachments,
        },
        preserveAnchor: false,
        unattached: attached.unattached,
      }
    }
    const active = state.model.activeTurnId === event.turnId
    const previous =
      state.liveProjections.get(event.turnId) ?? projectionFromEntries(state.entries, event.turnId, turn.prompt)
    const projected = Transcript.applyEvent(previous, event.event)
    const next =
      event.rootTurnId === event.turnId && event.rootTurnCostUsd !== undefined
        ? { ...projected, costUsd: event.rootTurnCostUsd }
        : projected
    const terminal =
      event.event.type === "execution.completed" ||
      event.event.type === "execution.failed" ||
      event.event.type === "execution.cancelled"
    let entries = state.entries
    let evicted = false
    const liveProjections = new Map(state.liveProjections)
    if (active && !terminal) liveProjections.set(event.turnId, next)
    else {
      const known = new Map(state.entries.map((entry, index) => [entry.unit.key, index] as const))
      const merged = [...state.entries]
      for (const entry of projectionEntries(turn, next)) {
        const index = known.get(entry.unit.key)
        if (index === undefined) {
          known.set(entry.unit.key, merged.length)
          merged.push(entry)
        } else merged[index] = entry
      }
      const bounded = boundWindow(normalizeEntries(merged), "oldest")
      entries = bounded.entries
      evicted = bounded.evicted
      liveProjections.delete(event.turnId)
    }
    const attachmentProjections = new Map([...projections(entries), ...liveProjections])
    const attached = TranscriptPresenter.attachChildProjections(
      TranscriptPresenter.applyTurnUnits(state.model, next.units),
      state.replayTurns,
      attachmentProjections,
      terminal
        ? TranscriptPresenter.emptyAttachments
        : (state.attachedChildRevisions ?? TranscriptPresenter.emptyAttachments),
    )
    const projectedModel = {
      ...attached.model,
      activity: activityAfter(state.model.activity, event.event, next, attached.model),
    }
    const terminalStatus = ExecutionStatus.terminalEventStatus(event.event.type)
    const model = terminal
      ? { ...projectedModel, activeTurnId: undefined, busy: false, activity: undefined }
      : projectedModel
    const { costUsd: _costUsd, ...modelWithoutCost } = model
    return {
      state: {
        ...stateWithoutCost,
        model: threadCostUsd === undefined ? modelWithoutCost : { ...modelWithoutCost, costUsd: threadCostUsd },
        replayTurns:
          terminalStatus === undefined
            ? state.replayTurns
            : new Map([...state.replayTurns, [event.turnId, { ...turn, status: terminalStatus }]]),
        entries,
        revisions,
        liveProjections,
        transientEventCursors,
        hasOlder: state.hasOlder === true || evicted,
        ...(threadCostUsd === undefined ? {} : { threadCostUsd }),
        attachedChildRevisions: attached.attachments,
      },
      preserveAnchor: false,
      unattached: attached.unattached,
    }
  }
  if (event.selectionEpoch !== state.selectionEpoch || state.model.currentThreadId !== event.threadId)
    return { state, preserveAnchor: false }
  return { state, preserveAnchor: false }
}

export const update: {
  (event: TranscriptEvent): (state: State) => Update
  (state: State, event: TranscriptEvent): Update
} = Function.dual(2, updateState)

export const isUrgentFeedEvent = (event: Operation.InteractiveEvent): boolean =>
  event._tag === "TranscriptPatched" &&
  (event.event.type === "tool.approval.requested" || event.event.type === "permission.ask.requested")

export const makeFeedFrameBatcher = <Event>(options: {
  readonly schedule: (flush: () => void) => void
  readonly apply: (events: ReadonlyArray<Event>) => void
  readonly render: () => void
  readonly lane?: (event: Event) => string | undefined
  readonly urgent?: (event: Event) => boolean
}) => {
  type BatchState = { readonly _tag: "Idle" } | { readonly _tag: "Scheduled" }
  const pending: Array<Event> = []
  let state: BatchState = { _tag: "Idle" }
  const schedule = (flush: () => void) => {
    state = { _tag: "Scheduled" }
    options.schedule(flush)
  }
  const takeBatch = (): ReadonlyArray<Event> => {
    const laneOf = options.lane
    const isUrgent = options.urgent
    if (pending.length <= 256 || laneOf === undefined || isUrgent === undefined) return pending.splice(0, 256)
    const urgentIndex = pending.findIndex((event, index) => {
      if (index < 256 || !isUrgent(event)) return false
      const lane = laneOf(event)
      return lane !== undefined
    })
    if (urgentIndex < 0) return pending.splice(0, 256)
    const urgentLane = laneOf(pending[urgentIndex]!)
    if (urgentLane === undefined) return pending.splice(0, 256)
    let prefixCount = 255
    let promotedIndexes: ReadonlyArray<number> = [urgentIndex]
    while (true) {
      const required = pending
        .map((event, index) => ({ event, index }))
        .filter(({ event, index }) => index >= prefixCount && index <= urgentIndex && laneOf(event) === urgentLane)
        .map(({ index }) => index)
      const nextPrefixCount = 256 - required.length
      if (nextPrefixCount === prefixCount) {
        promotedIndexes = required
        break
      }
      if (nextPrefixCount < 0) return pending.splice(0, 256)
      prefixCount = nextPrefixCount
    }
    const promoted = promotedIndexes.map((index) => pending[index]!)
    for (const index of promotedIndexes.toReversed()) pending.splice(index, 1)
    return [...pending.splice(0, prefixCount), ...promoted]
  }
  const flush = () => {
    state = { _tag: "Idle" }
    if (pending.length === 0) return
    const events = takeBatch()
    options.apply(events)
    options.render()
    if (pending.length > 0) schedule(flush)
  }
  const offer = (event: Event) => {
    pending.push(event)
    if (state._tag === "Scheduled") return
    schedule(flush)
  }
  return { offer, flush }
}
