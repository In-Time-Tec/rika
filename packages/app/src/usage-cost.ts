import * as ExecutionBackend from "@rika/runtime/contract"
import * as Transcript from "@rika/transcript"
import { Duration, Effect, Function } from "effect"

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

export interface Snapshot {
  readonly turnCostUsd: ReadonlyMap<string, number>
  readonly threadCostUsd: ReadonlyMap<string, number>
  readonly globalCostUsd: number
  readonly usageCursors: ReadonlySet<string>
  readonly complete: boolean
  readonly attempts: ReadonlyMap<string, AttemptCost>
  readonly collectionComplete: boolean
  readonly turnTokens: ReadonlyMap<string, number>
  readonly threadTokens: ReadonlyMap<string, number>
  readonly tokenCompleteThreads: ReadonlySet<string>
  readonly costCompleteThreads: ReadonlySet<string>
  readonly incompleteThreads: ReadonlySet<string>
  readonly activeEvents: ReadonlyMap<string, ActiveEvent>
  readonly activeObservedThreads: ReadonlySet<string>
  readonly timeMalformedThreads: ReadonlySet<string>
  readonly threadActiveTime: ReadonlyMap<string, ActiveTime>
}

export interface ActiveTime {
  readonly accumulated: Duration.Duration
  readonly activeSince?: number
}

export type ActiveTimeAvailability = ({ readonly _tag: "Available" } & ActiveTime) | { readonly _tag: "Unavailable" }

interface ActiveEvent {
  readonly key: string
  readonly id: string
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
  | "execution.completed"
  | "execution.failed"
  | "execution.cancelled"

interface AttemptCost {
  readonly threadId: string
  readonly turnId: string
  readonly estimate: "absent" | "valid" | "invalid"
  readonly estimateAmount?: number
  readonly provider: "absent" | "valid" | "invalid"
  readonly providerAmount?: number
  readonly tokens: "absent" | "valid" | "invalid"
  readonly tokenAmount?: number
}

export const maximumGlobalThreads = 100
const collectionConcurrency = 1

export const empty: Snapshot = {
  turnCostUsd: new Map(),
  threadCostUsd: new Map(),
  globalCostUsd: 0,
  usageCursors: new Set(),
  complete: true,
  attempts: new Map(),
  collectionComplete: true,
  turnTokens: new Map(),
  threadTokens: new Map(),
  tokenCompleteThreads: new Set(),
  costCompleteThreads: new Set(),
  incompleteThreads: new Set(),
  activeEvents: new Map(),
  activeObservedThreads: new Set(),
  timeMalformedThreads: new Set(),
  threadActiveTime: new Map(),
}

const activeEventTypes = new Set<string>([
  "execution.accepted",
  "execution.started",
  "wait.created",
  "execution.completed",
  "execution.failed",
  "execution.cancelled",
])

export const isRelevantEvent = (event: ExecutionBackend.Event): boolean =>
  activeEventTypes.has(event.type) || event.type === "model.usage.reported" || event.type === "model.attempt.completed"

const isActiveEventType = (type: string): type is ActiveEventType => activeEventTypes.has(type)

interface Interval {
  readonly start: number
  readonly end?: number
}

const executionIntervals = (events: ReadonlyArray<ActiveEvent>): ReadonlyArray<Interval> | undefined => {
  const ordered = events.toSorted(
    (left, right) =>
      left.sequence - right.sequence || left.type.localeCompare(right.type) || left.id.localeCompare(right.id),
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
      if (accepted || started || terminal) return undefined
      accepted = true
      continue
    }
    if (event.type === "execution.started") {
      if (terminal || activeSince !== undefined) return undefined
      started = true
      activeSince = event.createdAt
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
    if (activeSince !== undefined) {
      intervals.push({ start: activeSince, end: event.createdAt })
      activeSince = undefined
    }
    if (
      event.type === "execution.completed" ||
      event.type === "execution.failed" ||
      event.type === "execution.cancelled"
    )
      terminal = true
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
  for (const events of executions.values()) {
    const execution = executionIntervals(events)
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
  if (
    event.executionId === undefined ||
    event.executionId.length === 0 ||
    event.id === undefined ||
    event.id.length === 0 ||
    !Number.isFinite(event.createdAt) ||
    event.createdAt < 0
  )
    return malformedTime(snapshot, input.threadId)
  const key = `${event.executionId}\u0000${event.id}`
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
    id: event.id,
    executionId: event.executionId,
    threadId: input.threadId,
    type: event.type,
    createdAt: event.createdAt,
    sequence: event.sequence,
  })
  return rebuildThreadActiveTime(
    {
      ...snapshot,
      activeEvents,
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

const pricedAttempt = (attempt: AttemptCost): number | undefined => {
  if (attempt.provider === "valid") return attempt.providerAmount
  if (attempt.provider !== "absent" || attempt.estimate !== "valid") return undefined
  return attempt.estimateAmount
}

const invalidEstimate = (previous: AttemptCost): AttemptCost => {
  const { estimateAmount: _, ...attempt } = previous
  return { ...attempt, estimate: "invalid" }
}

const mergeEstimate = (previous: AttemptCost, estimateAmount: number | undefined): AttemptCost => {
  if (previous.estimate === "invalid" || estimateAmount === undefined) return invalidEstimate(previous)
  if (previous.estimate === "absent") return { ...previous, estimate: "valid", estimateAmount }
  return previous.estimateAmount === estimateAmount ? previous : invalidEstimate(previous)
}

const invalidProvider = (previous: AttemptCost): AttemptCost => {
  const { providerAmount: _, ...attempt } = previous
  return { ...attempt, provider: "invalid" }
}

const mergeProvider = (previous: AttemptCost, providerAmount: number | undefined): AttemptCost => {
  if (previous.provider === "invalid" || providerAmount === undefined) return invalidProvider(previous)
  if (previous.provider === "absent") return { ...previous, provider: "valid", providerAmount }
  return previous.providerAmount === providerAmount ? previous : invalidProvider(previous)
}

const totals = (
  attempts: ReadonlyMap<string, AttemptCost>,
  collectionComplete: boolean,
  incompleteThreads: ReadonlySet<string>,
) => {
  const turnCostUsd = new Map<string, number>()
  const threadCostUsd = new Map<string, number>()
  let globalCostUsd = 0
  let complete = collectionComplete
  const turnTokens = new Map<string, number>()
  const threadTokens = new Map<string, number>()
  const incompleteCostThreads = new Set(incompleteThreads)
  const incompleteTokenThreads = new Set(incompleteThreads)
  const observedThreads = new Set(incompleteThreads)
  for (const attempt of attempts.values()) {
    observedThreads.add(attempt.threadId)
    const cost = pricedAttempt(attempt)
    if (cost === undefined) {
      complete = false
      incompleteCostThreads.add(attempt.threadId)
    } else {
      turnCostUsd.set(attempt.turnId, (turnCostUsd.get(attempt.turnId) ?? 0) + cost)
      threadCostUsd.set(attempt.threadId, (threadCostUsd.get(attempt.threadId) ?? 0) + cost)
      globalCostUsd += cost
    }
    if (attempt.tokens !== "valid") incompleteTokenThreads.add(attempt.threadId)
    else {
      turnTokens.set(attempt.turnId, (turnTokens.get(attempt.turnId) ?? 0) + attempt.tokenAmount!)
      threadTokens.set(attempt.threadId, (threadTokens.get(attempt.threadId) ?? 0) + attempt.tokenAmount!)
    }
  }
  return {
    turnCostUsd,
    threadCostUsd,
    globalCostUsd,
    complete,
    turnTokens,
    threadTokens,
    tokenCompleteThreads: new Set([...observedThreads].filter((thread) => !incompleteTokenThreads.has(thread))),
    costCompleteThreads: new Set([...observedThreads].filter((thread) => !incompleteCostThreads.has(thread))),
  }
}

const incomplete = (snapshot: Snapshot, threadId: string): Snapshot => {
  const incompleteThreads = new Set(snapshot.incompleteThreads).add(threadId)
  return {
    ...snapshot,
    collectionComplete: false,
    incompleteThreads,
    activeObservedThreads: new Set(snapshot.activeObservedThreads).add(threadId),
    timeMalformedThreads: new Set(snapshot.timeMalformedThreads).add(threadId),
    ...totals(snapshot.attempts, false, incompleteThreads),
  }
}

export const observe: {
  (input: RootExecution & { readonly event: ExecutionBackend.Event }): (snapshot: Snapshot) => Snapshot
  (snapshot: Snapshot, input: RootExecution & { readonly event: ExecutionBackend.Event }): Snapshot
} = Function.dual(
  2,
  (snapshot: Snapshot, input: RootExecution & { readonly event: ExecutionBackend.Event }): Snapshot => {
    if (isActiveEventType(input.event.type)) return observeActive(snapshot, input)
    if (input.event.type !== "model.usage.reported" && input.event.type !== "model.attempt.completed") return snapshot
    if (
      input.event.executionId === undefined ||
      input.event.executionId.length === 0 ||
      input.event.id === undefined ||
      input.event.id.length === 0
    )
      return incomplete(snapshot, input.threadId)
    const deliveryKey = `${input.event.executionId}\u0000${input.event.id}`
    if (snapshot.usageCursors.has(deliveryKey)) return snapshot
    const attemptId = stringField(input.event.data, "model_attempt_id")
    if (attemptId === undefined) return incomplete(snapshot, input.threadId)
    const attemptKey = `${input.event.executionId}\u0000${attemptId}`
    const previous = snapshot.attempts.get(attemptKey) ?? {
      threadId: input.threadId,
      turnId: input.turnId,
      estimate: "absent" as const,
      provider: "absent" as const,
      tokens: "absent" as const,
    }
    let attempt: AttemptCost
    if (input.event.type === "model.usage.reported") {
      const decoded = Transcript.usageTokens(input.event.data ?? {})
      const tokens = decoded._tag === "Available" ? decoded.total : undefined
      const invalidTokens = (): AttemptCost => {
        const { tokenAmount: _, ...withoutAmount } = previous
        return { ...withoutAmount, tokens: "invalid" }
      }
      let tokenAttempt: AttemptCost
      if (previous.tokens === "invalid" || tokens === undefined) tokenAttempt = invalidTokens()
      else if (previous.tokens === "absent") tokenAttempt = { ...previous, tokens: "valid", tokenAmount: tokens }
      else if (previous.tokenAmount === tokens) tokenAttempt = previous
      else tokenAttempt = invalidTokens()
      attempt = mergeEstimate(tokenAttempt, eventCostUsd(input.event))
    } else if (input.event.data !== undefined && Object.hasOwn(input.event.data, "cost")) {
      const cost = input.event.data.cost
      const valid =
        cost !== null &&
        typeof cost === "object" &&
        typeof (cost as { amount?: unknown }).amount === "number" &&
        Number.isFinite((cost as { amount: number }).amount) &&
        (cost as { amount: number }).amount >= 0 &&
        (cost as { currency?: unknown }).currency === "USD"
      const providerAmount = valid ? (cost as { amount: number }).amount : undefined
      attempt = mergeProvider(previous, providerAmount)
    } else {
      attempt = previous
    }
    const attempts = new Map(snapshot.attempts).set(attemptKey, attempt)
    return {
      ...snapshot,
      ...totals(attempts, snapshot.collectionComplete, snapshot.incompleteThreads),
      attempts,
      usageCursors: new Set(snapshot.usageCursors).add(deliveryKey),
    }
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
  const markIncomplete = (threadId: string) => {
    snapshot = incomplete(snapshot, threadId)
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
        if (current.optional !== true) markIncomplete(current.threadId)
        continue
      }
      if (replay === undefined) {
        if (current.optional !== true) markIncomplete(current.threadId)
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
          if (!isActiveEventType(event.type)) continue
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
      for (const child of inspection.children)
        pending.push({ ...current, executionId: child.executionId, reference: true })
    }
  }
  return snapshot
})
