import * as TranscriptPage from "@rika/product/transcript-page"
import type * as Operation from "@rika/product/product-operation-service"
import * as Turn from "@rika/product/turn-record"
import * as ThreadResult from "@rika/product/thread-result"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptProjectionModel from "@rika/transcript/transcript-projection-model"
import * as TranscriptSourceEvent from "@rika/transcript/transcript-source-event"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { TranscriptPresenter, ViewState } from "@rika/terminal/terminal-state"
import { Effect, Function, HashMap } from "effect"

type TranscriptEvent = Extract<
  Operation.InteractiveEvent,
  | { readonly _tag: "SelectionLoaded" }
  | { readonly _tag: "TranscriptPagePrepended" }
  | { readonly _tag: "TranscriptPageAppended" }
  | { readonly _tag: "TranscriptProjectionStarted" }
  | { readonly _tag: "TranscriptProjectionPatched" }
  | { readonly _tag: "TranscriptProjectionStopped" }
  | { readonly _tag: "TranscriptProjectionFailed" }
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
  readonly entries: ReadonlyArray<TranscriptPage.Entry>
  readonly revisions: ReadonlyMap<string, number>
  readonly liveProjections: ReadonlyMap<string, TranscriptProjectionModel.Projection>
  readonly projectionStreams?: ReadonlyMap<string, ProjectionStream>
  readonly threadCostUsd?: number
  readonly lastAvailableUsageCost?: Extract<ViewState.Model["usageCost"], { readonly _tag: "Available" }>
  readonly usageRevision?: number
  readonly hasOlder?: boolean
  readonly hasNewer?: boolean
  readonly oldestCursor?: TranscriptPage.PageCursor | undefined
  readonly newestCursor?: TranscriptPage.PageCursor | undefined
}

interface OpenProjectionStream {
  readonly _tag: "Open"
  readonly streamId: string
  readonly patchRevision: number
  readonly state: {
    readonly revision: number
    readonly modelPhase: number
    readonly usableCompletionSequence?: number
  }
  readonly units: HashMap.HashMap<string, TranscriptUnit.Unit>
  readonly rootStatus?: "completed" | "failed" | "cancelled"
}

interface StoppedProjectionStream {
  readonly _tag: "Stopped"
  readonly streamId: string
  readonly patchRevision: number
  readonly boundary: { readonly _tag: "Stopped"; readonly status: "completed" | "failed" | "cancelled" }
}

interface FailedProjectionStream extends Omit<OpenProjectionStream, "_tag"> {
  readonly _tag: "Failed"
  readonly boundary: {
    readonly _tag: "Failed"
    readonly executionId: string
    readonly reason: string
    readonly message: string
  }
}

export type ProjectionStream = OpenProjectionStream | StoppedProjectionStream | FailedProjectionStream

export const transcriptWindowEntryBudget = 400
export const transcriptWindowByteBudget = 4 * 1024 * 1024

const entryBytes = (entry: TranscriptPage.Entry): number => new TextEncoder().encode(JSON.stringify(entry)).byteLength
const compareText = (left: string, right: string): number => {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
const cursorForEntry = (entry: TranscriptPage.Entry | undefined): TranscriptPage.PageCursor | undefined =>
  entry === undefined
    ? undefined
    : {
        createdAt: entry.turn.createdAt,
        turnId: entry.turn.id,
        orderKey: TranscriptOrdering.encodeUnitOrder(entry.unit.order),
      }

const sameCursor = (left: TranscriptPage.PageCursor | undefined, right: TranscriptPage.PageCursor | undefined) =>
  left?.createdAt === right?.createdAt && left?.turnId === right?.turnId && left?.orderKey === right?.orderKey

const boundWindow = (
  entries: ReadonlyArray<TranscriptPage.Entry>,
  edge: "oldest" | "newest",
): { readonly entries: ReadonlyArray<TranscriptPage.Entry>; readonly evicted: boolean } => {
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
  readonly resync?: boolean
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
  entries: ReadonlyArray<TranscriptPage.Entry>,
): ReadonlyArray<TranscriptPage.Entry> => {
  if (activeTurn === undefined || entries.some((entry) => entry.turn.id === activeTurn.id)) return []
  const seed = TranscriptProjection.Projection.empty(activeTurn.id, activeTurn.prompt)
  return seed.units.map((unit) => ({
    turn: activeTurn,
    unit,
    projectionRevision: seed.revision,
    projectionModelPhase: seed.modelPhase,
  }))
}

const project = (
  model: ViewState.Model,
  entries: ReadonlyArray<TranscriptPage.Entry>,
  displayCostUsd: number | undefined,
) => {
  const grouped = new Map<string, Array<TranscriptUnit.Unit>>()
  for (const entry of entries) {
    const rootTurnId = String(entry.turn.id)
    const units = grouped.get(rootTurnId)
    if (units === undefined) grouped.set(rootTurnId, [entry.unit])
    else units.push(entry.unit)
  }
  let next = model
  for (const [rootTurnId, units] of grouped) next = TranscriptPresenter.applyRootUnits(next, rootTurnId, units)
  const { costUsd: _, ...withoutCost } = next
  return displayCostUsd === undefined ? withoutCost : { ...withoutCost, costUsd: displayCostUsd }
}

const projectionEntries = (
  turn: Turn.Turn,
  projection: TranscriptProjectionModel.Projection,
): ReadonlyArray<TranscriptPage.Entry> =>
  projection.units.map((unit) => ({
    turn,
    unit,
    projectionRevision: projection.revision,
    projectionModelPhase: projection.modelPhase,
    ...(projection.costUsd === undefined ? {} : { projectionCostUsd: projection.costUsd }),
  }))

const displayedEntries = (
  entries: ReadonlyArray<TranscriptPage.Entry>,
  replayTurns: ReadonlyMap<string, Turn.Turn>,
  liveProjections: ReadonlyMap<string, TranscriptProjectionModel.Projection>,
  projectionStreams: ReadonlyMap<string, ProjectionStream> | undefined,
  activeTurnId: string | undefined,
) => {
  let displayed = entries
  const streamed = new Set<string>()
  for (const [rootTurnId, stream] of projectionStreams ?? []) {
    if (stream._tag === "Stopped") continue
    const turn = replayTurns.get(rootTurnId)
    if (turn === undefined) continue
    streamed.add(rootTurnId)
    displayed = [
      ...displayed.filter((entry) => String(entry.turn.id) !== rootTurnId),
      ...projectionEntries(turn, projectionFromStream(stream)),
    ]
  }
  if (activeTurnId !== undefined && !streamed.has(activeTurnId)) {
    const turn = replayTurns.get(activeTurnId)
    const projection = liveProjections.get(activeTurnId)
    if (turn !== undefined && projection !== undefined)
      displayed = [
        ...displayed.filter((entry) => String(entry.turn.id) !== activeTurnId),
        ...projectionEntries(turn, projection),
      ]
  }
  return displayed === entries ? entries : normalizeEntries(displayed)
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
    if (block._tag === "ToolCall") {
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
  entries: ReadonlyArray<TranscriptPage.Entry>,
): ReadonlyMap<string, TranscriptProjectionModel.Projection> => {
  const grouped = new Map<string, Array<TranscriptPage.Entry>>()
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
  entries: ReadonlyArray<TranscriptPage.Entry>,
  turnId: string,
  prompt: string,
): TranscriptProjectionModel.Projection =>
  projections(entries).get(turnId) ?? TranscriptProjection.Projection.empty(turnId, prompt)

const sourceText = (event: TranscriptSourceEvent.SourceEvent): string => {
  if (typeof event.text === "string") return event.text
  const delta = event.data?.delta
  return typeof delta === "string" ? delta : ""
}

const sourceBlockId = (event: TranscriptSourceEvent.SourceEvent, fallback: string): string => {
  const id = event.data?.tool_call_id ?? event.data?.call_id ?? event.data?.id
  return typeof id === "string" ? id : fallback
}

const activityAfter = (
  activity: ViewState.Activity | undefined,
  event: TranscriptSourceEvent.SourceEvent,
  projection: TranscriptProjectionModel.Projection,
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
    event.type === "model.output.completed"
  )
    return running ? runningActivity : { _tag: "Waiting" }
  if (
    event.type === "execution.completed" ||
    event.type === "execution.failed" ||
    event.type === "execution.cancelled"
  ) {
    if (running) return runningActivity
    return model.busy ? { _tag: "Waiting" } : undefined
  }
  return running ? runningActivity : activity
}

const activityAfterOrigin = (
  activity: ViewState.Activity | undefined,
  origin: Extract<Operation.InteractiveEvent, { readonly _tag: "TranscriptProjectionPatched" }>["origin"],
  state: OpenProjectionStream["state"],
  model: ViewState.Model,
): ViewState.Activity | undefined => {
  if (origin._tag === "Discovery") return ViewState.runningToolsActivity(model)
  if (origin._tag === "RecordedShell") return activity
  return activityAfter(
    activity,
    {
      cursor: origin.cursor,
      sequence: origin.sequence,
      type: origin.type,
      createdAt: origin.createdAt,
      ...(origin.text === undefined ? {} : { text: origin.text }),
    },
    {
      units: [],
      revision: state.revision,
      modelPhase: state.modelPhase,
      ...(state.usableCompletionSequence === undefined
        ? {}
        : { usableCompletionSequence: state.usableCompletionSequence }),
    },
    model,
  )
}

const projectionFromStream = (
  stream: OpenProjectionStream | FailedProjectionStream,
): TranscriptProjectionModel.Projection => ({
  units: HashMap.toValues(stream.units).toSorted((left, right) =>
    TranscriptOrdering.compareUnitOrder(left.order, right.order),
  ),
  revision: stream.state.revision,
  modelPhase: stream.state.modelPhase,
  ...(stream.state.usableCompletionSequence === undefined
    ? {}
    : { usableCompletionSequence: stream.state.usableCompletionSequence }),
})

const normalizeEntries = (entries: ReadonlyArray<TranscriptPage.Entry>): ReadonlyArray<TranscriptPage.Entry> => {
  const unique = new Map<string, TranscriptPage.Entry>()
  for (const entry of entries) {
    const current = unique.get(entry.unit.key)
    if (current === undefined || entry.projectionRevision >= current.projectionRevision)
      unique.set(entry.unit.key, entry)
  }
  return [...unique.values()].toSorted(
    (left, right) =>
      left.turn.createdAt - right.turn.createdAt ||
      compareText(left.turn.id, right.turn.id) ||
      TranscriptOrdering.compareUnitOrder(left.unit.order, right.unit.order),
  )
}

const revisionsForWindow = (
  entries: ReadonlyArray<TranscriptPage.Entry>,
  activeTurnId: string | undefined,
  current: ReadonlyMap<string, number>,
  projectionStreams: ReadonlyMap<string, ProjectionStream> | undefined,
): ReadonlyMap<string, number> => {
  const revisions = new Map<string, number>(entries.map((entry) => [entry.turn.id, entry.projectionRevision] as const))
  if (activeTurnId !== undefined) {
    const activeRevision = current.get(activeTurnId)
    if (activeRevision !== undefined) revisions.set(activeTurnId, activeRevision)
  }
  for (const [rootTurnId, stream] of projectionStreams ?? [])
    if (stream._tag !== "Stopped") revisions.set(rootTurnId, stream.state.revision)
  return revisions
}

const projectedRootIds = (projectionStreams: ReadonlyMap<string, ProjectionStream> | undefined): ReadonlySet<string> =>
  new Set(
    [...(projectionStreams ?? [])].flatMap(([rootTurnId, stream]) => (stream._tag === "Stopped" ? [] : [rootTurnId])),
  )

const replayTurnsForWindow = (
  entries: ReadonlyArray<TranscriptPage.Entry>,
  previous: ReadonlyMap<string, Turn.Turn>,
  projectionStreams: ReadonlyMap<string, ProjectionStream> | undefined,
  activeTurnId: string | undefined,
): ReadonlyMap<string, Turn.Turn> => {
  const retained = new Set(projectedRootIds(projectionStreams))
  if (activeTurnId !== undefined) retained.add(activeTurnId)
  return new Map([
    ...entries.map((entry) => [entry.turn.id, entry.turn] as const),
    ...[...previous].filter(([turnId]) => retained.has(turnId)),
  ])
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
    const availableUsageCost = event.cost._tag === "Available" ? event.cost : state.lastAvailableUsageCost
    const threadCostUsd =
      availableUsageCost?._tag === "Available" ? availableUsageCost.usd : (state.threadCostUsd ?? state.model.costUsd)
    const usageCost = availableUsageCost ?? event.cost
    const lastAvailableUsageCost = event.cost._tag === "Available" ? event.cost : state.lastAvailableUsageCost
    const { costUsd: _, ...withoutCost } = state.model
    return {
      state: {
        ...state,
        usageRevision: event.revision,
        ...(threadCostUsd === undefined ? {} : { threadCostUsd }),
        ...(lastAvailableUsageCost === undefined ? {} : { lastAvailableUsageCost }),
        model: {
          ...withoutCost,
          usageCost,
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
    const sameThread = state.model.currentThreadId === event.thread.id
    const preservedUsageCost = sameThread
      ? (state.lastAvailableUsageCost ??
        (state.model.usageCost?._tag === "Available" ? state.model.usageCost : undefined))
      : undefined
    const model = cleared({
      ...state.model,
      ...(preservedUsageCost === undefined
        ? {
            usageCost: { _tag: "Loading" as const },
            usageTokens: { _tag: "Loading" as const },
            usageTime: { _tag: "Loading" as const },
          }
        : { usageCost: preservedUsageCost }),
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
    const selectedCostUsd =
      event.threadCostUsd ?? (sameThread ? (state.threadCostUsd ?? preservedUsageCost?.usd) : undefined)
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
      displayedEntries(selected, replayTurns, liveProjections, undefined, activeTurn?.id),
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
          ...(preservedUsageCost === undefined ? {} : { lastAvailableUsageCost: preservedUsageCost }),
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
    if (event.selectionEpoch !== state.selectionEpoch) return { state, preserveAnchor: false }
    if (state.model.currentThreadId !== event.threadId) return { state, preserveAnchor: false }
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
      return { state, preserveAnchor: false }
    if (!sameCursor(event.requestedAfter, state.newestCursor)) return { state, preserveAnchor: false }
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
      return { state, preserveAnchor: false }
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
      return { state, preserveAnchor: false }
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
    let model = TranscriptPresenter.applyTurnDelta(state.model, rootTurnId, event.delta)
    model = {
      ...model,
      activity: activityAfterOrigin(state.model.activity, event.origin, event.state, model),
    }
    if (
      event.origin._tag === "Event" &&
      event.origin.type === "steering.delivered" &&
      event.origin.steeringSequences !== undefined
    )
      model = ViewState.update(model, {
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
    if (event.selectionEpoch !== state.selectionEpoch || state.model.currentThreadId !== event.threadId)
      return { state, preserveAnchor: false }
    const rootTurnId = String(event.rootTurnId)
    const current = state.projectionStreams?.get(rootTurnId)
    if (
      current === undefined ||
      current._tag !== "Open" ||
      current.streamId !== event.streamId ||
      current.patchRevision !== event.patchRevision ||
      current.rootStatus !== event.status
    )
      return { state, preserveAnchor: false, resync: true }
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
    const active = state.model.activeTurnId === rootTurnId
    const activeTurnId = active ? undefined : state.model.activeTurnId
    const knownTurns = new Map([...state.replayTurns, [rootTurnId, terminalTurn] as const])
    const replayTurns = replayTurnsForWindow(bounded.entries, knownTurns, projectionStreams, activeTurnId)
    const liveProjections = new Map(state.liveProjections)
    liveProjections.delete(rootTurnId)
    const baseModel = active
      ? { ...state.model, activeTurnId: undefined, busy: false, activity: undefined }
      : state.model
    const model = project(
      cleared(baseModel),
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
      return { state, preserveAnchor: false }
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
    return { state, preserveAnchor: false }
  return { state, preserveAnchor: false }
}

export const update: {
  (event: TranscriptEvent): (state: State) => Update
  (state: State, event: TranscriptEvent): Update
} = Function.dual(2, updateState)

export const makeFeedFrameBatcher = <Event>(options: {
  readonly schedule: (flush: () => void) => void
  readonly apply: (events: ReadonlyArray<Event>) => void
  readonly render: () => void
}) => {
  type BatchState = { readonly _tag: "Idle" } | { readonly _tag: "Scheduled" }
  const pending: Array<Event> = []
  let state: BatchState = { _tag: "Idle" }
  const schedule = (flush: () => void) => {
    state = { _tag: "Scheduled" }
    options.schedule(flush)
  }
  const flush = () => {
    state = { _tag: "Idle" }
    if (pending.length === 0) return
    const events = pending.splice(0, 256)
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
