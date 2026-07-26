import { ExecutionStatus } from "@rika/tools"
import * as ExecutionBackend from "@rika/runtime/contract"
import * as Transcript from "@rika/transcript"
import { Duration, Effect, Function, HashMap, Option } from "effect"

export interface RootExecution {
  readonly threadId: string
  readonly turnId: string
  readonly executionId?: string
  readonly optional?: boolean
}

export interface ExecutionReader {
  readonly inspect: ExecutionBackend.Interface["inspect"]
  readonly replay: ExecutionBackend.Interface["replay"]
  readonly pageEvents?: ExecutionBackend.Interface["pageEvents"]
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
  readonly activeObservedThreads: ReadonlySet<string>
  readonly timeMalformedThreads: ReadonlySet<string>
  readonly threadActiveTime: ReadonlyMap<string, ActiveTime>
  readonly executionWorkTimestamps: ReadonlyMap<string, HashMap.HashMap<number, WorkEvidence>>
  readonly executionActiveBounds: ReadonlyMap<string, ExecutionActiveBounds>
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

interface WorkEvidence {
  readonly cursor: string
  readonly createdAt: number
}

interface ExecutionActiveBounds {
  readonly threadId: string
  readonly maximumSequence: number
}

export const maximumGlobalThreads = 100
const collectionConcurrency = 1

export const empty: Snapshot = {
  turns: new Map(),
  threads: new Map(),
  global: noTotals,
  usageCursors: new Set(),
  attempts: new Map(),
  executionAttempts: new Map(),
  activeEvents: new Map(),
  activeObservedThreads: new Set(),
  timeMalformedThreads: new Set(),
  threadActiveTime: new Map(),
  executionWorkTimestamps: new Map(),
  executionActiveBounds: new Map(),
}

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

const isWorkEventType = (type: string): boolean => type.startsWith("model.") || type.startsWith("tool.")

export const isObservedEvent = (event: ExecutionBackend.Event): boolean =>
  activeEventTypes.has(event.type) || isWorkEventType(event.type)

export const isUsageBearingEvent = (event: ExecutionBackend.Event): boolean =>
  activeEventTypes.has(event.type) ||
  event.type === "model.usage.reported" ||
  event.type === "model.attempt.completed" ||
  event.type === "model.attempt.failed"

const isActiveEventType = (type: string): type is ActiveEventType => activeEventTypes.has(type)

const isTerminalEventType = (type: ActiveEventType): boolean => ExecutionStatus.isTerminalEventType(type)

interface Interval {
  readonly start: number
  readonly end?: number
}

const executionIntervals = (
  events: ReadonlyArray<ActiveEvent>,
  workTimestamps: HashMap.HashMap<number, WorkEvidence> | undefined,
): ReadonlyArray<Interval> | undefined => {
  const ordered = events.toSorted(
    (left, right) => left.sequence - right.sequence || left.type.localeCompare(right.type),
  )
  const intervals: Array<Interval> = []
  let activeSince: number | undefined
  let activeSequence: number | undefined
  let accepted = false
  let started = false
  let terminal = false
  let resumedAt: number | undefined
  let previousSequence: number | undefined
  let previousCreatedAt: number | undefined
  for (const event of ordered) {
    let resumedWorkAt: number | undefined
    if (
      event.type === "execution.started" &&
      resumedAt === undefined &&
      previousCreatedAt !== undefined &&
      event.createdAt < previousCreatedAt &&
      workTimestamps !== undefined
    )
      for (const [sequence, evidence] of workTimestamps)
        if (sequence > event.sequence && evidence.createdAt >= previousCreatedAt)
          resumedWorkAt = resumedWorkAt === undefined ? evidence.createdAt : Math.min(resumedWorkAt, evidence.createdAt)
    const createdAt =
      event.type === "execution.started" && resumedAt !== undefined
        ? Math.max(event.createdAt, resumedAt)
        : (resumedWorkAt ?? event.createdAt)
    if (
      previousSequence === event.sequence ||
      (previousCreatedAt !== undefined && createdAt < previousCreatedAt && !isTerminalEventType(event.type))
    )
      return undefined
    previousSequence = event.sequence
    previousCreatedAt = createdAt
    if (terminal) return undefined
    if (event.type === "execution.accepted") {
      if (accepted || started || terminal) return undefined
      accepted = true
      continue
    }
    if (event.type === "execution.started") {
      if (terminal || (activeSince !== undefined && resumedAt === undefined)) return undefined
      started = true
      activeSince = createdAt
      activeSequence = event.sequence
      resumedAt = undefined
      continue
    }
    if (!started) {
      if (
        accepted &&
        (event.type === "execution.completed" ||
          event.type === "execution.failed" ||
          event.type === "execution.cancelled")
      ) {
        terminal = true
        continue
      }
      return undefined
    }
    if (event.type === "wait.woken" || event.type === "wait.timed_out") {
      if (activeSince !== undefined || resumedAt !== undefined) return undefined
      resumedAt = event.createdAt
      activeSince = event.createdAt
      activeSequence = event.sequence
      continue
    }
    if (activeSince !== undefined) {
      const segmentSequence = activeSequence
      let workTimestamp: number | undefined
      if (segmentSequence !== undefined && workTimestamps !== undefined)
        for (const [sequence, evidence] of workTimestamps)
          if (sequence > segmentSequence && sequence < event.sequence)
            workTimestamp =
              workTimestamp === undefined ? evidence.createdAt : Math.max(workTimestamp, evidence.createdAt)
      const end = Math.max(activeSince, event.createdAt, workTimestamp ?? event.createdAt)
      intervals.push({ start: activeSince, end })
      activeSince = undefined
      activeSequence = undefined
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

const rebuildThreadActiveTime = (snapshot: Snapshot, threadId: string): Snapshot => {
  const executions = new Map<string, Array<ActiveEvent>>()
  for (const event of snapshot.activeEvents.values()) {
    if (event.threadId !== threadId) continue
    executions.set(event.executionId, [...(executions.get(event.executionId) ?? []), event])
  }
  const intervals: Array<Interval> = []
  for (const [executionId, events] of executions) {
    const execution = executionIntervals(events, snapshot.executionWorkTimestamps.get(executionId))
    if (execution === undefined) {
      const threadActiveTime = new Map(snapshot.threadActiveTime)
      threadActiveTime.delete(threadId)
      return { ...snapshot, threadActiveTime }
    }
    intervals.push(...execution)
  }
  return {
    ...snapshot,
    threadActiveTime: new Map(snapshot.threadActiveTime).set(threadId, unionIntervals(intervals)),
  }
}

const malformedTime = (snapshot: Snapshot, threadId: string): Snapshot => ({
  ...snapshot,
  activeObservedThreads: new Set(snapshot.activeObservedThreads).add(threadId),
  timeMalformedThreads: new Set(snapshot.timeMalformedThreads).add(threadId),
})

const observeWorkTimestamp = (
  snapshot: Snapshot,
  input: RootExecution & { readonly event: ExecutionBackend.Event },
): Snapshot => {
  const event = input.event
  if (!isWorkEventType(event.type)) return snapshot
  if (
    event.executionId.length === 0 ||
    !Number.isSafeInteger(event.sequence) ||
    !Number.isFinite(event.createdAt) ||
    event.createdAt < 0
  )
    return snapshot
  const executionTimestamps = snapshot.executionWorkTimestamps.get(event.executionId) ?? HashMap.empty()
  const previous = Option.getOrUndefined(HashMap.get(executionTimestamps, event.sequence))
  if (previous !== undefined)
    return previous.cursor === event.cursor && previous.createdAt === event.createdAt
      ? snapshot
      : malformedTime(snapshot, input.threadId)
  const nextExecutionTimestamps = HashMap.set(executionTimestamps, event.sequence, {
    cursor: event.cursor,
    createdAt: event.createdAt,
  })
  const withTimestamp = {
    ...snapshot,
    executionWorkTimestamps: new Map(snapshot.executionWorkTimestamps).set(event.executionId, nextExecutionTimestamps),
  }
  const bounds = snapshot.executionActiveBounds.get(event.executionId)
  if (
    bounds === undefined ||
    (event.sequence >= bounds.maximumSequence && withTimestamp.threadActiveTime.has(bounds.threadId))
  )
    return withTimestamp
  return rebuildThreadActiveTime(withTimestamp, bounds.threadId)
}

export const activeTime: {
  (snapshot: Snapshot, threadId: string): ActiveTimeAvailability
  (threadId: string): (snapshot: Snapshot) => ActiveTimeAvailability
} = Function.dual(2, (snapshot: Snapshot, threadId: string): ActiveTimeAvailability => {
  if (snapshot.timeMalformedThreads.has(threadId)) return { _tag: "Unavailable" }
  const time = snapshot.threadActiveTime.get(threadId)
  if (time === undefined && snapshot.activeObservedThreads.has(threadId)) return { _tag: "Unavailable" }
  return { _tag: "Available", ...(time ?? { accumulated: Duration.zero }) }
})

const observeActive = (
  snapshot: Snapshot,
  input: RootExecution & { readonly event: ExecutionBackend.Event },
): Snapshot => {
  const event = input.event
  if (!isActiveEventType(event.type)) return snapshot
  if (event.executionId.length === 0 || !Number.isFinite(event.createdAt) || event.createdAt < 0)
    return malformedTime(snapshot, input.threadId)
  const key = event.cursor
  const previous = snapshot.activeEvents.get(key)
  if (previous !== undefined) {
    if (
      previous.threadId === input.threadId &&
      previous.type === event.type &&
      previous.createdAt === event.createdAt &&
      previous.sequence === event.sequence
    )
      return snapshot
    return malformedTime(snapshot, input.threadId)
  }
  const activeEvents = new Map(snapshot.activeEvents).set(key, {
    key,
    executionId: event.executionId,
    threadId: input.threadId,
    type: event.type,
    createdAt: event.createdAt,
    sequence: event.sequence,
  })
  const previousBounds = snapshot.executionActiveBounds.get(event.executionId)
  const executionActiveBounds = new Map(snapshot.executionActiveBounds).set(event.executionId, {
    threadId: input.threadId,
    maximumSequence: Math.max(previousBounds?.maximumSequence ?? event.sequence, event.sequence),
  })
  return rebuildThreadActiveTime(
    {
      ...snapshot,
      activeEvents,
      executionActiveBounds,
      activeObservedThreads: new Set(snapshot.activeObservedThreads).add(input.threadId),
    },
    input.threadId,
  )
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
  return writeAttempt(
    {
      ...snapshot,
      activeObservedThreads: new Set(snapshot.activeObservedThreads).add(input.threadId),
      timeMalformedThreads: new Set(snapshot.timeMalformedThreads).add(input.threadId),
    },
    undefined,
    attemptKey,
    snapshot.attempts.get(attemptKey),
    {
      threadId: input.threadId,
      turnId: input.turnId,
      cost: { _tag: "Unpriceable", reason },
      tokens: { _tag: "Uncounted", reason },
    },
  )
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
  const deliveryKey = event.cursor
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
    const withWorkTimestamp = observeWorkTimestamp(snapshot, input)
    if (isActiveEventType(input.event.type)) {
      const active = observeActive(withWorkTimestamp, input)
      return isTerminalEventType(input.event.type) &&
        input.event.executionId !== undefined &&
        input.event.executionId.length > 0
        ? settleExecution(active, input.event.executionId, "settled-without-usage")
        : active
    }
    if (
      input.event.type !== "model.usage.reported" &&
      input.event.type !== "model.attempt.completed" &&
      input.event.type !== "model.attempt.failed"
    )
      return withWorkTimestamp
    return observeAttempt(withWorkTimestamp, input)
  },
)

const readExecution = <A, E>(effect: Effect.Effect<A, E>, executionId: string): Effect.Effect<A | undefined> =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("usage-cost.execution.read.failed").pipe(
        Effect.annotateLogs("rika.execution.id", executionId),
        Effect.annotateLogs("rika.failure.cause", String(cause)),
        Effect.as(undefined),
      ),
    ),
  )

const readCompleteHistory = Effect.fn("UsageCost.readCompleteHistory")(function* (
  reader: ExecutionReader,
  executionId: string,
  reference: ExecutionBackend.ExecutionReference | undefined,
) {
  if (reader.pageEvents === undefined) return undefined
  const events: Array<ExecutionBackend.Event> = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  while (true) {
    const page = yield* readExecution(reader.pageEvents(executionId, "forward", cursor, 1_000, reference), executionId)
    if (page === undefined) return undefined
    events.push(...page.events)
    if (!page.hasMore) return events
    const nextCursor = page.newestCursor ?? page.events.at(-1)?.cursor
    if (nextCursor === undefined || seenCursors.has(nextCursor)) return undefined
    seenCursors.add(nextCursor)
    cursor = nextCursor
  }
})

export const collect = Effect.fn("UsageCost.collect")(function* (
  reader: ExecutionReader,
  roots: ReadonlyArray<RootExecution>,
) {
  let snapshot: Snapshot = { ...empty }
  const pending = roots.map((root) => ({ ...root, executionId: root.executionId ?? root.turnId, reference: false }))
  const seenExecutions = new Set<string>()
  const markUnreadable = (current: RootExecution & { readonly executionId: string }) => {
    snapshot = unreadable(snapshot, current, current.executionId, "execution-unreadable")
  }
  while (pending.length > 0) {
    const batch = pending.splice(0).filter((current) => {
      if (seenExecutions.has(current.executionId)) return false
      seenExecutions.add(current.executionId)
      return true
    })
    const results = yield* Effect.forEach(
      batch,
      (current) =>
        Effect.gen(function* () {
          const reference = current.reference ? ExecutionBackend.executionReference : undefined
          const inspection = yield* readExecution(reader.inspect(current.executionId, reference), current.executionId)
          if (inspection === undefined) return { current, inspection }
          const replay = yield* readExecution(
            reader.replay(current.executionId, undefined, reference),
            current.executionId,
          )
          return { current, inspection, replay }
        }),
      { concurrency: collectionConcurrency },
    )
    for (const { current, inspection, replay } of results) {
      if (inspection === undefined) {
        if (current.optional !== true) markUnreadable(current)
        continue
      }
      if (replay === undefined) {
        if (current.optional !== true) markUnreadable(current)
        continue
      }
      for (const event of replay.events)
        snapshot = observe(snapshot, {
          threadId: current.threadId,
          turnId: current.turnId,
          event,
        })
      const reference = current.reference ? ExecutionBackend.executionReference : undefined
      const history = yield* readCompleteHistory(reader, current.executionId, reference)
      if (history !== undefined)
        for (const event of history) {
          snapshot = observe(snapshot, {
            threadId: current.threadId,
            turnId: current.turnId,
            event,
          })
        }
      if (
        history === undefined ||
        (!history.some((event) => isActiveEventType(event.type)) &&
          inspection.status !== "accepted" &&
          inspection.status !== "queued")
      )
        snapshot = malformedTime(snapshot, current.threadId)
      if (ExecutionStatus.isTerminalStatus(inspection.status))
        snapshot = settleExecution(snapshot, current.executionId, "settled-without-usage")
      for (const child of inspection.children)
        pending.push({ ...current, executionId: child.executionId, reference: true })
    }
  }
  return snapshot
})
