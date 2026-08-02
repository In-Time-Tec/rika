import * as TranscriptPage from "@rika/product/transcript-page"
import * as Turn from "@rika/product/turn-record"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptProjectionModel from "@rika/transcript/transcript-projection-model"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import type { Model } from "@rika/terminal/terminal-state"
import type { TranscriptBlock, TranscriptItem } from "@rika/terminal/terminal-message"
import { applyRootUnits } from "@rika/terminal/terminal-transcript-presentation"
import { Function } from "effect"
import type { ProjectionStream } from "./interactive-controller"
import { normalizeEntries, projectionFromStream } from "./interactive-transcript-window"

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

const retainingImpl = (model: Model, previous: Model): Model => ({
  ...model,
  entries: previous.entries,
  blocks: previous.blocks,
  items: previous.items,
  seenEventIds: previous.seenEventIds,
  seenExecutionEventKeys: previous.seenExecutionEventKeys,
  childExecutionOutcomes: previous.childExecutionOutcomes,
  eventCursor: previous.eventCursor,
})

export const retaining: {
  (previous: Model): (model: Model) => Model
  (model: Model, previous: Model): Model
} = Function.dual(2, retainingImpl)

const activeSeedEntriesImpl = (
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

export const activeSeedEntries: {
  (
    entries: ReadonlyArray<TranscriptPage.Entry>,
  ): (activeTurn: Turn.Turn | undefined) => ReadonlyArray<TranscriptPage.Entry>
  (activeTurn: Turn.Turn | undefined, entries: ReadonlyArray<TranscriptPage.Entry>): ReadonlyArray<TranscriptPage.Entry>
} = Function.dual(2, activeSeedEntriesImpl)

const projectImpl = (
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

export const project: {
  (
    entries: ReadonlyArray<TranscriptPage.Entry>,
    displayCostUsd: number | undefined,
  ): (model: Model) => ReturnType<typeof projectImpl>
  (
    model: Model,
    entries: ReadonlyArray<TranscriptPage.Entry>,
    displayCostUsd: number | undefined,
  ): ReturnType<typeof projectImpl>
} = Function.dual(3, projectImpl)

const projectionEntriesImpl = (
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

export const projectionEntries: {
  (projection: TranscriptProjectionModel.Projection): (turn: Turn.Turn) => ReadonlyArray<TranscriptPage.Entry>
  (turn: Turn.Turn, projection: TranscriptProjectionModel.Projection): ReadonlyArray<TranscriptPage.Entry>
} = Function.dual(2, projectionEntriesImpl)

const displayedEntriesImpl = (
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

export const displayedEntries: {
  (
    replayTurns: ReadonlyMap<string, Turn.Turn>,
    liveProjections: ReadonlyMap<string, TranscriptProjectionModel.Projection>,
    projectionStreams: ReadonlyMap<string, ProjectionStream> | undefined,
    activeTurnId: string | undefined,
  ): (entries: ReadonlyArray<TranscriptPage.Entry>) => ReturnType<typeof displayedEntriesImpl>
  (
    entries: ReadonlyArray<TranscriptPage.Entry>,
    replayTurns: ReadonlyMap<string, Turn.Turn>,
    liveProjections: ReadonlyMap<string, TranscriptProjectionModel.Projection>,
    projectionStreams: ReadonlyMap<string, ProjectionStream> | undefined,
    activeTurnId: string | undefined,
  ): ReturnType<typeof displayedEntriesImpl>
} = Function.dual(5, displayedEntriesImpl)

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

const projectionFromEntriesImpl = (
  entries: ReadonlyArray<TranscriptPage.Entry>,
  turnId: string,
  prompt: string,
): TranscriptProjectionModel.Projection =>
  projections(entries).get(turnId) ?? TranscriptProjection.Projection.empty(turnId, prompt)

export const projectionFromEntries: {
  (
    turnId: string,
    prompt: string,
  ): (entries: ReadonlyArray<TranscriptPage.Entry>) => TranscriptProjectionModel.Projection
  (entries: ReadonlyArray<TranscriptPage.Entry>, turnId: string, prompt: string): TranscriptProjectionModel.Projection
} = Function.dual(3, projectionFromEntriesImpl)
