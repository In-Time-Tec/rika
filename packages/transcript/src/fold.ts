import { Catalog } from "@rika/tools"
import { Function, Option, Schema } from "effect"
import { candidateCallId, childScopeAndCallId, executionKey, type ChildParentCandidate } from "./child-parent"
import { partialInputRecord } from "./partial-input"
import type { Block, Content, Projection, ProjectionState, SourceEvent, ToolFile, ToolProcess, Unit } from "./schema"
import { identityKey, scopedIdentity } from "./unit-identity"
import { compareUnitOrder, encodeUnitOrder, hasIntrinsicOrder, unitOrder } from "./unit-order"

declare const ProjectionFoldType: unique symbol

export interface ProjectionFold {
  readonly [ProjectionFoldType]: typeof ProjectionFoldType
}

export interface UnitDelta {
  readonly upsert: ReadonlyArray<Unit>
  readonly remove: ReadonlyArray<string>
}

export interface FoldMutation {
  readonly stateChanged: boolean
  readonly units: UnitDelta
}

export interface ProjectionFoldObserver {
  readonly unitEnumerated?: (unit: Unit) => void
  readonly unitIndexed?: (unit: Unit) => void
  readonly unitLookup?: (key: string) => void
  readonly runningUnitVisited?: (unit: Unit) => void
  readonly fullUnitEnumeration?: () => void
  readonly eventDropped?: (event: SourceEvent, reason: "execution-terminal" | "missing-model-call-id") => void
}

export interface ProjectionFoldOptions {
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
  readonly agentToolsByScopeCall: Map<string, Set<string>>
  readonly toolsByProcess: Map<string, Set<string>>
  readonly childUnitsById: Map<string, Set<string>>
  readonly runningUnits: Set<string>
  readonly assistantUnits: Set<string>
  readonly assistantUnitsByRevision: Map<number, Set<string>>
  readonly rootToolUnits: Set<string>
  readonly rootUserUnits: Set<string>
  readonly outcomeUnits: Set<string>
  readonly childOutcomes: Map<string, ChildOutcome>
  readonly childOutcomesByScopeCall: Map<string, Set<string>>
  readonly usageCursorSet: Set<string>
  readonly usageCursorList: Array<string>
  readonly transientIndexes: Map<string, number>
  readonly transientBases: Map<string, Unit | undefined>
  readonly transientAttemptsByUnit: Map<string, Set<string>>
  readonly transientUnitsByAttempt: Map<string, Set<string>>
  readonly transientCallByAttempt: Map<string, string>
  latestRootToolKey: string | undefined
  terminal: boolean
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

export const isTransientEvent = (event: SourceEvent): boolean =>
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
  return string(value.tool_call_id ?? value.call_id ?? value.callId ?? value.id, event.cursor)
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

const agentScopeCallKey = (candidate: ChildParentCandidate): string =>
  identityKey("agent-scope-call", executionKey(candidate.scope), candidateCallId(candidate))

const indexUnit = (value: OwnedFold, unit: Unit): void => {
  value.observer?.unitIndexed?.(unit)
  const tool = toolBlockFrom(unit)
  if (tool !== undefined) {
    value.toolsById.set(tool.id, unit.key)
    if (tool.childId !== undefined) addIndex(value.toolsByChild, executionKey(tool.childId), unit.key)
    if (tool.presentation.family === "agent")
      addIndex(
        value.agentToolsByScopeCall,
        agentScopeCallKey({
          id: tool.id,
          scope: unit.turnId,
          childId: tool.childId,
          family: tool.presentation.family,
        }),
        unit.key,
      )
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
    if (tool.presentation.family === "agent")
      removeIndex(
        value.agentToolsByScopeCall,
        agentScopeCallKey({
          id: tool.id,
          scope: unit.turnId,
          childId: tool.childId,
          family: tool.presentation.family,
        }),
        unit.key,
      )
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
  const parsed = childScopeAndCallId(restored.childId)
  if (parsed === undefined) return
  const scopeCall = identityKey("agent-scope-call", parsed.scope, parsed.callId)
  const matches = value.childOutcomesByScopeCall.get(scopeCall)
  if (matches !== undefined && !matches.has(childKey))
    throw new RangeError(`Transcript child outcome scope ${parsed.scope}:${parsed.callId} is ambiguous`)
  addIndex(value.childOutcomesByScopeCall, scopeCall, childKey)
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
    agentToolsByScopeCall: new Map(),
    toolsByProcess: new Map(),
    childUnitsById: new Map(),
    runningUnits: new Set(),
    assistantUnits: new Set(),
    assistantUnitsByRevision: new Map(),
    rootToolUnits: new Set(),
    rootUserUnits: new Set(),
    outcomeUnits: new Set(),
    childOutcomes: new Map(),
    childOutcomesByScopeCall: new Map(),
    usageCursorSet: new Set(projection.usageCursors),
    usageCursorList: projection.usageCursors === undefined ? [] : [...projection.usageCursors],
    transientIndexes: new Map(),
    transientBases: new Map(),
    transientAttemptsByUnit: new Map(),
    transientUnitsByAttempt: new Map(),
    transientCallByAttempt: new Map(),
    latestRootToolKey: undefined,
    terminal: false,
    observer: options?.observer,
  }
  owned.set(fold, value)
  for (const unit of units.values()) indexUnit(value, unit)
  value.terminal = value.outcomeUnits.size > 0
  for (const unit of units.values()) {
    const restored = restoredChildOutcome(unit)
    if (restored !== undefined) restoreChildOutcome(value, restored)
  }
  return fold
}

export const makeProjectionFold: {
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

export const restoreProjectionFold: {
  (projection: Projection, options?: ProjectionFoldOptions): ProjectionFold
  (options?: ProjectionFoldOptions): (projection: Projection) => ProjectionFold
} = Function.dual(
  (args) => typeof args[0] === "object" && args[0] !== null && "units" in args[0],
  (projection: Projection, options?: ProjectionFoldOptions): ProjectionFold => makeFold(projection, options),
)

const mutation = (): MutableMutation => ({ stateChanged: false, upsert: new Map(), remove: new Set() })

const result = (change: MutableMutation): FoldMutation => ({
  stateChanged: change.stateChanged,
  units: { upsert: [...change.upsert.values()], remove: [...change.remove] },
})

const setState = <K extends keyof MutableProjectionState>(
  value: OwnedFold,
  change: MutableMutation,
  key: K,
  next: MutableProjectionState[K],
): void => {
  if (value.state[key] === next) return
  value.state[key] = next
  change.stateChanged = true
}

const outcomeStatus = (outcome: NonNullable<Unit["executionOutcome"]>) => outcome.status

const outcomeForUnit = (value: OwnedFold, unit: Unit): ChildOutcome | undefined => {
  const tool = toolBlockFrom(unit)
  if (tool !== undefined) {
    if (tool.childId !== undefined) return value.childOutcomes.get(executionKey(tool.childId))
    if (tool.presentation.family !== "agent") return undefined
    const matches = value.childOutcomesByScopeCall.get(
      agentScopeCallKey({
        id: tool.id,
        scope: unit.turnId,
        childId: undefined,
        family: tool.presentation.family,
      }),
    )
    if (matches?.size !== 1) return undefined
    return value.childOutcomes.get(matches.values().next().value!)
  }
  const child = childBlockFrom(unit)
  return child === undefined ? undefined : value.childOutcomes.get(executionKey(child.id))
}

const withAuthoritativeChildOutcome = (value: OwnedFold, incoming: Unit): Unit => {
  const known = outcomeForUnit(value, incoming)
  if (known === undefined || incoming.content._tag !== "Block") return incoming
  const block = incoming.content.block
  if (block._tag === "ToolCall")
    return {
      ...incoming,
      content: {
        _tag: "Block",
        block: { ...block, childId: known.childId, status: outcomeStatus(known.outcome) },
      },
    }
  if (block._tag === "ChildAgent")
    return {
      ...incoming,
      content: { _tag: "Block", block: { ...block, status: outcomeStatus(known.outcome) } },
    }
  return incoming
}

const upsertUnit = (value: OwnedFold, change: MutableMutation, incoming: Unit): Unit => {
  const previous = value.units.get(incoming.key)
  const authoritative = withAuthoritativeChildOutcome(value, incoming)
  const next = previous === undefined ? authoritative : { ...authoritative, order: previous.order }
  if (previous !== undefined) unindexUnit(value, previous)
  value.units.set(next.key, next)
  indexUnit(value, next)
  change.remove.delete(next.key)
  change.upsert.set(next.key, next)
  return next
}

const removeUnit = (value: OwnedFold, change: MutableMutation, key: string): void => {
  const previous = value.units.get(key)
  if (previous === undefined) return
  unindexUnit(value, previous)
  value.units.delete(key)
  if (value.latestRootToolKey === key) recomputeLatestRootTool(value)
  change.upsert.delete(key)
  change.remove.add(key)
}

const unitByToolId = (value: OwnedFold, id: string): Unit | undefined => {
  const key = value.toolsById.get(id)
  if (key === undefined) return undefined
  value.observer?.unitLookup?.(key)
  return value.units.get(key)
}

const toolAt = (value: OwnedFold, id: string): Extract<Block, { _tag: "ToolCall" }> | undefined => {
  const unit = unitByToolId(value, id)
  return unit === undefined ? undefined : toolBlockFrom(unit)
}

const updateTool = (
  value: OwnedFold,
  change: MutableMutation,
  id: string,
  sequence: number,
  update: (tool: Extract<Block, { _tag: "ToolCall" }>) => Extract<Block, { _tag: "ToolCall" }>,
): Unit | undefined => {
  const current = unitByToolId(value, id)
  const tool = current === undefined ? undefined : toolBlockFrom(current)
  if (current === undefined || tool === undefined) return undefined
  return upsertUnit(value, change, {
    ...current,
    revision: sequence,
    content: { _tag: "Block", block: update(tool) },
  })
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

const linkedToolUnitFor = (
  value: OwnedFold,
  turnId: string,
  childId: string,
  correlatedToolId: string,
): Unit | undefined => {
  if (correlatedToolId.length > 0) {
    const correlated = unitByToolId(value, scopedIdentity(turnId, correlatedToolId))
    if (correlated !== undefined) return correlated
  }
  const childKey = executionKey(childId)
  const linked = value.toolsByChild.get(childKey)
  let linkedFallback: Unit | undefined
  if (linked !== undefined)
    for (const unit of enumerateKeys(value, linked)) {
      const tool = toolBlockFrom(unit)
      if (tool === undefined) continue
      linkedFallback ??= unit
      if (executionKey(tool.id) !== childKey) return unit
    }
  const parsed = childScopeAndCallId(childId)
  if (parsed !== undefined) {
    const matched = firstIndexedUnit(
      value,
      value.agentToolsByScopeCall.get(identityKey("agent-scope-call", parsed.scope, parsed.callId)),
    )
    if (matched !== undefined) return matched
  }
  if (linkedFallback !== undefined) return linkedFallback
  return parsed === undefined ? undefined : unitByToolId(value, scopedIdentity(turnId, parsed.rawCallId))
}

const linkedToolFor = (
  value: OwnedFold,
  turnId: string,
  childId: string,
  correlatedToolId: string,
): Extract<Block, { _tag: "ToolCall" }> | undefined => {
  const unit = linkedToolUnitFor(value, turnId, childId, correlatedToolId)
  return unit === undefined ? undefined : toolBlockFrom(unit)
}

const lineCounts = (patch: string): { readonly additions: number; readonly deletions: number } => {
  let additions = 0
  let deletions = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1
  }
  return { additions, deletions }
}

const normalizedDiffPath = (value: string): string => value.replace(/^(?:a|b)\//, "")

const unifiedFiles = (callId: string, diff: string, failed: boolean): ReadonlyArray<ToolFile> => {
  const starts = [...diff.matchAll(/^diff --git /gm)].map((match) => match.index ?? 0)
  const ranges = starts.length === 0 ? [0] : starts
  return ranges.flatMap((start, ordinal) => {
    const end = ranges[ordinal + 1] ?? diff.length
    const patch = diff.slice(start, end).trimEnd()
    const oldPath = /^--- (.+)$/m.exec(patch)?.[1]
    const newPath = /^\+\+\+ (.+)$/m.exec(patch)?.[1]
    if (oldPath === undefined && newPath === undefined) return []
    const created = oldPath === "/dev/null" || /new file mode/m.test(patch)
    const deleted = newPath === "/dev/null" || /deleted file mode/m.test(patch)
    const path = normalizedDiffPath(deleted ? oldPath! : newPath!)
    const previousPath = oldPath === undefined || oldPath === "/dev/null" ? undefined : normalizedDiffPath(oldPath)
    let kind: ToolFile["kind"] = "update"
    if (created) kind = "add"
    else if (deleted) kind = "delete"
    else if (previousPath !== path) kind = "move"
    return [
      {
        key: `${callId}:${ordinal}`,
        path,
        kind,
        patch,
        ...lineCounts(patch),
        preview: false,
        status: failed ? "failed" : "complete",
        ...(kind === "move" && previousPath !== undefined ? { previousPath } : {}),
      } satisfies ToolFile,
    ]
  })
}

const inputRecord = (input: string): Record<string, unknown> => {
  const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(input)
  if (Option.isNone(decoded)) return partialInputRecord(input)
  return typeof decoded.value === "string" ? { path: decoded.value, command: decoded.value } : record(decoded.value)
}

const inputString = (input: Record<string, unknown>, keys: ReadonlyArray<string>): string | undefined => {
  for (const key of keys) if (typeof input[key] === "string" && input[key].length > 0) return input[key]
  return undefined
}

const inputContentText = (input: Record<string, unknown>): string | undefined => {
  if (!Array.isArray(input.input)) return undefined
  const text = input.input
    .flatMap((part) => {
      const value = record(part)
      return value.type === "text" && typeof value.text === "string" ? [value.text] : []
    })
    .join("\n")
  return text.length === 0 ? undefined : text
}

const detailFor = (name: string, inputText: string): string => {
  const normalizedName = name.toLowerCase()
  const input = inputRecord(inputText)
  const path = inputString(input, ["path", "file_path", "file"])
  if (normalizedName === "read") {
    const readRange = Array.isArray(input.read_range) ? input.read_range : undefined
    if (typeof readRange?.[0] === "number" && typeof readRange[1] === "number")
      return `${path ?? name} L${readRange[0]}-${readRange[1]}`
    const offset = typeof input.offset === "number" ? input.offset : 1
    const limit = typeof input.limit === "number" ? input.limit : undefined
    return `${path ?? name}${limit === undefined ? "" : ` L${offset}-${offset + Math.max(0, limit - 1)}`}`
  }
  if (normalizedName === "grep")
    return `${path === undefined ? "" : `${path} `}"${inputString(input, ["pattern"]) ?? ""}"`.trim()
  if (normalizedName === "bash") {
    const command = inputString(input, ["command", "cmd", "script"]) ?? ""
    const args = Array.isArray(input.args)
      ? input.args.filter((value): value is string => typeof value === "string")
      : []
    return [command, ...args].join(" ").trim()
  }
  if (normalizedName === "shell_command_status") return inputString(input, ["processId", "process_id"]) ?? ""
  if (normalizedName === "web_search") return inputString(input, ["objective", "query"]) ?? ""
  if (normalizedName === "read_web_page") return inputString(input, ["url"]) ?? ""
  if (normalizedName === "search_threads") return inputString(input, ["query"]) ?? ""
  if (normalizedName === "read_thread_transcript") return inputString(input, ["threadId", "thread_id", "id"]) ?? ""
  if (path !== undefined) return path
  return inputString(input, ["description", "prompt", "task", "query", "objective"]) ?? inputContentText(input) ?? ""
}

const inputFiles = (id: string, name: string, inputText: string): ReadonlyArray<ToolFile> => {
  const input = inputRecord(inputText)
  const path = inputString(input, ["path", "file_path", "file"])
  if (path === undefined || (name !== "write" && name !== "edit")) return []
  const patch =
    name === "write"
      ? `--- /dev/null\n+++ b/${path}\n${string(input.content)
          .split("\n")
          .map((line) => `+${line}`)
          .join("\n")}`
      : `--- a/${path}\n+++ b/${path}\n${string(input.old_str ?? input.oldText)
          .split("\n")
          .map((line) => `-${line}`)
          .join("\n")}\n${string(input.new_str ?? input.newText)
          .split("\n")
          .map((line) => `+${line}`)
          .join("\n")}`
  return [
    {
      key: `${id}:0`,
      path,
      kind: name === "write" ? "add" : "update",
      patch,
      ...lineCounts(patch),
      preview: true,
      status: "running",
    },
  ]
}

const toolBlock = (id: string, name: string, input: string, previous?: Extract<Block, { _tag: "ToolCall" }>) => ({
  _tag: "ToolCall" as const,
  id,
  name,
  input,
  status: previous?.status ?? ("running" as const),
  presentation: previous?.presentation ?? Catalog.resolvePresentation(name),
  detail: detailFor(name, input),
  files: inputFiles(id, name, input),
  ...(previous?.output === undefined ? {} : { output: previous.output }),
  ...(previous?.process === undefined ? {} : { process: previous.process }),
  ...(previous?.parentId === undefined ? {} : { parentId: previous.parentId }),
  ...(previous?.childId === undefined ? {} : { childId: previous.childId }),
})

const processOutput = (process: ToolProcess | undefined): string => `${process?.stdout ?? ""}${process?.stderr ?? ""}`

const initialProcessOutput = (tool: Extract<Block, { _tag: "ToolCall" }>): string | undefined => {
  const raw = processOutput(tool.process)
  return tool.process?.truncated !== true && tool.output === raw.trim() ? raw : tool.output
}

const boundedSuffix = (text: string, limit: number): string => {
  const suffix = text.slice(-limit)
  const first = suffix.charCodeAt(0)
  return first >= 0xdc00 && first <= 0xdfff ? suffix.slice(1) : suffix
}

const foldOutput = (
  current: string | undefined,
  next: string,
  limit: number,
): { readonly output?: string; readonly truncated: boolean } => {
  const combined = `${current ?? ""}${next}`
  if (combined.length <= limit) return { ...(combined.length === 0 ? {} : { output: combined }), truncated: false }
  return { output: boundedSuffix(combined, limit), truncated: true }
}

const processResult = (output: unknown): ToolProcess | undefined => {
  const value = record(output)
  const process = {
    ...(typeof value.running === "boolean" ? { running: value.running } : {}),
    ...(typeof value.processId === "string" ? { processId: value.processId } : {}),
    ...(typeof value.exitCode === "number" ? { exitCode: value.exitCode } : {}),
    ...(typeof value.stdout === "string" ? { stdout: value.stdout } : {}),
    ...(typeof value.stderr === "string" ? { stderr: value.stderr } : {}),
    ...(typeof value.truncated === "boolean" ? { truncated: value.truncated } : {}),
  }
  return Object.keys(process).length === 0 ? undefined : process
}

const applyUsage = (value: OwnedFold, change: MutableMutation, event: SourceEvent): void => {
  const identity = event.cursor
  if (value.usageCursorSet.has(identity)) return
  value.usageCursorSet.add(identity)
  value.usageCursorList.push(identity)
  change.stateChanged = true
}

const assistantKey = (turnId: string, phase: number): string => identityKey("assistant", turnId, Math.max(0, phase))
const reasoningKey = (turnId: string, phase: number): string => identityKey("reasoning", turnId, Math.max(0, phase))

const assistantText = (event: SourceEvent): string => event.text ?? string(sourcePayload(event).text)

const applyAssistant = (
  value: OwnedFold,
  change: MutableMutation,
  turnId: string,
  event: SourceEvent,
  complete: boolean,
): void => {
  const key = assistantKey(turnId, value.state.modelPhase)
  const current = value.units.get(key)
  const text = assistantText(event)
  const finish = (): void => {
    if (complete && text.trim().length > 0) setState(value, change, "usableCompletionSequence", event.sequence)
  }
  const aggregateCompletion = complete && typeof sourcePayload(event).model_output === "string"
  if (aggregateCompletion && value.assistantUnits.size > 0) {
    if (current?.content._tag === "Entry" && current.content.role === "assistant")
      upsertUnit(value, change, { ...current, revision: event.sequence })
    finish()
    return
  }
  if (current?.content._tag === "Entry" && current.content.role === "assistant") {
    upsertUnit(value, change, {
      ...current,
      revision: event.sequence,
      content: {
        ...current.content,
        text: complete && text.length > 0 ? text : current.content.text + text,
      },
    })
    finish()
    return
  }
  if (text.length === 0) return
  upsertUnit(
    value,
    change,
    makeUnit(key, turnId, event.sequence, 0, event.sequence, {
      _tag: "Entry",
      role: "assistant",
      text,
    }),
  )
  finish()
}

const childStatus = (
  event: SourceEvent,
  value: Record<string, unknown>,
): "running" | "complete" | "failed" | "cancelled" => {
  const raw = string(value.status ?? value.state).toLowerCase()
  if (raw === "failed" || raw === "error") return "failed"
  if (raw === "cancelled" || raw === "canceled") return "cancelled"
  if (raw === "completed" || raw === "complete" || raw === "succeeded" || raw === "terminal") return "complete"
  if (event.type.includes("failed")) return "failed"
  if (event.type.includes("cancel")) return "cancelled"
  if (event.type.includes("terminal") || event.type.includes("completed")) return "complete"
  return "running"
}

const applyChild = (value: OwnedFold, change: MutableMutation, turnId: string, event: SourceEvent): void => {
  const outer = sourcePayload(event)
  const payload = Object.keys(record(outer.member)).length > 0 ? record(outer.member) : outer
  const childId = string(
    payload.child_execution_id ??
      payload.child_run_id ??
      payload.childId ??
      payload.child_id ??
      outer.child_execution_id ??
      outer.child_run_id ??
      outer.childId,
    event.cursor,
  )
  const correlatedToolId = string(payload.tool_call_id ?? payload.parent_tool_call_id)
  const linkedTool = linkedToolFor(value, turnId, childId, correlatedToolId)
  if (linkedTool !== undefined) {
    const id = linkedTool.id
    const nextStatus = childStatus(event, payload)
    const profile = Catalog.agentProfile(string(payload.profile ?? payload.preset_name ?? payload.name))
    const presentation = profile.length === 0 ? linkedTool.presentation : Catalog.resolveAgentPresentation(profile)
    const updated = updateTool(value, change, id, event.sequence, (tool) => ({
      ...tool,
      childId,
      status: nextStatus,
      presentation,
      ...(string(payload.summary ?? payload.output ?? payload.error).length === 0
        ? {}
        : { output: string(payload.summary ?? payload.output ?? payload.error) }),
    }))
    if (updated !== undefined) {
      const childKeys = value.childUnitsById.get(executionKey(childId))
      if (childKeys !== undefined)
        for (const child of enumerateKeys(value, childKeys)) removeUnit(value, change, child.key)
      return
    }
  }
  const key = identityKey("child", turnId, childId)
  const current = value.units.get(key)
  const previous = current === undefined ? undefined : childBlockFrom(current)
  const activity = string(payload.activity ?? payload.event ?? payload.detail ?? event.text)
  const block: Extract<Block, { _tag: "ChildAgent" }> = {
    _tag: "ChildAgent",
    id: childId,
    name: Catalog.agentProfile(
      string(payload.profile ?? payload.preset_name ?? payload.name, previous?.name ?? "child"),
    ),
    summary: string(payload.summary ?? payload.output ?? payload.error, previous?.summary ?? ""),
    status: childStatus(event, payload),
    activity: activity.length === 0 ? (previous?.activity ?? []) : [...(previous?.activity ?? []), activity],
  }
  upsertUnit(
    value,
    change,
    makeUnit(key, turnId, current?.order.at(-1)?.sequence ?? event.sequence, 0, event.sequence, {
      _tag: "Block",
      block,
    }),
  )
}

const genericBlock = (turnId: string, event: SourceEvent): Block | undefined => {
  const value = sourcePayload(event)
  if (event.type.startsWith("permission.ask.") || event.type.startsWith("tool.approval.")) return undefined
  if (event.type.includes("diff"))
    return { _tag: "Diff", path: string(value.path, "diff"), patch: event.text ?? string(value.patch ?? value.diff) }
  if (event.type === "agent.compaction.started")
    return { _tag: "Compaction", summary: event.text ?? string(value.summary), status: "running" }
  if (event.type === "agent.compaction.completed")
    return {
      _tag: "Compaction",
      summary: event.text ?? string(value.summary),
      status: "complete",
    }
  if (event.type === "agent.compaction.committed")
    return {
      _tag: "Compaction",
      summary: event.text ?? string(value.summary),
      status: "complete",
      ...(string(value.checkpoint ?? value.checkpoint_id).length === 0
        ? {}
        : { checkpoint: string(value.checkpoint ?? value.checkpoint_id) }),
    }
  if (event.type === "agent.compaction.failed")
    return {
      _tag: "Compaction",
      summary: event.text ?? string(value.summary ?? value.message),
      status: "failed",
    }
  if (event.type.includes("notification"))
    return {
      _tag: "Notification",
      title: string(value.title ?? value.name, "Notification"),
      detail: event.text ?? string(value.detail ?? value.message),
    }
  if (event.type.includes("image") && event.type.includes("attachment"))
    return {
      _tag: "ImageAttachment",
      name: string(value.name ?? value.filename, "image"),
      mediaType: string(value.media_type ?? value.mediaType, "application/octet-stream"),
      ...(typeof value.width === "number" ? { width: value.width } : {}),
      ...(typeof value.height === "number" ? { height: value.height } : {}),
      ...(typeof value.bytes === "number" ? { bytes: value.bytes } : {}),
    }
  if (event.type.includes("workflow")) {
    let status: Extract<Block, { _tag: "Workflow" }>["status"] = "running"
    if (event.type.includes("failed")) status = "failed"
    else if (event.type.includes("completed")) status = "complete"
    else if (event.type.includes("wait")) status = "waiting"
    return {
      _tag: "Workflow",
      name: string(value.workflow ?? value.name, "workflow"),
      step: event.text ?? string(value.step ?? value.status),
      status,
    }
  }
  if (event.type.includes("error") || event.type.includes("failed") || event.type === "budget.exceeded")
    return {
      _tag: "Error",
      title: string(value.title, event.type === "budget.exceeded" ? "Budget exceeded" : "Error"),
      detail: event.text ?? string(value.message ?? value.error, event.type),
      turnId,
      ...(string(value.recovery).length === 0 ? {} : { recovery: string(value.recovery) }),
    }
  if (event.type.includes("tool") && (event.type.includes("result") || event.type.includes("completed")))
    return {
      _tag: "ToolResult",
      id: scopedIdentity(turnId, string(value.callId ?? value.call_id ?? value.id, event.cursor)),
      output: event.text ?? string(value.output ?? value.result),
      failed: event.type.includes("failed") || value.failed === true,
    }
  if (event.type.includes("tool")) {
    const id = scopedIdentity(turnId, string(value.callId ?? value.call_id ?? value.id, event.cursor))
    const name = string(value.name ?? value.tool, "tool")
    const input = encodeInput(value.input ?? value)
    return toolBlock(id, name, input)
  }
  return undefined
}

const genericKey = (turnId: string, event: SourceEvent, block: Block): string => {
  const value = sourcePayload(event)
  switch (block._tag) {
    case "Diff":
      return identityKey("diff", turnId, block.path)
    case "Compaction":
      return identityKey("compaction", turnId)
    case "ChildAgent":
      return identityKey("child", turnId, block.id)
    case "Workflow": {
      const id = string(value.run_id ?? value.runId ?? value.workflow_id)
      return identityKey("workflow", turnId, id.length === 0 ? event.cursor : id)
    }
    case "ImageAttachment":
      return identityKey("image", turnId, string(value.id, event.cursor))
    case "Notification":
      return identityKey("notification", turnId, string(value.id, event.cursor))
    case "Error":
      return identityKey("error", turnId, string(value.id, event.cursor))
    default: {
      const id = "id" in block && typeof block.id === "string" ? block.id : `${event.sequence}:${event.type}`
      return identityKey("event", turnId, id)
    }
  }
}

const applyToolDelta = (value: OwnedFold, change: MutableMutation, turnId: string, event: SourceEvent): void => {
  const payload = callPayload(event)
  const rawId = rawToolId(event)
  const id = scopedIdentity(turnId, rawId)
  const previous = toolAt(value, id)
  const delta = string(payload.delta ?? event.text)
  const input = `${previous?.input ?? ""}${delta}`
  const name = string(payload.tool_name ?? payload.name, previous?.name ?? "tool")
  const block = toolBlock(id, name, input, previous)
  upsertUnit(
    value,
    change,
    makeUnit(toolKey(turnId, rawId), turnId, event.sequence, 0, event.sequence, {
      _tag: "Block",
      block,
    }),
  )
}

const applyToolRequested = (value: OwnedFold, change: MutableMutation, turnId: string, event: SourceEvent): void => {
  const payload = callPayload(event)
  const rawId = rawToolId(event)
  const id = scopedIdentity(turnId, rawId)
  const previous = toolAt(value, id)
  const name = string(payload.tool_name ?? payload.name, previous?.name ?? "tool")
  const input = encodeInput(payload.input)
  const base = toolBlock(id, name, input, previous)
  const processId =
    base.presentation.rowDisplay === "continuation"
      ? inputString(inputRecord(input), ["processId", "process_id"])
      : undefined
  let parent: Unit | undefined
  if (processId !== undefined) {
    const candidates = value.toolsByProcess.get(processId)
    if (candidates !== undefined)
      for (const unit of enumerateKeys(value, candidates)) {
        const tool = toolBlockFrom(unit)
        if (tool?.name === "bash") {
          parent = unit
          break
        }
      }
  }
  const parentTool = parent === undefined ? undefined : toolBlockFrom(parent)
  const block = parentTool === undefined ? base : { ...base, detail: parentTool.detail, parentId: parentTool.id }
  upsertUnit(
    value,
    change,
    makeUnit(toolKey(turnId, rawId), turnId, event.sequence, 0, event.sequence, {
      _tag: "Block",
      block,
    }),
  )
}

const applyToolResult = (value: OwnedFold, change: MutableMutation, turnId: string, event: SourceEvent): void => {
  const payload = resultPayload(event)
  const rawId = rawToolId(event)
  const id = scopedIdentity(turnId, rawId)
  const requested = toolAt(value, id)
  const output = payload.output
  const outputStatus = string(record(output).status).toLowerCase()
  const process = processResult(output)
  const failed =
    typeof payload.error === "string" ||
    record(output)._tag === "ToolError" ||
    outputStatus === "failed" ||
    (process?.exitCode !== undefined && process.exitCode !== 0)
  const cancelled = outputStatus === "cancelled" || outputStatus === "canceled"
  const spawned = record(output)._tag === "Spawned" && outputStatus === "running"
  const errorText = string(payload.error, string(record(output).message))
  const resultText = failed && errorText.length > 0 ? errorText : outputText(output)
  const diff = string(record(output).diff)
  const updated = updateTool(value, change, id, event.sequence, (tool) => {
    let status: Extract<Block, { _tag: "ToolCall" }>["status"] = "complete"
    if (failed) status = "failed"
    else if (cancelled) status = "cancelled"
    else if (spawned || (process?.running === true && tool.presentation.rowDisplay !== "continuation"))
      status = "running"
    return {
      ...tool,
      status,
      ...(spawned ? {} : { output: resultText }),
      ...(process === undefined ? {} : { process: { ...tool.process, ...process } }),
      files:
        diff.length > 0
          ? unifiedFiles(id, diff, failed)
          : tool.files.map((file) => ({ ...file, preview: false, status: failed ? "failed" : "complete" })),
    }
  })
  if (updated !== undefined) {
    if (
      requested?.presentation.rowDisplay !== "continuation" ||
      requested.parentId === undefined ||
      process?.running === undefined ||
      process.processId === undefined
    )
      return
    const parentTool = toolAt(value, requested.parentId)
    if (parentTool?.status !== "running" || parentTool.process?.processId !== process.processId) return
    const running = process.running
    const processId = process.processId
    updateTool(value, change, requested.parentId, event.sequence, (tool) => {
      let status: Extract<Block, { _tag: "ToolCall" }>["status"] = "complete"
      if (process.exitCode !== undefined && process.exitCode !== 0) status = "failed"
      else if (running) status = "running"
      const mergedOutput = foldOutput(
        initialProcessOutput(tool),
        resultText,
        Catalog.get(tool.name)?.outputLimit ?? 40_000,
      )
      return {
        ...tool,
        status,
        ...(mergedOutput.output === undefined ? {} : { output: mergedOutput.output }),
        process: {
          ...tool.process,
          processId,
          running,
          ...(process.exitCode === undefined ? {} : { exitCode: process.exitCode }),
          truncated: tool.process?.truncated === true || process.truncated === true || mergedOutput.truncated,
        },
      }
    })
    return
  }
  const block: Block = { _tag: "ToolResult", id, output: resultText, failed }
  upsertUnit(
    value,
    change,
    makeUnit(identityKey("tool-result", turnId, rawId), turnId, event.sequence, 0, event.sequence, {
      _tag: "Block",
      block,
    }),
  )
}

const applyReasoning = (
  value: OwnedFold,
  change: MutableMutation,
  turnId: string,
  event: SourceEvent,
  complete: boolean,
): void => {
  const key = reasoningKey(turnId, value.state.modelPhase)
  const current = value.units.get(key)
  const previous =
    current?.content._tag === "Block" && current.content.block._tag === "Reasoning" ? current.content.block.text : ""
  const incoming = event.text ?? string(sourcePayload(event).text)
  const block: Block = {
    _tag: "Reasoning",
    text: complete && incoming.length > 0 ? incoming : previous + incoming,
  }
  upsertUnit(
    value,
    change,
    makeUnit(key, turnId, current?.order.at(-1)?.sequence ?? event.sequence, 0, event.sequence, {
      _tag: "Block",
      block,
    }),
  )
}

const settledBlock = (block: Block, status: "failed" | "cancelled"): Block | undefined => {
  if (block._tag === "ToolCall" && block.status === "running") return { ...block, status }
  if (block._tag === "ChildAgent" && block.status === "running") return { ...block, status }
  if (block._tag === "Compaction" && block.status === "running") return { ...block, status }
  return undefined
}

const settleRunningInto = (
  value: OwnedFold,
  change: MutableMutation,
  status: "failed" | "cancelled",
  sequence: number,
): void => {
  for (const unit of enumerateKeys(value, value.runningUnits)) {
    value.observer?.runningUnitVisited?.(unit)
    if (unit.content._tag !== "Block") continue
    const settled = settledBlock(unit.content.block, status)
    if (settled === undefined) continue
    upsertUnit(value, change, {
      ...unit,
      revision: Math.max(unit.revision, sequence),
      content: { _tag: "Block", block: settled },
    })
  }
}

const settleChildInto = (
  value: OwnedFold,
  change: MutableMutation,
  childId: string,
  status: "complete" | "failed" | "cancelled",
  sequence: number,
  authoritative: boolean,
): void => {
  const linkedUnit = linkedToolUnitFor(value, value.turnId, childId, "")
  const linkedTool = linkedUnit === undefined ? undefined : toolBlockFrom(linkedUnit)
  if (
    linkedTool !== undefined &&
    (authoritative || linkedTool.status === "running") &&
    (linkedTool.status !== status || executionKey(linkedTool.childId ?? "") !== executionKey(childId))
  )
    updateTool(value, change, linkedTool.id, Math.max(sequence, linkedUnit!.revision), (tool) => ({
      ...tool,
      childId,
      status,
    }))
  const childKeys = value.childUnitsById.get(executionKey(childId))
  if (childKeys === undefined) return
  const childUnits = Array.from(enumerateKeys(value, childKeys))
  for (const unit of childUnits) {
    const block = childBlockFrom(unit)
    if (block === undefined || (!authoritative && block.status !== "running") || block.status === status) continue
    upsertUnit(value, change, {
      ...unit,
      revision: Math.max(unit.revision, sequence),
      content: { _tag: "Block", block: { ...block, status } },
    })
  }
}

const advanceModelPhase = (value: OwnedFold, change: MutableMutation, turnId: string): void => {
  const phase = Math.max(0, value.state.modelPhase)
  if (value.units.has(assistantKey(turnId, phase)) || value.units.has(reasoningKey(turnId, phase)))
    setState(value, change, "modelPhase", phase + 1)
}

const isTruncatedStream = (event: SourceEvent): boolean => {
  const payload = sourcePayload(event)
  if (payload.category === "truncated-stream") return true
  return record(payload.details).failure_classification === "truncated-stream"
}

const hasUsableFinalResponse = (value: OwnedFold): boolean => {
  const completionSequence = value.state.usableCompletionSequence
  if (completionSequence === undefined) return false
  const candidates = value.assistantUnitsByRevision.get(completionSequence)
  if (candidates === undefined) return false
  const latestTool = value.latestRootToolKey === undefined ? undefined : value.units.get(value.latestRootToolKey)
  for (const unit of enumerateKeys(value, candidates))
    if (
      unit.turnId === value.turnId &&
      isRootUnit(unit) &&
      unit.content._tag === "Entry" &&
      unit.content.role === "assistant" &&
      unit.content.text.trim().length > 0 &&
      (latestTool === undefined || compareUnitOrder(unit.order, latestTool.order) > 0)
    )
      return true
  return false
}

const clearExecutionOutcomes = (value: OwnedFold, change: MutableMutation): void => {
  for (const unit of Array.from(enumerateKeys(value, value.outcomeUnits))) {
    const { executionOutcome: _executionOutcome, ...withoutOutcome } = unit
    upsertUnit(value, change, withoutOutcome)
  }
}

const applyExecutionOutcome = (
  value: OwnedFold,
  change: MutableMutation,
  turnId: string,
  revision: number,
  outcome: NonNullable<Unit["executionOutcome"]>,
): void => {
  clearExecutionOutcomes(value, change)
  const current = firstIndexedUnit(value, value.rootUserUnits)
  if (current !== undefined) {
    upsertUnit(value, change, { ...current, revision, executionOutcome: outcome })
    return
  }
  upsertUnit(value, change, {
    ...makeUnit(identityKey("execution", turnId, "outcome"), turnId, Number.MAX_SAFE_INTEGER, 0, revision, {
      _tag: "Entry",
      role: "notice",
      text: "",
    }),
    executionOutcome: outcome,
  })
}

const steeringMessageTexts = (event: SourceEvent, count: number): ReadonlyArray<string> => {
  const parts = (event.content ?? []).flatMap((part) => {
    const value = record(part)
    return value.type === "text" && typeof value.text === "string" ? [value.text] : []
  })
  if (parts.length === count) return parts.filter((text) => text.length > 0)
  const joined = event.text ?? parts.join("\n")
  return joined.length === 0 ? [] : [joined]
}

const applySteeringDelivered = (
  value: OwnedFold,
  change: MutableMutation,
  turnId: string,
  event: SourceEvent,
): void => {
  const payload = sourcePayload(event)
  const count = typeof payload.message_count === "number" ? payload.message_count : 0
  if (count === 0) return
  for (const [index, text] of steeringMessageTexts(event, count).entries())
    upsertUnit(
      value,
      change,
      makeUnit(identityKey("steering", turnId, event.sequence, index), turnId, event.sequence, index, event.sequence, {
        _tag: "Entry",
        role: "user",
        text,
      }),
    )
}

const applyKnownEvent = (value: OwnedFold, change: MutableMutation, event: SourceEvent): void => {
  const turnId = value.turnId
  if (event.type === "model.input.prepared") {
    if (value.state.modelPhase < 0) setState(value, change, "modelPhase", 0)
    advanceModelPhase(value, change, turnId)
    return
  }
  if (event.type === "model.output.delta") return applyAssistant(value, change, turnId, event, false)
  if (event.type === "model.output.completed") return applyAssistant(value, change, turnId, event, true)
  if (event.type === "model.cycle.completed") return applyAssistant(value, change, turnId, event, true)
  if (event.type === "model.reasoning.completed") return applyReasoning(value, change, turnId, event, true)
  if (event.type.includes("reasoning")) return applyReasoning(value, change, turnId, event, false)
  if (event.type === "model.toolcall.delta") return applyToolDelta(value, change, turnId, event)
  if (event.type === "tool.call.requested") {
    applyToolRequested(value, change, turnId, event)
    advanceModelPhase(value, change, turnId)
    return
  }
  if (event.type === "tool.result.received") return applyToolResult(value, change, turnId, event)
  if (event.type === "steering.delivered") return applySteeringDelivered(value, change, turnId, event)
  if (event.type === "model.usage.reported") return applyUsage(value, change, event)
  if (event.type === "model.attempt.failed" || event.type === "model.call.failed") return
  if (event.type === "model.retry.scheduled") {
    const payload = sourcePayload(event)
    const modelCallId = string(payload.model_call_id)
    if (modelCallId.length === 0) {
      value.observer?.eventDropped?.(event, "missing-model-call-id")
      return
    }
    const reason = string(payload.reason)
    const category = string(payload.category)
    let block: Block
    if (reason === "invalid-tool-call-correction")
      block = {
        _tag: "Notification",
        title: "Correcting model tool call",
        detail: "The model produced an invalid tool call. Rika is asking it to correct the call.",
      }
    else if (category === "timeout")
      block = {
        _tag: "Notification",
        title: "Model response timed out",
        detail: "The model stopped responding before the configured deadline. Rika is retrying the call.",
      }
    else
      block = {
        _tag: "Notification",
        title: "Retrying model response",
        detail: "The model call failed before any output was shown. Rika is retrying the call.",
      }
    upsertUnit(
      value,
      change,
      makeUnit(
        identityKey("model-retry", event.childExecutionId ?? event.executionId ?? executionKey(turnId), modelCallId),
        turnId,
        event.sequence,
        0,
        event.sequence,
        { _tag: "Block", block },
      ),
    )
    return
  }
  if (event.type === "execution.completed") {
    settleRunningInto(value, change, "cancelled", event.sequence)
    applyExecutionOutcome(value, change, turnId, event.sequence, { status: "complete" })
    return
  }
  if (event.type === "execution.failed") {
    if (!isTruncatedStream(event) && hasUsableFinalResponse(value)) {
      settleRunningInto(value, change, "cancelled", event.sequence)
      applyExecutionOutcome(value, change, turnId, event.sequence, { status: "complete" })
      return
    }
    const payload = sourcePayload(event)
    const details = record(payload.details)
    const compactionFailed = details.failure_classification === "context-overflow"
    const reason = event.text ?? string(payload.message, "The execution failed unexpectedly.")
    const block: Block = {
      _tag: "Error",
      title: compactionFailed ? "Auto-compaction failed" : "Execution failed",
      detail: reason,
      turnId,
      recovery: compactionFailed
        ? "Try again. If the thread is still too large, start a new thread."
        : "Edit your prompt and press Enter to try again.",
    }
    settleRunningInto(value, change, "failed", event.sequence)
    clearExecutionOutcomes(value, change)
    upsertUnit(value, change, {
      ...makeUnit(identityKey("execution", turnId, "failed"), turnId, event.sequence, 0, event.sequence, {
        _tag: "Block",
        block,
      }),
      executionOutcome: { status: "failed", reason },
    })
    return
  }
  if (event.type === "execution.cancelled") {
    const payload = sourcePayload(event)
    const reason = event.text ?? string(payload.reason, string(payload.message))
    settleRunningInto(value, change, "cancelled", event.sequence)
    applyExecutionOutcome(value, change, turnId, event.sequence, {
      status: "cancelled",
      ...(reason.length > 0 ? { reason } : {}),
    })
    return
  }
  if (event.type.startsWith("child_run.") || event.type.startsWith("child_fan_out.member."))
    return applyChild(value, change, turnId, event)
  const block = genericBlock(turnId, event)
  if (block === undefined) return
  const key = genericKey(turnId, event, block)
  const previous = value.units.get(key)
  const previousCompaction =
    previous !== undefined && previous.content._tag === "Block" && previous.content.block._tag === "Compaction"
      ? previous.content.block
      : undefined
  const compactionCheckpoint =
    block._tag === "Compaction" && previousCompaction !== undefined
      ? (block.checkpoint ?? previousCompaction.checkpoint)
      : undefined
  const nextBlock =
    block._tag === "Compaction" && previousCompaction !== undefined
      ? {
          ...block,
          summary: block.summary.length > 0 ? block.summary : previousCompaction.summary,
          ...(compactionCheckpoint === undefined ? {} : { checkpoint: compactionCheckpoint }),
        }
      : block
  upsertUnit(
    value,
    change,
    makeUnit(key, turnId, event.sequence, 0, event.sequence, {
      _tag: "Block",
      block: nextBlock,
    }),
  )
}

const transientAttempt = (event: SourceEvent): string => {
  const payload = sourcePayload(event)
  return identityKey("transient-attempt", string(payload.model_call_id), string(payload.model_attempt_id))
}

const transientIndex = (event: SourceEvent): number =>
  typeof event.data?.transient_index === "number" ? event.data.transient_index : -1

const transientUnitKey = (value: OwnedFold, event: SourceEvent): string | undefined => {
  if (event.type === "model.output.delta") return assistantKey(value.turnId, value.state.modelPhase)
  if (event.type === "model.reasoning.delta") return reasoningKey(value.turnId, value.state.modelPhase)
  if (event.type === "model.toolcall.delta") return toolKey(value.turnId, rawToolId(event))
  return undefined
}

const durableResolutionKey = (value: OwnedFold, event: SourceEvent): string | undefined => {
  if (event.type === "model.output.completed" || event.type === "model.cycle.completed")
    return assistantKey(value.turnId, value.state.modelPhase)
  if (event.type === "model.reasoning.completed") return reasoningKey(value.turnId, value.state.modelPhase)
  if (event.type === "tool.call.requested") return toolKey(value.turnId, rawToolId(event))
  return undefined
}

const restoreTransientBase = (value: OwnedFold, change: MutableMutation, key: string): void => {
  if (!value.transientBases.has(key)) return
  const base = value.transientBases.get(key)
  if (base === undefined) removeUnit(value, change, key)
  else upsertUnit(value, change, base)
  value.transientBases.delete(key)
  for (const attempt of value.transientAttemptsByUnit.get(key) ?? []) {
    const units = value.transientUnitsByAttempt.get(attempt)
    units?.delete(key)
    if (units?.size === 0) {
      value.transientUnitsByAttempt.delete(attempt)
      value.transientIndexes.delete(attempt)
      value.transientCallByAttempt.delete(attempt)
    }
  }
  value.transientAttemptsByUnit.delete(key)
}

const clearTransientAttempt = (value: OwnedFold, change: MutableMutation, attempt: string): void => {
  for (const key of value.transientUnitsByAttempt.get(attempt) ?? []) restoreTransientBase(value, change, key)
  value.transientUnitsByAttempt.delete(attempt)
  value.transientIndexes.delete(attempt)
  value.transientCallByAttempt.delete(attempt)
}

const clearTransientCall = (value: OwnedFold, change: MutableMutation, callId: string): void => {
  for (const [attempt, candidate] of value.transientCallByAttempt)
    if (candidate === callId) clearTransientAttempt(value, change, attempt)
}

const clearAllTransients = (value: OwnedFold, change: MutableMutation): void => {
  for (const key of value.transientBases.keys()) restoreTransientBase(value, change, key)
  value.transientIndexes.clear()
  value.transientUnitsByAttempt.clear()
  value.transientAttemptsByUnit.clear()
  value.transientCallByAttempt.clear()
}

const clearResolvedOverlay = (value: OwnedFold, change: MutableMutation, event: SourceEvent): void => {
  const payload = sourcePayload(event)
  if (event.type === "model.attempt.failed") {
    clearTransientAttempt(value, change, transientAttempt(event))
    return
  }
  if (event.type === "model.call.failed") {
    clearTransientCall(value, change, string(payload.model_call_id))
    return
  }
  if (event.type === "execution.completed" || event.type === "execution.failed" || event.type === "execution.cancelled")
    clearAllTransients(value, change)
}

export const applyFoldEvent: {
  (fold: ProjectionFold, event: SourceEvent): FoldMutation
  (event: SourceEvent): (fold: ProjectionFold) => FoldMutation
} = Function.dual(2, (fold: ProjectionFold, event: SourceEvent): FoldMutation => {
  const value = owner(fold)
  const change = mutation()
  if (isTransientEvent(event)) {
    if (value.terminal) {
      value.observer?.eventDropped?.(event, "execution-terminal")
      return result(change)
    }
    if (event.sequence < value.state.revision) return result(change)
    const attempt = transientAttempt(event)
    const payload = sourcePayload(event)
    const index = transientIndex(event)
    if (index <= (value.transientIndexes.get(attempt) ?? -1)) return result(change)
    const key = transientUnitKey(value, event)
    if (key !== undefined) {
      if (!value.transientBases.has(key)) value.transientBases.set(key, value.units.get(key))
      const attempts = value.transientAttemptsByUnit.get(key) ?? new Set<string>()
      attempts.add(attempt)
      value.transientAttemptsByUnit.set(key, attempts)
      const units = value.transientUnitsByAttempt.get(attempt) ?? new Set<string>()
      units.add(key)
      value.transientUnitsByAttempt.set(attempt, units)
      value.transientCallByAttempt.set(attempt, string(payload.model_call_id))
    }
    applyKnownEvent(value, change, event)
    value.transientIndexes.set(attempt, index)
    return result(change)
  }
  if (event.sequence <= value.state.revision) {
    if (event.type === "model.usage.reported") applyUsage(value, change, event)
    return result(change)
  }
  clearResolvedOverlay(value, change, event)
  const resolvedKey = durableResolutionKey(value, event)
  if (resolvedKey !== undefined) restoreTransientBase(value, change, resolvedKey)
  applyKnownEvent(value, change, event)
  if (event.type === "execution.completed" || event.type === "execution.failed" || event.type === "execution.cancelled")
    value.terminal = true
  setState(value, change, "revision", event.sequence)
  if (value.state.oldestCursor === undefined) setState(value, change, "oldestCursor", event.cursor)
  setState(value, change, "checkpointCursor", event.cursor)
  return result(change)
})

export const settleFoldRunning: {
  (fold: ProjectionFold, status: "failed" | "cancelled", sequence: number): FoldMutation
  (status: "failed" | "cancelled", sequence: number): (fold: ProjectionFold) => FoldMutation
} = Function.dual(3, (fold: ProjectionFold, status: "failed" | "cancelled", sequence: number): FoldMutation => {
  const value = owner(fold)
  const change = mutation()
  settleRunningInto(value, change, status, sequence)
  return result(change)
})

export const settleFoldChild: {
  (fold: ProjectionFold, childId: string, status: "complete" | "failed" | "cancelled", sequence: number): FoldMutation
  (
    childId: string,
    status: "complete" | "failed" | "cancelled",
    sequence: number,
  ): (fold: ProjectionFold) => FoldMutation
} = Function.dual(
  4,
  (
    fold: ProjectionFold,
    childId: string,
    status: "complete" | "failed" | "cancelled",
    sequence: number,
  ): FoldMutation => {
    const value = owner(fold)
    const change = mutation()
    settleChildInto(value, change, childId, status, sequence, false)
    return result(change)
  },
)

export const applyChildOutcome: {
  (fold: ProjectionFold, childId: string, outcome: NonNullable<Unit["executionOutcome"]>): FoldMutation
  (childId: string, outcome: NonNullable<Unit["executionOutcome"]>): (fold: ProjectionFold) => FoldMutation
} = Function.dual(
  3,
  (fold: ProjectionFold, childId: string, outcome: NonNullable<Unit["executionOutcome"]>): FoldMutation => {
    const value = owner(fold)
    const change = mutation()
    const childKey = executionKey(childId)
    const previous = value.childOutcomes.get(childKey)
    if (previous !== undefined) {
      const parsed = childScopeAndCallId(previous.childId)
      if (parsed !== undefined)
        removeIndex(
          value.childOutcomesByScopeCall,
          identityKey("agent-scope-call", parsed.scope, parsed.callId),
          childKey,
        )
    }
    value.childOutcomes.set(childKey, { childId, outcome })
    const parsed = childScopeAndCallId(childId)
    if (parsed !== undefined)
      addIndex(value.childOutcomesByScopeCall, identityKey("agent-scope-call", parsed.scope, parsed.callId), childKey)
    settleChildInto(value, change, childId, outcome.status, value.state.revision, true)
    return result(change)
  },
)

export const applyAncestorOutcome: {
  (
    fold: ProjectionFold,
    outcome: NonNullable<Unit["executionOutcome"]> & { readonly status: "failed" | "cancelled" },
  ): FoldMutation
  (
    outcome: NonNullable<Unit["executionOutcome"]> & { readonly status: "failed" | "cancelled" },
  ): (fold: ProjectionFold) => FoldMutation
} = Function.dual(
  2,
  (
    fold: ProjectionFold,
    outcome: NonNullable<Unit["executionOutcome"]> & { readonly status: "failed" | "cancelled" },
  ): FoldMutation => {
    const value = owner(fold)
    const change = mutation()
    settleRunningInto(value, change, outcome.status, value.state.revision)
    return result(change)
  },
)

export const foldExecutionOutcome = (fold: ProjectionFold): NonNullable<Unit["executionOutcome"]> | undefined => {
  const value = owner(fold)
  const unit = firstIndexedUnit(value, value.outcomeUnits)
  return unit?.executionOutcome
}

export const foldHasRunningUnits = (fold: ProjectionFold): boolean => owner(fold).runningUnits.size > 0

export const parentToolForChild: {
  (fold: ProjectionFold, turnId: string, childId: string): Unit | undefined
  (turnId: string, childId: string): (fold: ProjectionFold) => Unit | undefined
} = Function.dual(3, (fold: ProjectionFold, turnId: string, childId: string): Unit | undefined =>
  linkedToolUnitFor(owner(fold), turnId, childId, ""),
)

export const snapshotFoldState = (fold: ProjectionFold): ProjectionState => {
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

export const snapshotFoldProjection = (fold: ProjectionFold): Projection => {
  const value = owner(fold)
  return { ...snapshotFoldState(fold), units: sortedUnits(value) }
}

export const foldUnit: {
  (fold: ProjectionFold, key: string): Unit | undefined
  (key: string): (fold: ProjectionFold) => Unit | undefined
} = Function.dual(2, (fold: ProjectionFold, key: string): Unit | undefined => {
  const value = owner(fold)
  value.observer?.unitLookup?.(key)
  return value.units.get(key)
})

export const foldUnits = (fold: ProjectionFold): ReadonlyArray<Unit> => sortedUnits(owner(fold))
