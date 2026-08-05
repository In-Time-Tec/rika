import { Function } from "effect"
import { executionKey } from "../ordering/child-parent-correlation"
import type { Block, Content } from "../schema/transcript-presentation-model"
import type { Projection, ProjectionState } from "../schema/transcript-projection-model"
import type { SourceEvent } from "../schema/transcript-source-event"
import type { Unit } from "../schema/transcript-unit"
import { identityKey } from "../ordering/transcript-unit-identity"
import { compareUnitOrder, encodeUnitOrder, hasIntrinsicOrder, unitOrder } from "../ordering/transcript-unit-order"

declare const ProjectionFoldType: unique symbol

interface ProjectionFold {
  readonly [ProjectionFoldType]: typeof ProjectionFoldType
}

export interface UnitDelta {
  readonly upsert: ReadonlyArray<Unit>
  readonly remove: ReadonlyArray<string>
}

interface FoldMutation {
  readonly stateChanged: boolean
  readonly units: UnitDelta
}

interface ProjectionFoldObserver {
  readonly unitEnumerated?: (unit: Unit) => void
  readonly unitIndexed?: (unit: Unit) => void
  readonly unitLookup?: (key: string) => void
  readonly runningUnitVisited?: (unit: Unit) => void
  readonly fullUnitEnumeration?: () => void
}

interface ProjectionFoldOptions {
  readonly observer?: ProjectionFoldObserver
}

interface MutableProjectionState {
  revision: number
  modelPhase: number
  usableCompletionSequence: number | undefined
  oldestCursor: string | undefined
  checkpointCursor: string | undefined
  costUsd: number | undefined
  pricingVersion: string | undefined
}

interface ChildOutcome {
  readonly childId: string
  readonly outcome: NonNullable<Unit["executionOutcome"]>
}

interface OwnedFold {
  readonly turnId: string
  readonly state: MutableProjectionState
  readonly units: Map<string, Unit>
  readonly toolsById: Map<string, string>
  readonly toolsByChild: Map<string, Set<string>>
  readonly toolsByProcess: Map<string, Set<string>>
  readonly childUnitsById: Map<string, Set<string>>
  readonly runningUnits: Set<string>
  readonly assistantUnits: Set<string>
  readonly assistantUnitsByRevision: Map<number, Set<string>>
  readonly rootToolUnits: Set<string>
  readonly rootUserUnits: Set<string>
  readonly outcomeUnits: Set<string>
  readonly childOutcomes: Map<string, ChildOutcome>
  readonly usageCursorSet: Set<string>
  readonly usageCursorList: Array<string>
  readonly transientIndexes: Map<string, number>
  readonly transientBases: Map<string, Unit | undefined>
  readonly transientAttemptsByUnit: Map<string, Set<string>>
  readonly transientUnitsByAttempt: Map<string, Set<string>>
  latestRootToolKey: string | undefined
  readonly observer: ProjectionFoldObserver | undefined
}

interface MutableMutation {
  stateChanged: boolean
  readonly upsert: Map<string, Unit>
  readonly remove: Set<string>
}

const owned = new WeakMap<ProjectionFold, OwnedFold>()

const owner = (fold: ProjectionFold): OwnedFold => {
  const value = owned.get(fold)
  if (value === undefined) throw new TypeError("Unknown transcript projection fold")
  return value
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}

const string = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback)

const sourcePayload = (event: SourceEvent): Record<string, unknown> => event.data ?? record(event.content?.[0])

const transientEventTypes: ReadonlySet<string> = new Set([
  "model.output.delta",
  "model.reasoning.delta",
  "model.toolcall.delta",
])

const isTransientEvent = (event: SourceEvent): boolean =>
  transientEventTypes.has(event.type) && typeof event.data?.transient_index === "number"

const callPayload = (event: SourceEvent): Record<string, unknown> => {
  const value = sourcePayload(event)
  return value.type === "tool-call" ? record(value.call) : value
}

const resultPayload = (event: SourceEvent): Record<string, unknown> => {
  const value = sourcePayload(event)
  return value.type === "tool-result" ? record(value.result) : value
}

const encodeInput = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value ?? {}))

const outputText = (output: unknown): string => {
  if (typeof output === "string") return output
  const value = record(output)
  if (typeof value.text === "string") return value.text
  return JSON.stringify(output)
}

const rawToolId = (event: SourceEvent): string => {
  const value = event.type === "tool.result.received" ? resultPayload(event) : callPayload(event)
  return string(value.tool_call_id ?? value.id, event.cursor)
}

const toolKey = (turnId: string, id: string): string => identityKey("tool", turnId, id)

const makeUnit = (
  key: string,
  turnId: string,
  sequence: number,
  part: number,
  revision: number,
  content: Content,
): Unit => ({ key, turnId, order: unitOrder(key, sequence, part), revision, content })

const addIndex = <A>(index: Map<A, Set<string>>, value: A, key: string): void => {
  const keys = index.get(value)
  if (keys === undefined) index.set(value, new Set([key]))
  else keys.add(key)
}

const removeIndex = <A>(index: Map<A, Set<string>>, value: A, key: string): void => {
  const keys = index.get(value)
  if (keys === undefined) return
  keys.delete(key)
  if (keys.size === 0) index.delete(value)
}

const toolBlockFrom = (unit: Unit): Extract<Block, { _tag: "ToolCall" }> | undefined =>
  unit.content._tag === "Block" && unit.content.block._tag === "ToolCall" ? unit.content.block : undefined

const childBlockFrom = (unit: Unit): Extract<Block, { _tag: "ChildAgent" }> | undefined =>
  unit.content._tag === "Block" && unit.content.block._tag === "ChildAgent" ? unit.content.block : undefined

const compactionBlockFrom = (unit: Unit): Extract<Block, { _tag: "Compaction" }> | undefined =>
  unit.content._tag === "Block" && unit.content.block._tag === "Compaction" ? unit.content.block : undefined

const isRootUnit = (unit: Unit): boolean => unit.parentId === undefined && unit.order.length === 1

const indexUnit = (value: OwnedFold, unit: Unit): void => {
  value.observer?.unitIndexed?.(unit)
  const tool = toolBlockFrom(unit)
  if (tool !== undefined) {
    value.toolsById.set(tool.id, unit.key)
    if (tool.childId !== undefined) addIndex(value.toolsByChild, executionKey(tool.childId), unit.key)
    if (tool.process?.processId !== undefined) addIndex(value.toolsByProcess, tool.process.processId, unit.key)
    if (tool.status === "running") value.runningUnits.add(unit.key)
    if (isRootUnit(unit)) {
      value.rootToolUnits.add(unit.key)
      if (
        value.latestRootToolKey === undefined ||
        compareUnitOrder(value.units.get(value.latestRootToolKey)?.order ?? unit.order, unit.order) < 0
      )
        value.latestRootToolKey = unit.key
    }
  }
  const child = childBlockFrom(unit)
  if (child !== undefined) {
    addIndex(value.childUnitsById, executionKey(child.id), unit.key)
    if (child.status === "running") value.runningUnits.add(unit.key)
  }
  const compaction = compactionBlockFrom(unit)
  if (compaction !== undefined && compaction.status === "running") value.runningUnits.add(unit.key)
  if (unit.content._tag === "Entry" && unit.content.role === "assistant") {
    value.assistantUnits.add(unit.key)
    addIndex(value.assistantUnitsByRevision, unit.revision, unit.key)
  }
  if (
    unit.content._tag === "Entry" &&
    unit.content.role === "user" &&
    unit.parentId === undefined &&
    unit.turnId === value.turnId
  )
    value.rootUserUnits.add(unit.key)
  if (unit.executionOutcome !== undefined) value.outcomeUnits.add(unit.key)
}

const enumerateKeys = function* (value: OwnedFold, keys: Iterable<string>): Iterable<Unit> {
  for (const key of keys) {
    const unit = value.units.get(key)
    if (unit === undefined) continue
    value.observer?.unitEnumerated?.(unit)
    yield unit
  }
}

const firstIndexedUnit = (value: OwnedFold, keys: Iterable<string> | undefined): Unit | undefined => {
  if (keys === undefined) return undefined
  for (const unit of enumerateKeys(value, keys)) return unit
  return undefined
}

const recomputeLatestRootTool = (value: OwnedFold): void => {
  value.latestRootToolKey = undefined
  for (const unit of enumerateKeys(value, value.rootToolUnits)) {
    if (
      value.latestRootToolKey === undefined ||
      compareUnitOrder(value.units.get(value.latestRootToolKey)!.order, unit.order) < 0
    )
      value.latestRootToolKey = unit.key
  }
}

const unindexUnit = (value: OwnedFold, unit: Unit): void => {
  const tool = toolBlockFrom(unit)
  if (tool !== undefined) {
    if (value.toolsById.get(tool.id) === unit.key) value.toolsById.delete(tool.id)
    if (tool.childId !== undefined) removeIndex(value.toolsByChild, executionKey(tool.childId), unit.key)
    if (tool.process?.processId !== undefined) removeIndex(value.toolsByProcess, tool.process.processId, unit.key)
    value.runningUnits.delete(unit.key)
    value.rootToolUnits.delete(unit.key)
  }
  const child = childBlockFrom(unit)
  if (child !== undefined) {
    removeIndex(value.childUnitsById, executionKey(child.id), unit.key)
    value.runningUnits.delete(unit.key)
  }
  if (compactionBlockFrom(unit) !== undefined) value.runningUnits.delete(unit.key)
  if (unit.content._tag === "Entry" && unit.content.role === "assistant") {
    value.assistantUnits.delete(unit.key)
    removeIndex(value.assistantUnitsByRevision, unit.revision, unit.key)
  }
  value.rootUserUnits.delete(unit.key)
  value.outcomeUnits.delete(unit.key)
}

const mutableState = (projection: Projection): MutableProjectionState => ({
  revision: projection.revision,
  modelPhase: projection.modelPhase,
  usableCompletionSequence: projection.usableCompletionSequence,
  oldestCursor: projection.oldestCursor,
  checkpointCursor: projection.checkpointCursor,
  costUsd: projection.costUsd,
  pricingVersion: projection.pricingVersion,
})

const validateRestoredUnits = (units: ReadonlyArray<Unit>): void => {
  const keys = new Set<string>()
  const orders = new Set<string>()
  const toolIds = new Set<string>()
  let outcomeKey: string | undefined
  for (const unit of units) {
    if (!hasIntrinsicOrder(unit)) throw new RangeError(`Transcript unit ${unit.key} has a non-intrinsic order`)
    if (keys.has(unit.key)) throw new RangeError(`Transcript unit key ${unit.key} is duplicated`)
    keys.add(unit.key)
    const order = encodeUnitOrder(unit.order)
    if (orders.has(order)) throw new RangeError(`Transcript unit order ${order} is duplicated`)
    orders.add(order)
    const tool = toolBlockFrom(unit)
    if (tool !== undefined) {
      if (toolIds.has(tool.id)) throw new RangeError(`Transcript tool id ${tool.id} is duplicated`)
      toolIds.add(tool.id)
    }
    if (unit.executionOutcome !== undefined) {
      if (outcomeKey !== undefined)
        throw new RangeError(`Transcript execution outcome is duplicated by ${outcomeKey} and ${unit.key}`)
      outcomeKey = unit.key
    }
  }
}

const restoredChildOutcome = (unit: Unit): ChildOutcome | undefined => {
  const tool = toolBlockFrom(unit)
  if (
    tool?.childId !== undefined &&
    (tool.status === "complete" || tool.status === "failed" || tool.status === "cancelled")
  )
    return { childId: tool.childId, outcome: { status: tool.status } }
  const child = childBlockFrom(unit)
  return child !== undefined && child.status !== "running"
    ? { childId: child.id, outcome: { status: child.status } }
    : undefined
}

const restoreChildOutcome = (value: OwnedFold, restored: ChildOutcome): void => {
  const childKey = executionKey(restored.childId)
  const previous = value.childOutcomes.get(childKey)
  if (previous !== undefined && previous.outcome.status !== restored.outcome.status)
    throw new RangeError(`Transcript child outcome ${restored.childId} is contradictory`)
  value.childOutcomes.set(childKey, previous ?? restored)
}

const makeFold = (projection: Projection, options?: ProjectionFoldOptions): ProjectionFold => {
  validateRestoredUnits(projection.units)
  const fold = {} as ProjectionFold
  const units = new Map(projection.units.map((unit) => [unit.key, unit]))
  const value: OwnedFold = {
    turnId: projection.units.find((unit) => unit.parentId === undefined)?.turnId ?? projection.units[0]?.turnId ?? "",
    state: mutableState(projection),
    units,
    toolsById: new Map(),
    toolsByChild: new Map(),
    toolsByProcess: new Map(),
    childUnitsById: new Map(),
    runningUnits: new Set(),
    assistantUnits: new Set(),
    assistantUnitsByRevision: new Map(),
    rootToolUnits: new Set(),
    rootUserUnits: new Set(),
    outcomeUnits: new Set(),
    childOutcomes: new Map(),
    usageCursorSet: new Set(projection.usageCursors),
    usageCursorList: projection.usageCursors === undefined ? [] : [...projection.usageCursors],
    transientIndexes: new Map(),
    transientBases: new Map(),
    transientAttemptsByUnit: new Map(),
    transientUnitsByAttempt: new Map(),
    latestRootToolKey: undefined,
    observer: options?.observer,
  }
  owned.set(fold, value)
  for (const unit of units.values()) indexUnit(value, unit)
  for (const unit of units.values()) {
    const restored = restoredChildOutcome(unit)
    if (restored !== undefined) restoreChildOutcome(value, restored)
  }
  return fold
}

const makeProjectionFold: {
  (turnId: string, prompt: string, options?: ProjectionFoldOptions): ProjectionFold
  (prompt: string, options?: ProjectionFoldOptions): (turnId: string) => ProjectionFold
} = Function.dual(
  (args) => args.length >= 2,
  (turnId: string, prompt: string, options?: ProjectionFoldOptions): ProjectionFold =>
    makeFold(
      {
        units: [
          makeUnit(identityKey("turn", turnId, "user"), turnId, -1, 0, 0, {
            _tag: "Entry",
            role: "user",
            text: prompt,
          }),
        ],
        revision: -1,
        modelPhase: -1,
      },
      options,
    ),
)

const restoreProjectionFold: {
  (projection: Projection, options?: ProjectionFoldOptions): ProjectionFold
  (options?: ProjectionFoldOptions): (projection: Projection) => ProjectionFold
} = Function.dual(
  (args) => typeof args[0] === "object" && args[0] !== null && "units" in args[0],
  (projection: Projection, options?: ProjectionFoldOptions): ProjectionFold => makeFold(projection, options),
)

const snapshotFoldState = (fold: ProjectionFold): ProjectionState => {
  const value = owner(fold)
  const state = value.state
  return {
    revision: state.revision,
    modelPhase: state.modelPhase,
    ...(state.usableCompletionSequence === undefined
      ? {}
      : { usableCompletionSequence: state.usableCompletionSequence }),
    ...(state.oldestCursor === undefined ? {} : { oldestCursor: state.oldestCursor }),
    ...(state.checkpointCursor === undefined ? {} : { checkpointCursor: state.checkpointCursor }),
    ...(state.costUsd === undefined ? {} : { costUsd: state.costUsd }),
    ...(value.usageCursorList.length === 0 ? {} : { usageCursors: [...value.usageCursorList] }),
    ...(state.pricingVersion === undefined ? {} : { pricingVersion: state.pricingVersion }),
  }
}

const sortedUnits = (value: OwnedFold): Array<Unit> => {
  value.observer?.fullUnitEnumeration?.()
  const units = [...value.units.values()].toSorted((left, right) => compareUnitOrder(left.order, right.order))
  for (const unit of units) value.observer?.unitEnumerated?.(unit)
  return units
}

const snapshotFoldProjection = (fold: ProjectionFold): Projection => {
  const value = owner(fold)
  return { ...snapshotFoldState(fold), units: sortedUnits(value) }
}

const foldUnit: {
  (fold: ProjectionFold, key: string): Unit | undefined
  (key: string): (fold: ProjectionFold) => Unit | undefined
} = Function.dual(2, (fold: ProjectionFold, key: string): Unit | undefined => {
  const value = owner(fold)
  value.observer?.unitLookup?.(key)
  return value.units.get(key)
})

const foldUnits = (fold: ProjectionFold): ReadonlyArray<Unit> => sortedUnits(owner(fold))

export const foldState = {
  isTransientEvent,
  makeProjectionFold,
  restoreProjectionFold,
  owner,
  record,
  string,
  sourcePayload,
  callPayload,
  resultPayload,
  encodeInput,
  outputText,
  rawToolId,
  toolKey,
  makeUnit,
  addIndex,
  removeIndex,
  toolBlockFrom,
  childBlockFrom,
  compactionBlockFrom,
  isRootUnit,
  indexUnit,
  recomputeLatestRootTool,
  unindexUnit,
  enumerateKeys,
  firstIndexedUnit,
  snapshotFoldState,
  snapshotFoldProjection,
  foldUnit,
  foldUnits,
}
export type { ProjectionFold, FoldMutation, OwnedFold, MutableMutation, ProjectionFoldOptions }
