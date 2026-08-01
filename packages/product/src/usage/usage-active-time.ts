import type { ActiveEvent } from "./usage-event"
import { Lifecycle } from "./usage-event"
import type { Snapshot } from "./usage-snapshot"
import { Duration, Function } from "effect"

export interface Interval {
  readonly start: number
  readonly end?: number
}

export interface ActiveTime {
  readonly accumulated: Duration.Duration
  readonly activeSince?: number
}

export type ActiveTimeAvailability = ({ readonly _tag: "Available" } & ActiveTime) | { readonly _tag: "Unavailable" }

export const executionIntervals = (events: ReadonlyArray<ActiveEvent>): ReadonlyArray<Interval> | undefined => {
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
      if (accepted && Lifecycle.isTerminalEventType(event.type)) {
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
    if (Lifecycle.isTerminalEventType(event.type)) terminal = true
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

export const activeIntervals = (snapshot: Snapshot, threadId: string): ReadonlyArray<Interval> | undefined => {
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
