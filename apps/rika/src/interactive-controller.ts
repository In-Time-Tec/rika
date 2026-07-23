import type * as Operation from "@rika/app/operation"
import type * as TranscriptRepository from "@rika/persistence/transcript-repository"
import type * as Turn from "@rika/persistence/turn"
import * as Transcript from "@rika/transcript"
import { TranscriptPresenter, ViewState } from "@rika/tui"
import { Effect, Function } from "effect"

type TranscriptEvent = Extract<
  Operation.InteractiveEvent,
  | { readonly _tag: "SelectionLoaded" }
  | { readonly _tag: "TranscriptPagePrepended" }
  | { readonly _tag: "TranscriptPatched" }
  | { readonly _tag: "TranscriptResyncRequired" }
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
  readonly projections: ReadonlyMap<string, Transcript.Projection>
  readonly threadCostUsd?: number
  readonly attachedChildRevisions?: ReadonlyMap<string, number>
}

export interface Update {
  readonly state: State
  readonly preserveAnchor: boolean
  readonly unattached?: ReadonlyArray<string>
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

const sourceText = (event: Transcript.SourceEvent): string => {
  if (typeof event.text === "string") return event.text
  const delta = event.data?.delta
  return typeof delta === "string" ? delta : ""
}

const sourceBlockId = (event: Transcript.SourceEvent, fallback: string): string => {
  const id = event.data?.tool_call_id ?? event.data?.call_id ?? event.data?.id
  return typeof id === "string" ? id : fallback
}

const hasRunningTools = (projection: Transcript.Projection) =>
  projection.units.some(
    (unit) =>
      unit.content._tag === "Block" &&
      unit.content.block._tag === "ToolCall" &&
      unit.content.block.status === "running",
  )

const activityAfter = (
  activity: ViewState.Activity | undefined,
  event: Transcript.SourceEvent,
  projection: Transcript.Projection,
): ViewState.Activity | undefined => {
  if (event.type.includes("reasoning"))
    return ViewState.streamActivity(activity, "Thinking", sourceText(event), `reasoning:${projection.modelPhase}`)
  if (event.type === "model.output.delta")
    return ViewState.streamActivity(activity, "Streaming", sourceText(event), `answer:${projection.modelPhase}`)
  if (event.type === "model.toolcall.delta")
    return ViewState.streamActivity(activity, "Streaming", sourceText(event), sourceBlockId(event, "tool"))
  if (event.type === "tool.call.requested" || event.type === "tool.call.executing" || event.type === "tool.started")
    return { _tag: "RunningTools" }
  if (event.type === "tool.result.received")
    return hasRunningTools(projection) ? { _tag: "RunningTools" } : { _tag: "Waiting" }
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
    return { _tag: "Waiting" }
  if (event.type === "execution.completed" || event.type === "execution.failed" || event.type === "execution.cancelled")
    return undefined
  return activity
}

const prependProjection = (
  model: ViewState.Model,
  entries: ReadonlyArray<TranscriptRepository.Entry>,
  displayCostUsd: number | undefined,
): ViewState.Model => {
  const { costUsd: _, ...withoutCost } = model
  const older = project(
    cleared({
      ...(displayCostUsd === undefined ? withoutCost : { ...withoutCost, costUsd: displayCostUsd }),
      activeTurnId: undefined,
      busy: false,
      activity: undefined,
    }),
    entries,
    displayCostUsd,
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
    costUsd: displayCostUsd,
  }
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
    const model = cleared({
      ...state.model,
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
    return {
      state: {
        selectionEpoch: event.selectionEpoch,
        model: project(model, entries, event.threadCostUsd),
        replayTurns: new Map([
          ...entries.map((entry) => [entry.turn.id, entry.turn] as const),
          ...(event.activeTurn === undefined ? [] : [[event.activeTurn.id, event.activeTurn] as const]),
        ]),
        entries,
        revisions: new Map(entries.map((entry) => [entry.turn.id, entry.projectionRevision])),
        projections: projections(entries),
        ...(event.threadCostUsd === undefined ? {} : { threadCostUsd: event.threadCostUsd }),
      },
      preserveAnchor: false,
    }
  }
  if (event._tag === "TranscriptPagePrepended") {
    if (event.selectionEpoch !== state.selectionEpoch) return { state, preserveAnchor: false }
    if (state.model.currentThreadId !== event.threadId) return { state, preserveAnchor: false }
    const known = new Set(state.entries.map((entry) => entry.unit.key))
    const prepended = normalizeEntries(event.entries).filter((entry) => !known.has(entry.unit.key))
    const entries = [...prepended, ...state.entries]
    const revisions = new Map(state.revisions)
    for (const entry of prepended)
      revisions.set(entry.turn.id, Math.max(entry.projectionRevision, revisions.get(entry.turn.id) ?? -1))
    const { threadCostUsd: _threadCostUsd, ...stateWithoutCost } = state
    return {
      state: {
        ...stateWithoutCost,
        model: prependProjection(state.model, prepended, event.threadCostUsd),
        replayTurns: new Map([...prepended.map((entry) => [entry.turn.id, entry.turn] as const), ...state.replayTurns]),
        entries,
        revisions,
        projections: new Map([...projections(prepended), ...state.projections]),
        ...(event.threadCostUsd === undefined ? {} : { threadCostUsd: event.threadCostUsd }),
      },
      preserveAnchor: true,
    }
  }
  if (event._tag === "TranscriptPatched") {
    if (event.selectionEpoch !== state.selectionEpoch) return { state, preserveAnchor: false }
    if (state.model.currentThreadId !== undefined && state.model.currentThreadId !== event.threadId)
      return { state, preserveAnchor: false }
    const costBearing = event.event.type === "model.usage.reported" || event.event.type === "model.attempt.completed"
    const threadCostUsd = costBearing ? event.threadCostUsd : state.threadCostUsd
    const { threadCostUsd: _threadCostUsd, ...stateWithoutCost } = state
    if (event.revision <= (state.revisions.get(event.turnId) ?? -1)) {
      if (!costBearing) return { state, preserveAnchor: false }
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
    const turn = state.replayTurns.get(event.turnId)
    if (turn === undefined) {
      const previous = state.projections.get(event.turnId) ?? Transcript.empty(event.turnId, "")
      const next = Transcript.applyEvent(previous, event.event)
      const childProjections = new Map([...state.projections, [event.turnId, next]] as const)
      const rootTurnId = event.rootTurnId
      const rootProjection = rootTurnId === undefined ? undefined : childProjections.get(rootTurnId)
      if (rootTurnId !== undefined && rootProjection !== undefined && event.rootTurnCostUsd !== undefined)
        childProjections.set(rootTurnId, { ...rootProjection, costUsd: event.rootTurnCostUsd })
      const childTerminal =
        event.event.type === "execution.completed" ||
        event.event.type === "execution.failed" ||
        event.event.type === "execution.cancelled"
      const attached = TranscriptPresenter.attachChildProjections(
        state.model,
        state.replayTurns,
        childProjections,
        childTerminal
          ? TranscriptPresenter.emptyAttachments
          : (state.attachedChildRevisions ?? TranscriptPresenter.emptyAttachments),
      )
      const { costUsd: _costUsd, ...modelWithoutCost } = attached.model
      return {
        state: {
          ...stateWithoutCost,
          model: threadCostUsd === undefined ? modelWithoutCost : { ...modelWithoutCost, costUsd: threadCostUsd },
          revisions: new Map([...state.revisions, [event.turnId, event.revision]]),
          projections: childProjections,
          ...(threadCostUsd === undefined ? {} : { threadCostUsd }),
          attachedChildRevisions: attached.attachments,
        },
        preserveAnchor: false,
        unattached: attached.unattached,
      }
    }
    const previous = state.projections.get(event.turnId) ?? Transcript.empty(event.turnId, turn.prompt)
    const projected = Transcript.applyEvent(previous, event.event)
    const next =
      event.rootTurnId === event.turnId && event.rootTurnCostUsd !== undefined
        ? { ...projected, costUsd: event.rootTurnCostUsd }
        : projected
    const nextProjections = new Map([...state.projections, [event.turnId, next]] as const)
    const terminal =
      event.event.type === "execution.completed" ||
      event.event.type === "execution.failed" ||
      event.event.type === "execution.cancelled"
    const attached = TranscriptPresenter.attachChildProjections(
      TranscriptPresenter.applyTurnUnits(state.model, next.units),
      state.replayTurns,
      nextProjections,
      terminal
        ? TranscriptPresenter.emptyAttachments
        : (state.attachedChildRevisions ?? TranscriptPresenter.emptyAttachments),
    )
    const projectedModel = {
      ...attached.model,
      activity: activityAfter(state.model.activity, event.event, next),
    }
    let terminalStatus: "completed" | "failed" | "cancelled" | undefined
    if (event.event.type === "execution.completed") terminalStatus = "completed"
    else if (event.event.type === "execution.failed") terminalStatus = "failed"
    else if (event.event.type === "execution.cancelled") terminalStatus = "cancelled"
    const model = terminal
      ? { ...projectedModel, activeTurnId: undefined, busy: false, activity: undefined }
      : projectedModel
    const { costUsd: _costUsd, ...modelWithoutCost } = model
    const known = new Map(state.entries.map((entry, index) => [entry.unit.key, index] as const))
    const entries = [...state.entries]
    for (const unit of next.units) {
      const entry: TranscriptRepository.Entry = {
        turn,
        unit,
        projectionRevision: next.revision,
        projectionModelPhase: next.modelPhase,
        ...(next.costUsd === undefined ? {} : { projectionCostUsd: next.costUsd }),
      }
      const index = known.get(unit.key)
      if (index === undefined) {
        known.set(unit.key, entries.length)
        entries.push(entry)
      } else entries[index] = entry
    }
    return {
      state: {
        ...stateWithoutCost,
        model: threadCostUsd === undefined ? modelWithoutCost : { ...modelWithoutCost, costUsd: threadCostUsd },
        replayTurns:
          terminalStatus === undefined
            ? state.replayTurns
            : new Map([...state.replayTurns, [event.turnId, { ...turn, status: terminalStatus }]]),
        entries,
        revisions: new Map([...state.revisions, [event.turnId, event.revision]]),
        projections: nextProjections,
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

export const makeFeedFrameBatcher = <Event>(options: {
  readonly schedule: (flush: () => void) => void
  readonly apply: (events: ReadonlyArray<Event>) => void
  readonly render: () => void
  readonly lane?: (event: Event) => string | undefined
  readonly boundary?: (event: Event) => boolean
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
    const isBoundary = options.boundary
    if (pending.length <= 256 || laneOf === undefined || isBoundary === undefined) return pending.splice(0, 256)
    const boundaryIndex = pending.findIndex((event, index) => {
      if (index < 256 || !isBoundary(event)) return false
      const lane = laneOf(event)
      return lane !== undefined
    })
    if (boundaryIndex < 0) return pending.splice(0, 256)
    const boundaryLane = laneOf(pending[boundaryIndex]!)
    if (boundaryLane === undefined) return pending.splice(0, 256)
    let prefixCount = 255
    let promotedIndexes: ReadonlyArray<number> = [boundaryIndex]
    while (true) {
      const required = pending
        .map((event, index) => ({ event, index }))
        .filter(({ event, index }) => index >= prefixCount && index <= boundaryIndex && laneOf(event) === boundaryLane)
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
