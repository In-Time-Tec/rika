import { ExecutionStatus } from "@rika/tools"
import type * as ExecutionBackend from "@rika/runtime/contract"
import * as Transcript from "@rika/transcript"
import { Duration, Function, Result, Schema } from "effect"

export interface RootExecution {
  readonly threadId: string
  readonly turnId: string
}

export interface Totals {
  readonly costUsd: number
  readonly pricedAttempts: number
  readonly unpricedAttempts: number
  readonly tokens: number
  readonly countedAttempts: number
  readonly uncountedAttempts: number
}

export const noTotals: Totals = {
  costUsd: 0,
  pricedAttempts: 0,
  unpricedAttempts: 0,
  tokens: 0,
  countedAttempts: 0,
  uncountedAttempts: 0,
}

export interface ContextReading {
  readonly inputTokens: number
  readonly sequence: number
  readonly modelCallId: string
  readonly modelAttemptId: string
  readonly attempt: number
}

export interface Snapshot {
  readonly turns: ReadonlyMap<string, Totals>
  readonly threads: ReadonlyMap<string, Totals>
  readonly global: Totals
  readonly deliveries: ReadonlyMap<string, DeliveryIdentity>
  readonly attempts: ReadonlyMap<string, AttemptCost>
  readonly executionAttempts: ReadonlyMap<string, ReadonlySet<string>>
  readonly executionContexts: ReadonlyMap<string, ContextReading>
  readonly activeEvents: ReadonlyMap<string, ActiveEvent>
  readonly executionEvents: ReadonlyMap<string, ReadonlyArray<ActiveEvent>>
}

interface DeliveryIdentity {
  readonly threadId: string
  readonly turnId: string
  readonly type: string
  readonly createdAt: number
  readonly sequence: number
  readonly data: string
}

export type ProjectionFailureReason =
  | "missing-server-stamp"
  | "invalid-identity"
  | "invalid-timestamp"
  | "invalid-sequence"
  | "cursor-conflict"
  | "duplicate-sequence"
  | "timestamp-regression"
  | "invalid-transition"
  | "post-terminal"
  | "unsupported-version"
  | "decode-failure"

export class ProjectionFailure extends Schema.TaggedErrorClass<ProjectionFailure>()("UsageProjectionFailure", {
  message: Schema.String,
  reason: Schema.Literals([
    "missing-server-stamp",
    "invalid-identity",
    "invalid-timestamp",
    "invalid-sequence",
    "cursor-conflict",
    "duplicate-sequence",
    "timestamp-regression",
    "invalid-transition",
    "post-terminal",
    "unsupported-version",
    "decode-failure",
  ]),
  field: Schema.optional(Schema.String),
  threadId: Schema.optional(Schema.String),
  turnId: Schema.optional(Schema.String),
  executionId: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.String),
  sequence: Schema.optional(Schema.Finite),
}) {}

export interface ActiveTime {
  readonly accumulated: Duration.Duration
  readonly activeSince?: number
}

export type ActiveTimeAvailability = ({ readonly _tag: "Available" } & ActiveTime) | { readonly _tag: "Unavailable" }

interface ActiveEvent {
  readonly key: string
  readonly executionId: string
  readonly threadId: string
  readonly turnId: string
  readonly type: ActiveEventType
  readonly createdAt: number
  readonly sequence: number
}

type ActiveEventType =
  | "execution.accepted"
  | "execution.started"
  | "wait.created"
  | "wait.woken"
  | "wait.timed_out"
  | "execution.completed"
  | "execution.failed"
  | "execution.cancelled"

export type UnpriceableReason =
  | "attempt-failed"
  | "settled-without-usage"
  | "usage-unpriceable"
  | "cost-conflict"
  | "provider-cost-malformed"
  | "execution-unreadable"
  | "delivery-malformed"

export type UncountableReason =
  | "attempt-failed"
  | "settled-without-usage"
  | "usage-uncountable"
  | "token-conflict"
  | "execution-unreadable"
  | "delivery-malformed"

export type SettlementReason = "attempt-failed" | "settled-without-usage"

export type AttemptPricing =
  | { readonly _tag: "Announced" }
  | { readonly _tag: "Priced"; readonly usd: number; readonly source: "provider" }
  | { readonly _tag: "Unpriceable"; readonly reason: UnpriceableReason }

export type AttemptTokens =
  | { readonly _tag: "Announced" }
  | { readonly _tag: "Counted"; readonly total: number }
  | { readonly _tag: "Uncounted"; readonly reason: UncountableReason }

export interface AttemptCost {
  readonly threadId: string
  readonly turnId: string
  readonly cost: AttemptPricing
  readonly tokens: AttemptTokens
}

export const foldVersion = 7

export const empty: Snapshot = {
  turns: new Map(),
  threads: new Map(),
  global: noTotals,
  deliveries: new Map(),
  attempts: new Map(),
  executionAttempts: new Map(),
  executionContexts: new Map(),
  activeEvents: new Map(),
  executionEvents: new Map(),
}

declare const UsageFoldType: unique symbol

export interface UsageFold {
  readonly [UsageFoldType]: typeof UsageFoldType
}

interface MutableUsage {
  turns: Map<string, Totals>
  threads: Map<string, Totals>
  global: Totals
  deliveries: Map<string, DeliveryIdentity>
  attempts: Map<string, AttemptCost>
  executionAttempts: Map<string, Set<string>>
  executionContexts: Map<string, ContextReading>
  activeEvents: Map<string, ActiveEvent>
  executionEvents: Map<string, Array<ActiveEvent>>
}

interface UsageChanged {
  turns: boolean
  threads: boolean
  global: boolean
  deliveries: boolean
  attempts: boolean
  executionAttempts: boolean
  executionContexts: boolean
  activeEvents: boolean
  executionEvents: boolean
}

interface OwnedUsageFold {
  published: Snapshot
  mutable: MutableUsage
  changed: UsageChanged
}

const usageOwned = new WeakMap<UsageFold, OwnedUsageFold>()
const snapshotToFold = new WeakMap<Snapshot, UsageFold>()

const usageOwner = (fold: UsageFold): OwnedUsageFold => {
  const value = usageOwned.get(fold)
  if (value === undefined) throw new TypeError("Unknown usage fold")
  return value
}

const cloneExecutionAttempts = (source: ReadonlyMap<string, ReadonlySet<string>>) =>
  new Map([...source].map(([key, values]) => [key, new Set(values)]))

const cloneExecutionEvents = (source: ReadonlyMap<string, ReadonlyArray<ActiveEvent>>) =>
  new Map([...source].map(([key, values]) => [key, [...values]]))

const mutableFromSnapshot = (snapshot: Snapshot): MutableUsage => ({
  turns: new Map(snapshot.turns),
  threads: new Map(snapshot.threads),
  global: { ...snapshot.global },
  deliveries: new Map(snapshot.deliveries),
  attempts: new Map(snapshot.attempts),
  executionAttempts: cloneExecutionAttempts(snapshot.executionAttempts),
  executionContexts: new Map(snapshot.executionContexts),
  activeEvents: new Map(snapshot.activeEvents),
  executionEvents: cloneExecutionEvents(snapshot.executionEvents),
})

const unchangedUsageChanged = (): UsageChanged => ({
  turns: false,
  threads: false,
  global: false,
  deliveries: false,
  attempts: false,
  executionAttempts: false,
  executionContexts: false,
  activeEvents: false,
  executionEvents: false,
})

const makeUsageFold = (snapshot: Snapshot, trackSnapshot: boolean): UsageFold => {
  const fold = {} as UsageFold
  usageOwned.set(fold, {
    published: snapshot,
    mutable: mutableFromSnapshot(snapshot),
    changed: unchangedUsageChanged(),
  })
  if (trackSnapshot) snapshotToFold.set(snapshot, fold)
  return fold
}

export const restoreUsageFold: {
  (snapshot: Snapshot): UsageFold
  (): (snapshot: Snapshot) => UsageFold
} = Function.dual(
  (args) => typeof args[0] === "object" && args[0] !== null && "turns" in args[0],
  (snapshot: Snapshot): UsageFold => {
    if (snapshot === empty) return makeUsageFold(snapshot, false)
    const existing = snapshotToFold.get(snapshot)
    if (existing !== undefined) return existing
    return makeUsageFold(snapshot, true)
  },
)

const freshUsageFold = (snapshot: Snapshot): UsageFold => makeUsageFold(snapshot, false)

export const usageFoldChanged = (fold: UsageFold): boolean => {
  const changed = usageOwner(fold).changed
  return (
    changed.turns ||
    changed.threads ||
    changed.global ||
    changed.deliveries ||
    changed.attempts ||
    changed.executionAttempts ||
    changed.executionContexts ||
    changed.activeEvents ||
    changed.executionEvents
  )
}

export const snapshotUsageFold = (fold: UsageFold): Snapshot => {
  const value = usageOwner(fold)
  if (!usageFoldChanged(fold)) return value.published
  const snap: Snapshot = {
    turns: value.changed.turns ? new Map(value.mutable.turns) : value.published.turns,
    threads: value.changed.threads ? new Map(value.mutable.threads) : value.published.threads,
    global: value.changed.global ? { ...value.mutable.global } : value.published.global,
    deliveries: value.changed.deliveries ? new Map(value.mutable.deliveries) : value.published.deliveries,
    attempts: value.changed.attempts ? new Map(value.mutable.attempts) : value.published.attempts,
    executionAttempts: value.changed.executionAttempts
      ? cloneExecutionAttempts(value.mutable.executionAttempts)
      : value.published.executionAttempts,
    executionContexts: value.changed.executionContexts
      ? new Map(value.mutable.executionContexts)
      : value.published.executionContexts,
    activeEvents: value.changed.activeEvents ? new Map(value.mutable.activeEvents) : value.published.activeEvents,
    executionEvents: value.changed.executionEvents
      ? cloneExecutionEvents(value.mutable.executionEvents)
      : value.published.executionEvents,
  }
  value.published = snap
  value.changed = unchangedUsageChanged()
  snapshotToFold.set(snap, fold)
  return snap
}

type SerializedSnapshot = {
  readonly version: number
  readonly turns: ReadonlyArray<readonly [string, Totals]>
  readonly threads: ReadonlyArray<readonly [string, Totals]>
  readonly global: Totals
  readonly deliveries: ReadonlyArray<readonly [string, DeliveryIdentity]>
  readonly attempts: ReadonlyArray<readonly [string, AttemptCost]>
  readonly executionAttempts: ReadonlyArray<readonly [string, ReadonlyArray<string>]>
  readonly executionContexts: ReadonlyArray<readonly [string, ContextReading]>
  readonly activeEvents: ReadonlyArray<readonly [string, ActiveEvent]>
  readonly executionEvents: ReadonlyArray<readonly [string, ReadonlyArray<ActiveEvent>]>
}

export const serialize = (snapshot: Snapshot): string =>
  JSON.stringify({
    version: foldVersion,
    turns: [...snapshot.turns],
    threads: [...snapshot.threads],
    global: snapshot.global,
    deliveries: [...snapshot.deliveries],
    attempts: [...snapshot.attempts],
    executionAttempts: [...snapshot.executionAttempts].map(([key, values]) => [key, [...values]]),
    executionContexts: [...snapshot.executionContexts],
    activeEvents: [...snapshot.activeEvents],
    executionEvents: [...snapshot.executionEvents],
  } satisfies SerializedSnapshot)

export const deserialize = (json: string): Result.Result<Snapshot, ProjectionFailure> => {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return Result.fail(ProjectionFailure.make({ reason: "decode-failure", message: "Snapshot is not valid JSON" }))
  }
  if (!isRecord(value) || value.version !== foldVersion)
    return Result.fail(
      ProjectionFailure.make({ reason: "unsupported-version", message: "Snapshot fold version is unsupported" }),
    )
  if (!isSerializedSnapshot(value))
    return Result.fail(
      ProjectionFailure.make({ reason: "decode-failure", message: "Snapshot has malformed nested state" }),
    )
  try {
    return Result.succeed({
      turns: new Map(value.turns),
      threads: new Map(value.threads),
      global: value.global,
      deliveries: new Map(value.deliveries),
      attempts: new Map(value.attempts),
      executionAttempts: new Map(value.executionAttempts.map(([key, values]) => [key, new Set(values)])),
      executionContexts: new Map(value.executionContexts),
      activeEvents: new Map(value.activeEvents),
      executionEvents: new Map(value.executionEvents),
    })
  } catch {
    return Result.fail(
      ProjectionFailure.make({ reason: "decode-failure", message: "Snapshot map entries are invalid" }),
    )
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const isString = (value: unknown): value is string => typeof value === "string"
const isTuple = (value: unknown): value is readonly [unknown, unknown] => Array.isArray(value) && value.length === 2
const isEntries = (value: unknown, check: (value: unknown) => boolean): boolean =>
  Array.isArray(value) && value.every((entry) => isTuple(entry) && isString(entry[0]) && check(entry[1]))
const isTotals = (value: unknown): value is Totals =>
  isRecord(value) &&
  ["costUsd", "pricedAttempts", "unpricedAttempts", "tokens", "countedAttempts", "uncountedAttempts"].every((key) =>
    isFiniteNumber(value[key]),
  )
const isDelivery = (value: unknown): value is DeliveryIdentity =>
  isRecord(value) &&
  isString(value.threadId) &&
  isString(value.turnId) &&
  isString(value.type) &&
  isFiniteNumber(value.createdAt) &&
  isFiniteNumber(value.sequence) &&
  isString(value.data)
const isPricing = (value: unknown): value is AttemptPricing =>
  isRecord(value) &&
  (value._tag === "Announced" ||
    (value._tag === "Priced" && isFiniteNumber(value.usd) && value.source === "provider") ||
    (value._tag === "Unpriceable" && isString(value.reason)))
const isTokens = (value: unknown): value is AttemptTokens =>
  isRecord(value) &&
  (value._tag === "Announced" ||
    (value._tag === "Counted" && isFiniteNumber(value.total)) ||
    (value._tag === "Uncounted" && isString(value.reason)))
const isAttempt = (value: unknown): value is AttemptCost =>
  isRecord(value) &&
  isString(value.threadId) &&
  isString(value.turnId) &&
  isPricing(value.cost) &&
  isTokens(value.tokens)
const isContextReading = (value: unknown): value is ContextReading =>
  isRecord(value) &&
  isFiniteNumber(value.inputTokens) &&
  isFiniteNumber(value.sequence) &&
  isString(value.modelCallId) &&
  isString(value.modelAttemptId) &&
  isFiniteNumber(value.attempt)
const isActiveEvent = (value: unknown): value is ActiveEvent =>
  isRecord(value) &&
  isString(value.key) &&
  isString(value.executionId) &&
  isString(value.threadId) &&
  isString(value.turnId) &&
  isString(value.type) &&
  activeEventTypes.has(value.type) &&
  isFiniteNumber(value.createdAt) &&
  isFiniteNumber(value.sequence)
const isSerializedSnapshot = (value: Readonly<Record<string, unknown>>): value is SerializedSnapshot =>
  isEntries(value.turns, isTotals) &&
  isEntries(value.threads, isTotals) &&
  isTotals(value.global) &&
  isEntries(value.deliveries, isDelivery) &&
  isEntries(value.attempts, isAttempt) &&
  isEntries(value.executionAttempts, (item) => Array.isArray(item) && item.every(isString)) &&
  isEntries(value.executionContexts, isContextReading) &&
  isEntries(value.activeEvents, isActiveEvent) &&
  isEntries(value.executionEvents, (item) => Array.isArray(item) && item.every(isActiveEvent))

export const materialize: {
  (
    turnId: string,
    threadId: string,
  ): (snapshot: Snapshot) => {
    readonly costNanoUsd?: number
    readonly tokens?: number
    readonly activeMillis?: number
    readonly activeIntervals?: ReadonlyArray<Interval>
    readonly pricedAttempts: number
    readonly unpricedAttempts: number
    readonly countedAttempts: number
    readonly uncountedAttempts: number
    readonly sourceComplete: false
  }
  (
    snapshot: Snapshot,
    turnId: string,
    threadId: string,
  ): {
    readonly costNanoUsd?: number
    readonly tokens?: number
    readonly activeMillis?: number
    readonly activeIntervals?: ReadonlyArray<Interval>
    readonly pricedAttempts: number
    readonly unpricedAttempts: number
    readonly countedAttempts: number
    readonly uncountedAttempts: number
    readonly sourceComplete: false
  }
} = Function.dual(3, (snapshot: Snapshot, turnId: string, threadId: string) => {
  const totals = turnTotals(snapshot, turnId)
  const time = activeTime(snapshot, threadId)
  const intervals = activeIntervals(snapshot, threadId)
  return {
    ...(totals.pricedAttempts + totals.unpricedAttempts === 0
      ? {}
      : { costNanoUsd: Math.round(totals.costUsd * 1_000_000_000) }),
    ...(totals.countedAttempts + totals.uncountedAttempts === 0 ? {} : { tokens: totals.tokens }),
    ...(time._tag === "Unavailable" ? {} : { activeMillis: Math.round(Duration.toMillis(time.accumulated)) }),
    ...(intervals === undefined ? {} : { activeIntervals: intervals }),
    pricedAttempts: totals.pricedAttempts,
    unpricedAttempts: totals.unpricedAttempts,
    countedAttempts: totals.countedAttempts,
    uncountedAttempts: totals.uncountedAttempts,
    sourceComplete: false as const,
  }
})

const activeEventTypes = new Set<string>([
  "execution.accepted",
  "execution.started",
  "wait.created",
  "wait.woken",
  "wait.timed_out",
  "execution.completed",
  "execution.failed",
  "execution.cancelled",
])

const attemptEventTypes = new Set<string>(["model.usage.reported", "model.attempt.completed", "model.attempt.failed"])

export const isObservedEvent = (event: ExecutionBackend.Event): boolean =>
  activeEventTypes.has(event.type) || attemptEventTypes.has(event.type)

export const isLifecycleEvent = (event: ExecutionBackend.Event): boolean => activeEventTypes.has(event.type)

export const isServerStamped = (event: ExecutionBackend.Event): boolean => event.timestampSource === "server"

const isActiveEventType = (type: string): type is ActiveEventType => activeEventTypes.has(type)

const isTerminalEventType = (type: ActiveEventType): boolean => ExecutionStatus.isTerminalEventType(type)

export interface Interval {
  readonly start: number
  readonly end?: number
}

const executionIntervals = (events: ReadonlyArray<ActiveEvent>): ReadonlyArray<Interval> | undefined => {
  const ordered = events.toSorted(
    (left, right) => left.sequence - right.sequence || left.type.localeCompare(right.type),
  )
  const intervals: Array<Interval> = []
  let activeSince: number | undefined
  let accepted = false
  let started = false
  let terminal = false
  let previousSequence: number | undefined
  let previousCreatedAt: number | undefined
  for (const event of ordered) {
    if (previousSequence === event.sequence || (previousCreatedAt !== undefined && event.createdAt < previousCreatedAt))
      return undefined
    previousSequence = event.sequence
    previousCreatedAt = event.createdAt
    if (terminal) return undefined
    if (event.type === "execution.accepted") {
      if (accepted || started) return undefined
      accepted = true
      continue
    }
    if (event.type === "execution.started") {
      if (activeSince !== undefined) return undefined
      started = true
      activeSince = event.createdAt
      continue
    }
    if (!started) {
      if (accepted && isTerminalEventType(event.type)) {
        terminal = true
        continue
      }
      return undefined
    }
    if (event.type === "wait.woken" || event.type === "wait.timed_out") {
      if (activeSince !== undefined) return undefined
      activeSince = event.createdAt
      continue
    }
    if (activeSince !== undefined) {
      intervals.push({ start: activeSince, end: event.createdAt })
      activeSince = undefined
    }
    if (isTerminalEventType(event.type)) terminal = true
  }
  if (activeSince !== undefined) intervals.push({ start: activeSince })
  return intervals
}

const lifecycleFailure = (events: ReadonlyArray<ActiveEvent>): ProjectionFailureReason | undefined => {
  let state: "initial" | "accepted" | "active" | "waiting" | "terminal" = "initial"
  for (const event of events) {
    if (state === "terminal") return "post-terminal"
    if (event.type === "execution.accepted") {
      if (state !== "initial") return "invalid-transition"
      state = "accepted"
    } else if (event.type === "execution.started") {
      if (state !== "initial" && state !== "accepted" && state !== "waiting") return "invalid-transition"
      state = "active"
    } else if (event.type === "wait.created") {
      if (state !== "active") return "invalid-transition"
      state = "waiting"
    } else if (event.type === "wait.woken" || event.type === "wait.timed_out") {
      if (state !== "waiting") return "invalid-transition"
      state = "active"
    } else {
      state = "terminal"
    }
  }
  return undefined
}

const unionIntervals = (intervals: ReadonlyArray<Interval>): ActiveTime => {
  const ordered = intervals.toSorted(
    (left, right) => left.start - right.start || (left.end ?? Infinity) - (right.end ?? Infinity),
  )
  let accumulated = Duration.zero
  let currentStart: number | undefined
  let currentEnd: number | undefined
  for (const interval of ordered) {
    if (currentStart === undefined) {
      currentStart = interval.start
      currentEnd = interval.end
      continue
    }
    if (currentEnd === undefined) continue
    if (interval.start <= currentEnd) {
      currentEnd = interval.end === undefined ? undefined : Math.max(currentEnd, interval.end)
      continue
    }
    accumulated = Duration.sum(accumulated, Duration.millis(currentEnd - currentStart))
    currentStart = interval.start
    currentEnd = interval.end
  }
  if (currentStart === undefined) return { accumulated }
  if (currentEnd === undefined) return { accumulated, activeSince: currentStart }
  return { accumulated: Duration.sum(accumulated, Duration.millis(currentEnd - currentStart)) }
}

const activeIntervals = (snapshot: Snapshot, threadId: string): ReadonlyArray<Interval> | undefined => {
  const executions = new Map<string, Array<ActiveEvent>>()
  for (const event of snapshot.activeEvents.values()) {
    if (event.threadId !== threadId) continue
    const group = executions.get(event.executionId)
    if (group === undefined) executions.set(event.executionId, [event])
    else group.push(event)
  }
  const intervals: Array<Interval> = []
  let known = false
  for (const events of executions.values()) {
    const execution = executionIntervals(events)
    if (execution === undefined) continue
    known = true
    intervals.push(...execution)
  }
  return known ? intervals : undefined
}

export const activeTime: {
  (snapshot: Snapshot, threadId: string): ActiveTimeAvailability
  (threadId: string): (snapshot: Snapshot) => ActiveTimeAvailability
} = Function.dual(2, (snapshot: Snapshot, threadId: string): ActiveTimeAvailability => {
  const intervals = activeIntervals(snapshot, threadId)
  return intervals === undefined ? { _tag: "Unavailable" } : { _tag: "Available", ...unionIntervals(intervals) }
})

const stringField = (data: Readonly<Record<string, unknown>> | undefined, name: string) => {
  const value = data?.[name]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

const integerField = (data: Readonly<Record<string, unknown>> | undefined, name: string) => {
  const value = data?.[name]
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

const isConversationCall = (modelCallId: string): boolean =>
  !modelCallId.endsWith(":compaction-summary") && !modelCallId.endsWith(":structured-output")

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (isRecord(value))
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}

const providerCostUsd = (data: Readonly<Record<string, unknown>>): number | undefined => {
  const cost = data.cost
  const valid =
    cost !== null &&
    typeof cost === "object" &&
    typeof (cost as { amount?: unknown }).amount === "number" &&
    Number.isFinite((cost as { amount: number }).amount) &&
    (cost as { amount: number }).amount >= 0 &&
    (cost as { currency?: unknown }).currency === "USD"
  return valid ? (cost as { amount: number }).amount : undefined
}

const settledWithoutUsage = (reason: UnpriceableReason | UncountableReason): boolean =>
  reason === "settled-without-usage" || reason === "attempt-failed"

const revisableCost = (reason: UnpriceableReason): boolean =>
  settledWithoutUsage(reason) || reason === "usage-unpriceable"

const revisableTokens = (reason: UncountableReason): boolean => settledWithoutUsage(reason)

const providerPriced = (cost: AttemptPricing, usd: number): AttemptPricing => {
  if (cost._tag === "Priced" && cost.source === "provider" && cost.usd !== usd)
    return { _tag: "Unpriceable", reason: "cost-conflict" }
  if (cost._tag === "Unpriceable" && !revisableCost(cost.reason)) return cost
  return { _tag: "Priced", usd, source: "provider" }
}

const unpriceable = (cost: AttemptPricing, reason: UnpriceableReason): AttemptPricing => {
  if (cost._tag === "Priced" && cost.source === "provider") return cost
  if (cost._tag === "Unpriceable" && !revisableCost(cost.reason)) return cost
  return { _tag: "Unpriceable", reason }
}

const countedTokens = (tokens: AttemptTokens, total: number): AttemptTokens => {
  if (tokens._tag === "Counted")
    return tokens.total === total ? tokens : { _tag: "Uncounted", reason: "token-conflict" }
  if (tokens._tag === "Uncounted" && !revisableTokens(tokens.reason)) return tokens
  return { _tag: "Counted", total }
}

const uncountable = (tokens: AttemptTokens, reason: UncountableReason): AttemptTokens =>
  tokens._tag === "Uncounted" && !revisableTokens(tokens.reason) ? tokens : { _tag: "Uncounted", reason }

const settle = (attempt: AttemptCost, reason: SettlementReason): AttemptCost =>
  attempt.cost._tag !== "Announced" && attempt.tokens._tag !== "Announced"
    ? attempt
    : {
        ...attempt,
        cost: attempt.cost._tag === "Announced" ? { _tag: "Unpriceable", reason } : attempt.cost,
        tokens: attempt.tokens._tag === "Announced" ? { _tag: "Uncounted", reason } : attempt.tokens,
      }

const contribution = (attempt: AttemptCost): Totals => ({
  costUsd: attempt.cost._tag === "Priced" ? attempt.cost.usd : 0,
  pricedAttempts: attempt.cost._tag === "Priced" ? 1 : 0,
  unpricedAttempts: attempt.cost._tag === "Unpriceable" ? 1 : 0,
  tokens: attempt.tokens._tag === "Counted" ? attempt.tokens.total : 0,
  countedAttempts: attempt.tokens._tag === "Counted" ? 1 : 0,
  uncountedAttempts: attempt.tokens._tag === "Uncounted" ? 1 : 0,
})

const difference = (next: Totals, previous: Totals): Totals => ({
  costUsd: next.costUsd - previous.costUsd,
  pricedAttempts: next.pricedAttempts - previous.pricedAttempts,
  unpricedAttempts: next.unpricedAttempts - previous.unpricedAttempts,
  tokens: next.tokens - previous.tokens,
  countedAttempts: next.countedAttempts - previous.countedAttempts,
  uncountedAttempts: next.uncountedAttempts - previous.uncountedAttempts,
})

const shifts = (delta: Totals): boolean =>
  delta.costUsd !== 0 ||
  delta.pricedAttempts !== 0 ||
  delta.unpricedAttempts !== 0 ||
  delta.tokens !== 0 ||
  delta.countedAttempts !== 0 ||
  delta.uncountedAttempts !== 0

const accumulate = (left: Totals, right: Totals): Totals => ({
  costUsd: left.costUsd + right.costUsd,
  pricedAttempts: left.pricedAttempts + right.pricedAttempts,
  unpricedAttempts: left.unpricedAttempts + right.unpricedAttempts,
  tokens: left.tokens + right.tokens,
  countedAttempts: left.countedAttempts + right.countedAttempts,
  uncountedAttempts: left.uncountedAttempts + right.uncountedAttempts,
})

const unreadableKey = (key: string) => `unreadable\u0000${key}`

export const turnTotals: {
  (snapshot: Snapshot, turnId: string): Totals
  (turnId: string): (snapshot: Snapshot) => Totals
} = Function.dual(2, (snapshot: Snapshot, turnId: string): Totals => snapshot.turns.get(turnId) ?? noTotals)

export const threadTotals: {
  (snapshot: Snapshot, threadId: string): Totals
  (threadId: string): (snapshot: Snapshot) => Totals
} = Function.dual(2, (snapshot: Snapshot, threadId: string): Totals => snapshot.threads.get(threadId) ?? noTotals)

export const executionContext: {
  (snapshot: Snapshot, executionId: string): ContextReading | undefined
  (executionId: string): (snapshot: Snapshot) => ContextReading | undefined
} = Function.dual(2, (snapshot: Snapshot, executionId: string): ContextReading | undefined =>
  snapshot.executionContexts.get(Transcript.executionKey(executionId)),
)

const addScopeMutable = (scope: Map<string, Totals>, key: string, delta: Totals): void => {
  scope.set(key, accumulate(scope.get(key) ?? noTotals, delta))
}

const writeAttemptMutable = (
  value: OwnedUsageFold,
  executionId: string | undefined,
  attemptKey: string,
  previous: AttemptCost | undefined,
  next: AttemptCost,
): void => {
  if (previous === next) return
  value.mutable.attempts.set(attemptKey, next)
  value.changed.attempts = true
  if (executionId !== undefined) {
    const existingKeys = value.mutable.executionAttempts.get(executionId)
    if (existingKeys === undefined || !existingKeys.has(attemptKey)) {
      const keys = existingKeys ?? new Set<string>()
      keys.add(attemptKey)
      value.mutable.executionAttempts.set(executionId, keys)
      value.changed.executionAttempts = true
    }
  }
  const delta = difference(contribution(next), previous === undefined ? noTotals : contribution(previous))
  if (!shifts(delta)) return
  addScopeMutable(value.mutable.turns, next.turnId, delta)
  addScopeMutable(value.mutable.threads, next.threadId, delta)
  value.mutable.global = accumulate(value.mutable.global, delta)
  value.changed.turns = true
  value.changed.threads = true
  value.changed.global = true
}

const settleExecutionMutable = (value: OwnedUsageFold, executionId: string, reason: SettlementReason): void => {
  const attemptKeys = value.mutable.executionAttempts.get(executionId)
  if (attemptKeys === undefined) return
  for (const attemptKey of attemptKeys) {
    const previous = value.mutable.attempts.get(attemptKey)
    if (previous === undefined) continue
    writeAttemptMutable(value, executionId, attemptKey, previous, settle(previous, reason))
  }
}

const unreadableMutable = (
  value: OwnedUsageFold,
  input: RootExecution,
  key: string,
  reason: UnpriceableReason & UncountableReason,
): void => {
  const attemptKey = unreadableKey(key)
  writeAttemptMutable(value, undefined, attemptKey, value.mutable.attempts.get(attemptKey), {
    threadId: input.threadId,
    turnId: input.turnId,
    cost: { _tag: "Unpriceable", reason },
    tokens: { _tag: "Uncounted", reason },
  })
}

const applyActive = (
  value: OwnedUsageFold,
  input: RootExecution & { readonly event: ExecutionBackend.Event },
): Result.Result<void, ProjectionFailure> => {
  const event = input.event
  if (!isActiveEventType(event.type)) return Result.succeed(undefined)
  const context = {
    threadId: input.threadId,
    turnId: input.turnId,
    executionId: event.executionId,
    cursor: event.cursor,
    sequence: event.sequence,
  }
  if (!isServerStamped(event))
    return Result.fail(
      ProjectionFailure.make({
        reason: "missing-server-stamp",
        message: "Lifecycle event lacks a server timestamp",
        ...context,
      }),
    )
  if (event.executionId.length === 0)
    return Result.fail(
      ProjectionFailure.make({
        reason: "invalid-identity",
        message: "Execution identity is empty",
        field: "executionId",
        ...context,
      }),
    )
  if (event.cursor.length === 0)
    return Result.fail(
      ProjectionFailure.make({
        reason: "invalid-identity",
        message: "Event cursor is empty",
        field: "cursor",
        ...context,
      }),
    )
  if (!Number.isSafeInteger(event.createdAt) || event.createdAt < 0)
    return Result.fail(
      ProjectionFailure.make({ reason: "invalid-timestamp", message: "Lifecycle timestamp is invalid", ...context }),
    )
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 0)
    return Result.fail(
      ProjectionFailure.make({ reason: "invalid-sequence", message: "Lifecycle sequence is invalid", ...context }),
    )
  const key = `${event.executionId}\u0000${event.cursor}`
  const previous = value.mutable.activeEvents.get(key)
  if (previous !== undefined) {
    const exact =
      previous.threadId === input.threadId &&
      previous.turnId === input.turnId &&
      previous.type === event.type &&
      previous.createdAt === event.createdAt &&
      previous.sequence === event.sequence
    return exact
      ? Result.succeed(undefined)
      : Result.fail(
          ProjectionFailure.make({
            reason: "cursor-conflict",
            message: "Lifecycle cursor has conflicting ownership or content",
            ...context,
          }),
        )
  }
  const executionEvents = value.mutable.executionEvents.get(event.executionId) ?? []
  const insertion = executionEvents.findIndex((item) => item.sequence >= event.sequence)
  const index = insertion < 0 ? executionEvents.length : insertion
  const sameSequence = executionEvents[index]?.sequence === event.sequence
  if (sameSequence)
    return Result.fail(
      ProjectionFailure.make({
        reason: "duplicate-sequence",
        message: "Lifecycle sequence is already occupied",
        ...context,
      }),
    )
  const before = executionEvents[index - 1]
  const after = executionEvents[index]
  if (
    (before !== undefined && before.createdAt > event.createdAt) ||
    (after !== undefined && after.createdAt < event.createdAt)
  )
    return Result.fail(
      ProjectionFailure.make({
        reason: "timestamp-regression",
        message: "Lifecycle timestamp regresses relative to its sequence",
        ...context,
      }),
    )
  const activeEvent: ActiveEvent = {
    key,
    executionId: event.executionId,
    threadId: input.threadId,
    turnId: input.turnId,
    type: event.type,
    createdAt: event.createdAt,
    sequence: event.sequence,
  }
  const nextExecutionEvents = [...executionEvents.slice(0, index), activeEvent, ...executionEvents.slice(index)]
  const invalid = lifecycleFailure(nextExecutionEvents)
  if (invalid !== undefined && executionEvents.length > 0 && index === executionEvents.length)
    return Result.fail(
      ProjectionFailure.make({
        reason: invalid,
        message: "Lifecycle event is not valid in execution sequence",
        ...context,
      }),
    )
  value.mutable.activeEvents.set(key, activeEvent)
  value.changed.activeEvents = true
  let events = value.mutable.executionEvents.get(event.executionId)
  if (events === undefined) {
    events = []
    value.mutable.executionEvents.set(event.executionId, events)
  }
  events.splice(index, 0, activeEvent)
  value.changed.executionEvents = true
  return Result.succeed(undefined)
}

const applyAttempt = (
  value: OwnedUsageFold,
  input: RootExecution & { readonly event: ExecutionBackend.Event },
): Result.Result<void, ProjectionFailure> => {
  const event = input.event
  if (event.executionId.length === 0)
    return Result.fail(
      ProjectionFailure.make({
        reason: "invalid-identity",
        message: "Execution identity is empty",
        field: "executionId",
        threadId: input.threadId,
        turnId: input.turnId,
        executionId: event.executionId,
        cursor: event.cursor,
        sequence: event.sequence,
      }),
    )
  if (event.cursor.length === 0)
    return Result.fail(
      ProjectionFailure.make({
        reason: "invalid-identity",
        message: "Event cursor is empty",
        field: "cursor",
        threadId: input.threadId,
        turnId: input.turnId,
        executionId: event.executionId,
        cursor: event.cursor,
        sequence: event.sequence,
      }),
    )
  const deliveryKey = `${event.executionId}\u0000${event.cursor}`
  const identity: DeliveryIdentity = {
    threadId: input.threadId,
    turnId: input.turnId,
    type: event.type,
    createdAt: event.createdAt,
    sequence: event.sequence,
    data: canonicalJson(event.data ?? null),
  }
  const delivered = value.mutable.deliveries.get(deliveryKey)
  if (delivered !== undefined)
    return delivered.threadId === identity.threadId &&
      delivered.turnId === identity.turnId &&
      delivered.type === identity.type &&
      delivered.createdAt === identity.createdAt &&
      delivered.sequence === identity.sequence &&
      delivered.data === identity.data
      ? Result.succeed(undefined)
      : Result.fail(
          ProjectionFailure.make({
            reason: "cursor-conflict",
            message: "Attempt cursor has conflicting ownership or semantic content",
            threadId: input.threadId,
            turnId: input.turnId,
            executionId: event.executionId,
            cursor: event.cursor,
            sequence: event.sequence,
          }),
        )
  const attemptId = stringField(event.data, "model_attempt_id")
  if (attemptId === undefined) {
    unreadableMutable(value, input, deliveryKey, "delivery-malformed")
    return Result.succeed(undefined)
  }
  const attemptKey = `${event.executionId}\u0000${attemptId}`
  const previous = value.mutable.attempts.get(attemptKey)
  const current: AttemptCost = previous ?? {
    threadId: input.threadId,
    turnId: input.turnId,
    cost: { _tag: "Announced" },
    tokens: { _tag: "Announced" },
  }
  let next = current
  if (event.type === "model.usage.reported") {
    const decoded = Transcript.usageTokens(event.data ?? {})
    next = {
      ...current,
      tokens:
        decoded._tag === "Available"
          ? countedTokens(current.tokens, decoded.total)
          : uncountable(current.tokens, "usage-uncountable"),
    }
    const inputTokens = Transcript.usageInputTokens(event.data ?? {})
    const modelCallId = stringField(event.data, "model_call_id")
    const attempt = integerField(event.data, "attempt")
    if (
      inputTokens._tag === "Available" &&
      modelCallId !== undefined &&
      isConversationCall(modelCallId) &&
      attempt !== undefined &&
      Number.isSafeInteger(event.sequence) &&
      event.sequence >= 0
    ) {
      const reading: ContextReading = {
        inputTokens: inputTokens.total,
        sequence: event.sequence,
        modelCallId,
        modelAttemptId: attemptId,
        attempt,
      }
      const previousReading = value.mutable.executionContexts.get(event.executionId)
      if (previousReading?.sequence === event.sequence && canonicalJson(previousReading) !== canonicalJson(reading))
        return Result.fail(
          ProjectionFailure.make({
            reason: "duplicate-sequence",
            message: "Context usage sequence has conflicting content",
            threadId: input.threadId,
            turnId: input.turnId,
            executionId: event.executionId,
            cursor: event.cursor,
            sequence: event.sequence,
          }),
        )
      if (previousReading === undefined || event.sequence > previousReading.sequence) {
        value.mutable.executionContexts.set(event.executionId, reading)
        value.changed.executionContexts = true
      }
    }
  } else if (event.type === "model.attempt.failed") {
    next = settle(current, "attempt-failed")
  } else if (event.data !== undefined && Object.hasOwn(event.data, "cost")) {
    const amount = providerCostUsd(event.data)
    next = {
      ...current,
      cost:
        amount === undefined
          ? unpriceable(current.cost, "provider-cost-malformed")
          : providerPriced(current.cost, amount),
    }
  }
  writeAttemptMutable(value, event.executionId, attemptKey, previous, next)
  value.mutable.deliveries.set(deliveryKey, identity)
  value.changed.deliveries = true
  return Result.succeed(undefined)
}

export const applyUsageFoldEvent: {
  (
    input: RootExecution & { readonly event: ExecutionBackend.Event },
  ): (fold: UsageFold) => Result.Result<void, ProjectionFailure>
  (
    fold: UsageFold,
    input: RootExecution & { readonly event: ExecutionBackend.Event },
  ): Result.Result<void, ProjectionFailure>
} = Function.dual(
  2,
  (
    fold: UsageFold,
    input: RootExecution & { readonly event: ExecutionBackend.Event },
  ): Result.Result<void, ProjectionFailure> => {
    const executionId = Transcript.executionKey(input.event.executionId)
    const normalized =
      executionId === input.event.executionId ? input : { ...input, event: { ...input.event, executionId } }
    if (Transcript.isTransientEvent(normalized.event)) return Result.succeed(undefined)
    const value = usageOwner(fold)
    if (isActiveEventType(normalized.event.type)) {
      const active = applyActive(value, normalized)
      if (Result.isFailure(active)) return active
      if (isTerminalEventType(normalized.event.type) && normalized.event.executionId.length > 0)
        settleExecutionMutable(value, normalized.event.executionId, "settled-without-usage")
      return Result.succeed(undefined)
    }
    if (!attemptEventTypes.has(normalized.event.type)) return Result.succeed(undefined)
    return applyAttempt(value, normalized)
  },
)

export const observe: {
  (
    input: RootExecution & { readonly event: ExecutionBackend.Event },
  ): (snapshot: Snapshot) => Result.Result<Snapshot, ProjectionFailure>
  (
    snapshot: Snapshot,
    input: RootExecution & { readonly event: ExecutionBackend.Event },
  ): Result.Result<Snapshot, ProjectionFailure>
} = Function.dual(
  2,
  (
    snapshot: Snapshot,
    input: RootExecution & { readonly event: ExecutionBackend.Event },
  ): Result.Result<Snapshot, ProjectionFailure> => {
    const fold = restoreUsageFold(snapshot)
    const applied = applyUsageFoldEvent(fold, input)
    if (Result.isFailure(applied)) return Result.fail(applied.failure)
    return Result.succeed(usageFoldChanged(fold) ? snapshotUsageFold(fold) : snapshot)
  },
)

const isSnapshot = (value: unknown): value is Snapshot =>
  typeof value === "object" && value !== null && "turns" in value && value.turns instanceof Map

export const foldBatch: {
  (
    observations: ReadonlyArray<RootExecution & { readonly event: ExecutionBackend.Event }>,
    completeExecutionIds?: ReadonlySet<string>,
  ): (snapshot: Snapshot) => Result.Result<Snapshot, ProjectionFailure>
  (
    snapshot: Snapshot,
    observations: ReadonlyArray<RootExecution & { readonly event: ExecutionBackend.Event }>,
    completeExecutionIds?: ReadonlySet<string>,
  ): Result.Result<Snapshot, ProjectionFailure>
} = Function.dual(
  (args): boolean => args.length > 0 && isSnapshot(args[0]),
  (
    snapshot: Snapshot,
    observations: ReadonlyArray<RootExecution & { readonly event: ExecutionBackend.Event }>,
    completeExecutionIds: ReadonlySet<string> = new Set(),
  ): Result.Result<Snapshot, ProjectionFailure> => {
    const fold = freshUsageFold(snapshot)
    for (const observation of observations) {
      const next = applyUsageFoldEvent(fold, observation)
      if (Result.isFailure(next)) return Result.fail(next.failure)
    }
    const candidate = usageFoldChanged(fold) ? snapshotUsageFold(fold) : snapshot
    for (const identity of completeExecutionIds) {
      const executionId = Transcript.executionKey(identity)
      const events = candidate.executionEvents.get(executionId) ?? []
      if (events.length === 0 || executionIntervals(events) === undefined) {
        const event = events.toSorted((left, right) => left.sequence - right.sequence)[0]
        return Result.fail(
          ProjectionFailure.make({
            reason: "invalid-transition",
            message: "Completed execution has incomplete or invalid lifecycle evidence",
            executionId,
            threadId: event?.threadId,
            cursor: event?.key.split("\u0000")[1],
            sequence: event?.sequence,
          }),
        )
      }
    }
    return Result.succeed(candidate)
  },
)
