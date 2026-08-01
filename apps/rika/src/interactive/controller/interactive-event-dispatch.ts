import * as InteractiveEvent from "@rika/product/interactive-event"
import * as TranscriptPage from "@rika/product/transcript-page"
import * as Turn from "@rika/product/turn-record"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptProjectionModel from "@rika/transcript/transcript-projection-model"
import * as TranscriptSourceEvent from "@rika/transcript/transcript-source-event"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { HashMap } from "effect"
import type { Model } from "@rika/terminal/terminal-state"
import type { Activity } from "@rika/terminal/terminal-message"
import { runningToolsActivity, streamActivity } from "@rika/terminal/terminal-message"
import type { TranscriptBlock, TranscriptItem } from "@rika/terminal/terminal-message"
import { applyRootUnits } from "@rika/terminal/terminal-transcript-presentation"
import type { ProjectionStream } from "./interactive-controller"

interface OpenProjectionStream {
  readonly _tag: "Open"
  readonly streamId: string
  readonly patchRevision: number
  readonly state: { readonly revision: number; readonly modelPhase: number; readonly usableCompletionSequence?: number }
  readonly units: HashMap.HashMap<string, TranscriptUnit.Unit>
  readonly rootStatus?: "completed" | "failed" | "cancelled"
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
const compareText = (left: string, right: string): number => {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
const entryBytes = (entry: TranscriptPage.Entry): number => new TextEncoder().encode(JSON.stringify(entry)).byteLength
export const cursorForEntry = (entry: TranscriptPage.Entry | undefined): TranscriptPage.PageCursor | undefined =>
  entry === undefined
    ? undefined
    : {
        createdAt: entry.turn.createdAt,
        turnId: entry.turn.id,
        orderKey: TranscriptOrdering.encodeUnitOrder(entry.unit.order),
      }
export const sameCursor = (left: TranscriptPage.PageCursor | undefined, right: TranscriptPage.PageCursor | undefined) =>
  left?.createdAt === right?.createdAt && left?.turnId === right?.turnId && left?.orderKey === right?.orderKey
export const boundWindow = (entries: ReadonlyArray<TranscriptPage.Entry>, edge: "oldest" | "newest") => {
  const retained = [...entries]
  let bytes = retained.reduce((total, entry) => total + entryBytes(entry), 0)
  let evicted = false
  while (retained.length > 400 || bytes > 4 * 1024 * 1024) {
    const index = edge === "oldest" ? 0 : retained.length - 1
    bytes -= entryBytes(retained[index]!)
    retained.splice(index, 1)
    evicted = true
  }
  return { entries: retained, evicted }
}

export const cleared = (model: Model): Model => ({
  ...model,
  entries: [],
  blocks: [],
  items: [],
  seenEventIds: [],
  seenExecutionEventKeys: [],
  childExecutionOutcomes: {},
  eventCursor: undefined,
})

export const retaining = (model: Model, previous: Model): Model => ({
  ...model,
  entries: previous.entries,
  blocks: previous.blocks,
  items: previous.items,
  seenEventIds: previous.seenEventIds,
  seenExecutionEventKeys: previous.seenExecutionEventKeys,
  childExecutionOutcomes: previous.childExecutionOutcomes,
  eventCursor: previous.eventCursor,
})

export const activeSeedEntries = (
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

export const project = (
  model: Model,
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
  for (const [rootTurnId, units] of grouped) next = applyRootUnits(next, rootTurnId, units)
  const { costUsd: _, ...withoutCost } = next
  return displayCostUsd === undefined ? withoutCost : { ...withoutCost, costUsd: displayCostUsd }
}

export const projectionEntries = (
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

export const displayedEntries = (
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

export const reconcileTranscriptBlocks = (model: Model): Model => {
  const blocks: Array<TranscriptBlock> = []
  const items: Array<TranscriptItem> = []
  const mutableBlocks = new Map<string, number>()
  for (const item of model.items as ReadonlyArray<TranscriptItem>) {
    if (item._tag === "Entry") {
      items.push(item)
      continue
    }
    const block = model.blocks[item.index] as TranscriptBlock | undefined
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
        blocks[index] = { ...current, ...block } as TranscriptBlock
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

export const projectionFromEntries = (
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
  activity: Activity | undefined,
  event: TranscriptSourceEvent.SourceEvent,
  projection: TranscriptProjectionModel.Projection,
  model: Model,
): Activity | undefined => {
  const runningActivity = runningToolsActivity(model)
  const running =
    runningActivity._tag === "RunningTools" && (runningActivity.subagents ?? 0) + (runningActivity.tools ?? 0) > 0
  if (event.type.includes("reasoning"))
    return running
      ? runningActivity
      : streamActivity(activity, "Thinking", sourceText(event), `reasoning:${projection.modelPhase}`)
  if (event.type === "model.output.delta")
    return running
      ? runningActivity
      : streamActivity(activity, "Streaming", sourceText(event), `answer:${projection.modelPhase}`)
  if (event.type === "model.toolcall.delta")
    return running
      ? runningActivity
      : streamActivity(activity, "Streaming", sourceText(event), sourceBlockId(event, "tool"))
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

export const activityAfterOrigin = (
  activity: Activity | undefined,
  origin: Extract<InteractiveEvent.InteractiveEvent, { readonly _tag: "TranscriptProjectionPatched" }>["origin"],
  state: OpenProjectionStream["state"],
  model: Model,
): Activity | undefined => {
  if (origin._tag === "Discovery") return runningToolsActivity(model)
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

export const projectionFromStream = (
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

export const normalizeEntries = (entries: ReadonlyArray<TranscriptPage.Entry>): ReadonlyArray<TranscriptPage.Entry> => {
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

export const revisionsForWindow = (
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

export const projectedRootIds = (
  projectionStreams: ReadonlyMap<string, ProjectionStream> | undefined,
): ReadonlySet<string> =>
  new Set(
    [...(projectionStreams ?? [])].flatMap(([rootTurnId, stream]) => (stream._tag === "Stopped" ? [] : [rootTurnId])),
  )

export const replayTurnsForWindow = (
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
