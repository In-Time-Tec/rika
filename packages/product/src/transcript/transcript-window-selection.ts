import type { Unit } from "@rika/transcript/transcript-unit"

export type TranscriptWindowFocus = "oldest" | "newest"

export interface TranscriptWindowSelection<A> {
  readonly values: ReadonlyArray<A>
  readonly truncated: boolean
  readonly contiguousStart: A | undefined
  readonly contiguousEnd: A | undefined
}

/** @experimental The block identity a parented unit hangs from, when it hangs from one. */
export const transcriptParentBlockId = (unit: Unit): string | undefined => {
  if (unit.content._tag !== "Block") return undefined
  const block = unit.content.block
  return block._tag === "ToolCall" || block._tag === "SubagentCard" ? block.id : undefined
}

const parentIndexes = (units: ReadonlyArray<Unit>): Map<string, number> => {
  const parents = new Map<string, number>()
  for (const [index, unit] of units.entries()) {
    const parentId = transcriptParentBlockId(unit)
    if (parentId !== undefined && !parents.has(parentId)) parents.set(parentId, index)
  }
  return parents
}

/**
 * Ancestors of one unit that are not already selected, oldest first. Undefined when the
 * unit's parent chain leaves the values (an orphan the window must not materialize).
 */
const missingLineage = (
  start: number,
  units: ReadonlyArray<Unit>,
  parents: Map<string, number>,
  selected: ReadonlySet<number>,
): ReadonlyArray<number> | undefined => {
  const indexes: Array<number> = []
  const visited = new Set<number>()
  let current: number | undefined = start
  while (current !== undefined && !selected.has(current)) {
    if (visited.has(current)) return undefined
    visited.add(current)
    indexes.push(current)
    const parentId = units[current]?.parentId
    if (parentId === undefined) break
    current = parents.get(parentId)
    if (current === undefined) return undefined
  }
  return indexes
}

/**
 * @experimental Select at most `maximum` values as an ancestry-closed window.
 *
 * The window is anchored on the chosen edge and filled toward the other edge. Retained values
 * (semantic roots such as the user prompt) never count against the budget and always stay.
 * Every selected parented unit keeps its parent block, and units whose parent is outside the
 * values are never selected, so a rendered window can never show a child without its card.
 */
export const selectTranscriptWindow = <A>(input: {
  readonly values: ReadonlyArray<A>
  readonly unit: (value: A) => Unit
  readonly maximum: number
  readonly focus: TranscriptWindowFocus
  readonly retain?: (value: A) => boolean
}): TranscriptWindowSelection<A> => {
  const maximum = Math.max(0, Math.floor(input.maximum))
  const units = input.values.map(input.unit)
  const parents = parentIndexes(units)
  const selected = new Set<number>()
  for (const [index, value] of input.values.entries()) {
    if (input.retain?.(value) !== true) continue
    const lineage = missingLineage(index, units, parents, selected)
    if (lineage !== undefined) for (const value of lineage) selected.add(value)
  }
  if (maximum > 0) {
    let budget = maximum
    const preferred =
      input.focus === "newest"
        ? Array.from({ length: units.length }, (_, index) => units.length - index - 1)
        : Array.from({ length: units.length }, (_, index) => index)
    const considered = new Set<number>()
    for (const index of preferred) {
      if (considered.has(index) || selected.has(index)) continue
      considered.add(index)
      const lineage = missingLineage(index, units, parents, selected)
      if (lineage === undefined || lineage.length > budget) continue
      for (const value of lineage) selected.add(value)
      budget -= lineage.length
    }
  }
  const values = input.values.filter((_, index) => selected.has(index))
  let contiguousFirst = units.length
  let contiguousLast = -1
  if (input.focus === "newest") {
    contiguousFirst = units.length
    while (contiguousFirst > 0 && selected.has(contiguousFirst - 1)) contiguousFirst -= 1
  } else {
    contiguousLast = -1
    while (contiguousLast + 1 < units.length && selected.has(contiguousLast + 1)) contiguousLast += 1
  }
  return {
    values,
    truncated: selected.size < units.length,
    contiguousStart:
      input.focus === "newest"
        ? contiguousFirst < units.length
          ? input.values[contiguousFirst]
          : undefined
        : selected.has(0)
          ? input.values[0]
          : undefined,
    contiguousEnd:
      input.focus === "oldest"
        ? contiguousLast >= 0
          ? input.values[contiguousLast]
          : undefined
        : selected.has(units.length - 1)
          ? input.values.at(-1)
          : undefined,
  }
}
