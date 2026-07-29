import { ExecutionStatus } from "@rika/tools"
import type * as ExecutionBackend from "@rika/runtime/contract"
import * as Transcript from "@rika/transcript"
import { Duration, Function } from "effect"

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

export interface Snapshot {
  readonly turns: ReadonlyMap<string, Totals>
  readonly threads: ReadonlyMap<string, Totals>
  readonly global: Totals
  readonly usageCursors: ReadonlySet<string>
  readonly attempts: ReadonlyMap<string, AttemptCost>
  readonly executionAttempts: ReadonlyMap<string, ReadonlySet<string>>
  readonly activeEvents: ReadonlyMap<string, ActiveEvent>
  readonly malformedExecutions: ReadonlySet<string>
}

export interface ActiveTime {
  readonly accumulated: Duration.Duration
  readonly activeSince?: number
}

export type ActiveTimeAvailability = ({ readonly _tag: "Available" } & ActiveTime) | { readonly _tag: "Unavailable" }

interface ActiveEvent {
  readonly key: string
  readonly executionId: string
  readonly threadId: string
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
  | { readonly _tag: "Priced"; readonly usd: number; readonly source: "provider" | "estimate" }
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

export const foldVersion = 3

export const empty: Snapshot = {
  turns: new Map(),
  threads: new Map(),
  global: noTotals,
  usageCursors: new Set(),
  attempts: new Map(),
  executionAttempts: new Map(),
  activeEvents: new Map(),
  malformedExecutions: new Set(),
}

type SerializedSnapshot = {
  readonly version: number
  readonly turns: ReadonlyArray<readonly [string, Totals]>
  readonly threads: ReadonlyArray<readonly [string, Totals]>
  readonly global: Totals
  readonly usageCursors: ReadonlyArray<string>
  readonly attempts: ReadonlyArray<readonly [string, AttemptCost]>
  readonly executionAttempts: ReadonlyArray<readonly [string, ReadonlyArray<string>]>
  readonly activeEvents: ReadonlyArray<readonly [string, ActiveEvent]>
  readonly malformedExecutions: ReadonlyArray<string>
}

export const serialize = (snapshot: Snapshot): string =>
  JSON.stringify({
    version: foldVersion,
    turns: [...snapshot.turns],
    threads: [...snapshot.threads],
    global: snapshot.global,
    usageCursors: [...snapshot.usageCursors],
    attempts: [...snapshot.attempts],
    executionAttempts: [...snapshot.executionAttempts].map(([key, values]) => [key, [...values]]),
    activeEvents: [...snapshot.activeEvents],
    malformedExecutions: [...snapshot.malformedExecutions],
  } satisfies SerializedSnapshot)

export const deserialize = (json: string): Snapshot | undefined => {
  const value = JSON.parse(json) as SerializedSnapshot
  if (value.version !== foldVersion) return undefined
  return {
    turns: new Map(value.turns),
    threads: new Map(value.threads),
    global: value.global,
    usageCursors: new Set(value.usageCursors),
    attempts: new Map(value.attempts),
    executionAttempts: new Map(value.executionAttempts.map(([key, values]) => [key, new Set(values)])),
    activeEvents: new Map(value.activeEvents),
    malformedExecutions: new Set(value.malformedExecutions),
  }
}

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
    if (event.threadId !== threadId || snapshot.malformedExecutions.has(event.executionId)) continue
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

const malformedExecution = (snapshot: Snapshot, executionId: string): Snapshot => ({
  ...snapshot,
  malformedExecutions: new Set(snapshot.malformedExecutions).add(executionId),
})

export const activeTime: {
  (snapshot: Snapshot, threadId: string): ActiveTimeAvailability
  (threadId: string): (snapshot: Snapshot) => ActiveTimeAvailability
} = Function.dual(2, (snapshot: Snapshot, threadId: string): ActiveTimeAvailability => {
  const intervals = activeIntervals(snapshot, threadId)
  return intervals === undefined ? { _tag: "Unavailable" } : { _tag: "Available", ...unionIntervals(intervals) }
})

const observeActive = (
  snapshot: Snapshot,
  input: RootExecution & { readonly event: ExecutionBackend.Event },
): Snapshot => {
  const event = input.event
  if (!isActiveEventType(event.type)) return snapshot
  if (!isServerStamped(event)) return malformedExecution(snapshot, event.executionId)
  if (
    event.executionId.length === 0 ||
    !Number.isFinite(event.createdAt) ||
    event.createdAt < 0 ||
    !Number.isSafeInteger(event.sequence)
  )
    return malformedExecution(snapshot, event.executionId)
  const key = `${event.executionId}\u0000${event.cursor}`
  const previous = snapshot.activeEvents.get(key)
  if (previous !== undefined)
    return previous.threadId === input.threadId &&
      previous.type === event.type &&
      previous.createdAt === event.createdAt &&
      previous.sequence === event.sequence
      ? snapshot
      : malformedExecution(snapshot, event.executionId)
  return {
    ...snapshot,
    activeEvents: new Map(snapshot.activeEvents).set(key, {
      key,
      executionId: event.executionId,
      threadId: input.threadId,
      type: event.type,
      createdAt: event.createdAt,
      sequence: event.sequence,
    }),
  }
}

export const eventCostUsd = (event: ExecutionBackend.Event): number | undefined =>
  event.type === "model.usage.reported"
    ? Transcript.project("usage", "", [{ ...event, sequence: 0 }]).costUsd
    : undefined

const stringField = (data: Readonly<Record<string, unknown>> | undefined, name: string) => {
  const value = data?.[name]
  return typeof value === "string" && value.length > 0 ? value : undefined
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

const estimatePriced = (cost: AttemptPricing, usd: number): AttemptPricing => {
  if (cost._tag === "Priced")
    return cost.source === "provider" || cost.usd === usd ? cost : { _tag: "Unpriceable", reason: "cost-conflict" }
  if (cost._tag === "Unpriceable" && !settledWithoutUsage(cost.reason)) return cost
  return { _tag: "Priced", usd, source: "estimate" }
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

const addScope = (scope: ReadonlyMap<string, Totals>, key: string, delta: Totals): ReadonlyMap<string, Totals> =>
  new Map(scope).set(key, accumulate(scope.get(key) ?? noTotals, delta))

export const turnTotals: {
  (snapshot: Snapshot, turnId: string): Totals
  (turnId: string): (snapshot: Snapshot) => Totals
} = Function.dual(2, (snapshot: Snapshot, turnId: string): Totals => snapshot.turns.get(turnId) ?? noTotals)

export const threadTotals: {
  (snapshot: Snapshot, threadId: string): Totals
  (threadId: string): (snapshot: Snapshot) => Totals
} = Function.dual(2, (snapshot: Snapshot, threadId: string): Totals => snapshot.threads.get(threadId) ?? noTotals)

const writeAttempt = (
  snapshot: Snapshot,
  executionId: string | undefined,
  attemptKey: string,
  previous: AttemptCost | undefined,
  next: AttemptCost,
): Snapshot => {
  if (previous === next) return snapshot
  const attempts = new Map(snapshot.attempts).set(attemptKey, next)
  const executionAttempts =
    executionId === undefined || snapshot.executionAttempts.get(executionId)?.has(attemptKey) === true
      ? snapshot.executionAttempts
      : new Map(snapshot.executionAttempts).set(
          executionId,
          new Set([...(snapshot.executionAttempts.get(executionId) ?? []), attemptKey]),
        )
  const delta = difference(contribution(next), previous === undefined ? noTotals : contribution(previous))
  if (!shifts(delta)) return { ...snapshot, attempts, executionAttempts }
  return {
    ...snapshot,
    attempts,
    executionAttempts,
    turns: addScope(snapshot.turns, next.turnId, delta),
    threads: addScope(snapshot.threads, next.threadId, delta),
    global: accumulate(snapshot.global, delta),
  }
}

const settleExecution = (snapshot: Snapshot, executionId: string, reason: SettlementReason): Snapshot => {
  const attemptKeys = snapshot.executionAttempts.get(executionId)
  if (attemptKeys === undefined) return snapshot
  let settled = snapshot
  for (const attemptKey of attemptKeys) {
    const previous = settled.attempts.get(attemptKey)
    if (previous === undefined) continue
    settled = writeAttempt(settled, executionId, attemptKey, previous, settle(previous, reason))
  }
  return settled
}

const unreadableKey = (key: string) => `unreadable\u0000${key}`

const unreadable = (
  snapshot: Snapshot,
  input: RootExecution,
  key: string,
  reason: UnpriceableReason & UncountableReason,
): Snapshot => {
  const attemptKey = unreadableKey(key)
  return writeAttempt(snapshot, undefined, attemptKey, snapshot.attempts.get(attemptKey), {
    threadId: input.threadId,
    turnId: input.turnId,
    cost: { _tag: "Unpriceable", reason },
    tokens: { _tag: "Uncounted", reason },
  })
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

const observeAttempt = (
  snapshot: Snapshot,
  input: RootExecution & { readonly event: ExecutionBackend.Event },
): Snapshot => {
  const event = input.event
  if (event.executionId.length === 0)
    return unreadable(snapshot, input, `${event.cursor}\u0000${event.sequence}`, "delivery-malformed")
  const deliveryKey = `${event.executionId}\u0000${event.cursor}`
  if (snapshot.usageCursors.has(deliveryKey)) return snapshot
  const attemptId = stringField(event.data, "model_attempt_id")
  if (attemptId === undefined) return unreadable(snapshot, input, deliveryKey, "delivery-malformed")
  const attemptKey = `${event.executionId}\u0000${attemptId}`
  const previous = snapshot.attempts.get(attemptKey)
  const current: AttemptCost = previous ?? {
    threadId: input.threadId,
    turnId: input.turnId,
    cost: { _tag: "Announced" },
    tokens: { _tag: "Announced" },
  }
  let next = current
  if (event.type === "model.usage.reported") {
    const decoded = Transcript.usageTokens(event.data ?? {})
    const estimate = eventCostUsd(event)
    next = {
      ...current,
      cost:
        estimate === undefined
          ? unpriceable(current.cost, "usage-unpriceable")
          : estimatePriced(current.cost, estimate),
      tokens:
        decoded._tag === "Available"
          ? countedTokens(current.tokens, decoded.total)
          : uncountable(current.tokens, "usage-uncountable"),
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
  return {
    ...writeAttempt(snapshot, event.executionId, attemptKey, previous, next),
    usageCursors: new Set(snapshot.usageCursors).add(deliveryKey),
  }
}

export const observe: {
  (input: RootExecution & { readonly event: ExecutionBackend.Event }): (snapshot: Snapshot) => Snapshot
  (snapshot: Snapshot, input: RootExecution & { readonly event: ExecutionBackend.Event }): Snapshot
} = Function.dual(
  2,
  (snapshot: Snapshot, input: RootExecution & { readonly event: ExecutionBackend.Event }): Snapshot => {
    if (Transcript.isTransientEvent(input.event)) return snapshot
    if (isActiveEventType(input.event.type)) {
      const active = observeActive(snapshot, input)
      return isTerminalEventType(input.event.type) && input.event.executionId.length > 0
        ? settleExecution(active, input.event.executionId, "settled-without-usage")
        : active
    }
    if (!attemptEventTypes.has(input.event.type)) return snapshot
    return observeAttempt(snapshot, input)
  },
)
