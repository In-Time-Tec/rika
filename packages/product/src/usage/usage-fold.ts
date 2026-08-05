import { Function } from "effect"
import * as TranscriptCorrelation from "@rika/transcript/child-parent-correlation"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as ModelAttemptUsage from "@rika/transcript/model-attempt-usage"
import { Result } from "effect"
import type { AttemptCost } from "./usage-attempt"
import { Attempt } from "./usage-attempt"
import type { ActiveEvent, RootExecution } from "./usage-event"
import { Lifecycle, ProjectionFailure, isBatonStamped, isLifecycleEvent, isObservedEvent } from "./usage-event"
import { executionIntervals } from "./usage-active-time"
import type { ContextReading } from "./usage-context-reading"
import { empty, type Snapshot } from "./usage-snapshot"
import { accumulate, difference, noTotals, shifts, type Totals } from "./usage-total"
import * as ExecutionEvent from "@rika/product/execution-event"

declare const UsageFoldType: unique symbol

export interface UsageFold {
  readonly [UsageFoldType]: typeof UsageFoldType
}

type MutableUsage = {
  turns: Map<string, Totals>
  threads: Map<string, Totals>
  global: Totals
  deliveries: Map<string, import("./usage-event").DeliveryIdentity>
  attempts: Map<string, AttemptCost>
  executionAttempts: Map<string, Set<string>>
  executionContexts: Map<string, ContextReading>
  activeEvents: Map<string, ActiveEvent>
  executionEvents: Map<string, Array<ActiveEvent>>
}

type UsageChanged = {
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

type OwnedUsageFold = { published: Snapshot; mutable: MutableUsage; changed: UsageChanged }
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

export const restoreUsageFold = (value: Snapshot): UsageFold => {
  if (value === empty) return makeUsageFold(value, false)
  const existing = snapshotToFold.get(value)
  return existing ?? makeUsageFold(value, true)
}

const freshUsageFold = (snapshot: Snapshot): UsageFold => makeUsageFold(snapshot, false)

export const usageFoldChanged = (fold: UsageFold): boolean => {
  const changed = usageOwner(fold).changed
  return Object.values(changed).some(Boolean)
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
  const delta = difference(
    Attempt.contribution(next),
    previous === undefined ? noTotals : Attempt.contribution(previous),
  )
  if (!shifts(delta)) return
  addScopeMutable(value.mutable.turns, next.turnId, delta)
  addScopeMutable(value.mutable.threads, next.threadId, delta)
  value.mutable.global = accumulate(value.mutable.global, delta)
  value.changed.turns = true
  value.changed.threads = true
  value.changed.global = true
}

const settleExecutionMutable = (
  value: OwnedUsageFold,
  executionId: string,
  reason: "attempt-failed" | "settled-without-usage",
): void => {
  const attemptKeys = value.mutable.executionAttempts.get(executionId)
  if (attemptKeys === undefined) return
  for (const attemptKey of attemptKeys) {
    const previous = value.mutable.attempts.get(attemptKey)
    if (previous !== undefined)
      writeAttemptMutable(value, executionId, attemptKey, previous, Attempt.settle(previous, reason))
  }
}

const unreadableMutable = (value: OwnedUsageFold, input: RootExecution, key: string): void => {
  const attemptKey = `unreadable\u0000${key}`
  writeAttemptMutable(value, undefined, attemptKey, value.mutable.attempts.get(attemptKey), {
    threadId: input.threadId,
    turnId: input.turnId,
    cost: { _tag: "Unpriceable", reason: "delivery-malformed" },
    tokens: { _tag: "Uncounted", reason: "delivery-malformed" },
  })
}

const lifecycleTimestamp = (event: ActiveEvent, previous: number | undefined) =>
  event.type === "wait.created" && previous !== undefined ? Math.max(previous, event.createdAt) : event.createdAt

const timestampsRegress = (events: ReadonlyArray<ActiveEvent>): boolean => {
  let previous: number | undefined
  for (const event of events.toSorted((left, right) => left.sequence - right.sequence)) {
    const createdAt = lifecycleTimestamp(event, previous)
    if (previous !== undefined && createdAt < previous) return true
    previous = createdAt
  }
  return false
}

const applyActive = (
  value: OwnedUsageFold,
  input: RootExecution & { readonly event: ExecutionEvent.Event },
): Result.Result<void, ProjectionFailure> => {
  const event = input.event
  if (!Lifecycle.isActiveEventType(event.type)) return Result.succeed(undefined)
  const context = {
    threadId: input.threadId,
    turnId: input.turnId,
    executionId: event.executionId,
    cursor: event.cursor,
    sequence: event.sequence,
  }
  if (!isBatonStamped(event))
    return Result.fail(
      ProjectionFailure.make({
        reason: "missing-baton-stamp",
        message: "Lifecycle event lacks a Baton timestamp",
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
  if (executionEvents[index]?.sequence === event.sequence)
    return Result.fail(
      ProjectionFailure.make({
        reason: "duplicate-sequence",
        message: "Lifecycle sequence is already occupied",
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
  if (timestampsRegress(nextExecutionEvents))
    return Result.fail(
      ProjectionFailure.make({
        reason: "timestamp-regression",
        message: "Lifecycle timestamp regresses relative to its sequence",
        ...context,
      }),
    )
  const invalid = Lifecycle.failure(nextExecutionEvents)
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
  const events = value.mutable.executionEvents.get(event.executionId)
  if (events === undefined) value.mutable.executionEvents.set(event.executionId, [activeEvent])
  else {
    events.splice(index, 0, activeEvent)
    value.changed.executionEvents = true
  }
  if (events === undefined) value.changed.executionEvents = true
  return Result.succeed(undefined)
}

const integerField = (data: Readonly<Record<string, unknown>> | undefined, name: string) => {
  const field = data?.[name]
  return typeof field === "number" && Number.isSafeInteger(field) && field >= 0 ? field : undefined
}

const isConversationCall = (modelCallId: string): boolean =>
  !modelCallId.endsWith(":compaction-summary") && !modelCallId.endsWith(":structured-output")

const applyAttempt = (
  value: OwnedUsageFold,
  input: RootExecution & { readonly event: ExecutionEvent.Event },
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
  const identity = {
    threadId: input.threadId,
    turnId: input.turnId,
    type: event.type,
    createdAt: event.createdAt,
    sequence: event.sequence,
    data: Attempt.canonicalJson(event.data ?? null),
  }
  const delivered = value.mutable.deliveries.get(deliveryKey)
  if (delivered !== undefined) {
    const exact =
      delivered.threadId === identity.threadId &&
      delivered.turnId === identity.turnId &&
      delivered.type === identity.type &&
      delivered.createdAt === identity.createdAt &&
      delivered.sequence === identity.sequence &&
      delivered.data === identity.data
    return exact
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
  }
  const attemptId = Attempt.stringField(event.data, "model_attempt_id")
  if (attemptId === undefined) {
    unreadableMutable(value, input, deliveryKey)
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
  if (event.type === "model.attempt.completed" || event.type === "model.attempt.failed") {
    const decoded = ModelAttemptUsage.usageTokens(event.data ?? {})
    next = {
      ...current,
      tokens:
        decoded._tag === "Available"
          ? Attempt.countedTokens(current.tokens, decoded.total)
          : Attempt.uncountable(current.tokens, "usage-uncountable"),
    }
    const inputTokens = ModelAttemptUsage.usageInputTokens(event.data ?? {})
    const modelCallId = Attempt.stringField(event.data, "model_call_id") ?? attemptId
    const attempt = integerField(event.data, "attempt") ?? 0
    if (
      inputTokens._tag === "Available" &&
      isConversationCall(modelCallId) &&
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
      const executionKey = TranscriptCorrelation.executionKey(event.executionId)
      const previousReading = value.mutable.executionContexts.get(executionKey)
      if (
        previousReading?.sequence === event.sequence &&
        Attempt.canonicalJson(previousReading) !== Attempt.canonicalJson(reading)
      )
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
        value.mutable.executionContexts.set(executionKey, reading)
        value.changed.executionContexts = true
      }
    }
    if (event.data !== undefined && Object.hasOwn(event.data, "cost")) {
      const amount = Attempt.providerCostUsd(event.data)
      next = {
        ...next,
        cost:
          amount === undefined
            ? Attempt.unpriceable(next.cost, "provider-cost-malformed")
            : Attempt.providerPriced(next.cost, amount),
      }
    }
    if (event.type === "model.attempt.failed") next = Attempt.settle(next, "attempt-failed")
  } else if (event.data !== undefined && Object.hasOwn(event.data, "cost")) {
    const amount = Attempt.providerCostUsd(event.data)
    next = {
      ...current,
      cost:
        amount === undefined
          ? Attempt.unpriceable(current.cost, "provider-cost-malformed")
          : Attempt.providerPriced(current.cost, amount),
    }
  }
  writeAttemptMutable(value, event.executionId, attemptKey, previous, next)
  value.mutable.deliveries.set(deliveryKey, identity)
  value.changed.deliveries = true
  return Result.succeed(undefined)
}

const applyUsageFoldEventImpl = (
  fold: UsageFold,
  input: RootExecution & { readonly event: ExecutionEvent.Event },
): Result.Result<void, ProjectionFailure> => {
  const executionId = TranscriptCorrelation.executionKey(input.event.executionId)
  const normalized =
    executionId === input.event.executionId ? input : { ...input, event: { ...input.event, executionId } }
  if (TranscriptProjection.Fold.isTransientEvent(normalized.event)) return Result.succeed(undefined)
  const value = usageOwner(fold)
  if (Lifecycle.isActiveEventType(normalized.event.type)) {
    const active = applyActive(value, normalized)
    if (Result.isFailure(active)) return active
    if (Lifecycle.isTerminalEventType(normalized.event.type) && normalized.event.executionId.length > 0)
      settleExecutionMutable(value, normalized.event.executionId, "settled-without-usage")
    return Result.succeed(undefined)
  }
  if (!isObservedEvent(normalized.event) || isLifecycleEvent(normalized.event)) return Result.succeed(undefined)
  return applyAttempt(value, normalized)
}

export const applyUsageFoldEvent: {
  (
    arg1: RootExecution & { readonly event: ExecutionEvent.Event },
  ): (arg0: UsageFold) => ReturnType<typeof applyUsageFoldEventImpl>
  (
    arg0: UsageFold,
    arg1: RootExecution & { readonly event: ExecutionEvent.Event },
  ): ReturnType<typeof applyUsageFoldEventImpl>
} = Function.dual(2, applyUsageFoldEventImpl)

const completeExecutionImpl = (
  snapshot: Snapshot,
  executionIds: ReadonlySet<string>,
): Result.Result<void, ProjectionFailure> => {
  for (const identity of executionIds) {
    const executionId = TranscriptCorrelation.executionKey(identity)
    const events = snapshot.executionEvents.get(executionId) ?? []
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
  return Result.succeed(undefined)
}

export const completeExecution: {
  (arg1: ReadonlySet<string>): (arg0: Snapshot) => ReturnType<typeof completeExecutionImpl>
  (arg0: Snapshot, arg1: ReadonlySet<string>): ReturnType<typeof completeExecutionImpl>
} = Function.dual(2, completeExecutionImpl)

const foldEventsImpl = (
  snapshot: Snapshot,
  observations: ReadonlyArray<RootExecution & { readonly event: ExecutionEvent.Event }>,
): Result.Result<Snapshot, ProjectionFailure> => {
  const fold = freshUsageFold(snapshot)
  for (const observation of observations) {
    const next = applyUsageFoldEvent(fold, observation)
    if (Result.isFailure(next)) return Result.fail(next.failure)
  }
  return Result.succeed(usageFoldChanged(fold) ? snapshotUsageFold(fold) : snapshot)
}

export const foldEvents: {
  (
    arg1: ReadonlyArray<RootExecution & { readonly event: ExecutionEvent.Event }>,
  ): (arg0: Snapshot) => ReturnType<typeof foldEventsImpl>
  (
    arg0: Snapshot,
    arg1: ReadonlyArray<RootExecution & { readonly event: ExecutionEvent.Event }>,
  ): ReturnType<typeof foldEventsImpl>
} = Function.dual(2, foldEventsImpl)
