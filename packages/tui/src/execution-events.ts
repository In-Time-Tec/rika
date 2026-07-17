import type { Block, Unit } from "@rika/transcript"
import { Function } from "effect"

export interface Event {
  readonly turnId?: string
  readonly cursor: string
  readonly sequence: number
  readonly type: string
  readonly text?: string
  readonly content?: ReadonlyArray<unknown>
  readonly data?: Readonly<Record<string, unknown>>
}

const projectUnitsImpl = (
  model: import("./view-state").Model,
  units: ReadonlyArray<Unit>,
  parentId?: string,
): import("./view-state").Model => {
  const entries = [...model.entries]
  const blocks = [...model.blocks] as Array<Block>
  const items = [...model.items] as Array<import("./view-state").TranscriptItem>
  const known = new Map(items.flatMap((item, index) => (item.id === undefined ? [] : [[item.id, index] as const])))
  for (const unit of units) {
    if (parentId !== undefined && (unit.content._tag !== "Block" || unit.content.block._tag !== "ToolCall")) continue
    const itemIndex = known.get(unit.key)
    const current = itemIndex === undefined ? undefined : items[itemIndex]
    if (current !== undefined) {
      if (unit.content._tag === "Entry" && current._tag === "Entry")
        entries[current.index] = { ...unit.content, turnId: unit.turnId }
      else if (unit.content._tag === "Block" && current._tag === "Block") blocks[current.index] = unit.content.block
      continue
    }
    if (unit.content._tag === "Entry") {
      entries.push({ ...unit.content, turnId: unit.turnId })
      items.push({ _tag: "Entry", index: entries.length - 1, id: unit.key, turnId: unit.turnId })
    } else {
      blocks.push(unit.content.block)
      items.push({
        _tag: "Block",
        index: blocks.length - 1,
        id: unit.key,
        turnId: unit.turnId,
        ...(parentId === undefined ? {} : { parentId }),
      })
    }
    known.set(unit.key, items.length - 1)
  }
  return { ...model, entries, blocks, items }
}

export const projectUnits: {
  (model: import("./view-state").Model, units: ReadonlyArray<Unit>): import("./view-state").Model
  (units: ReadonlyArray<Unit>): (model: import("./view-state").Model) => import("./view-state").Model
} = Function.dual(2, (model: import("./view-state").Model, units: ReadonlyArray<Unit>): import("./view-state").Model =>
  projectUnitsImpl(model, units),
)

export const projectChildUnits: {
  (model: import("./view-state").Model, parentId: string, units: ReadonlyArray<Unit>): import("./view-state").Model
  (parentId: string, units: ReadonlyArray<Unit>): (model: import("./view-state").Model) => import("./view-state").Model
} = Function.dual(3, (model: import("./view-state").Model, parentId: string, units: ReadonlyArray<Unit>) =>
  projectUnitsImpl(model, units, parentId),
)
