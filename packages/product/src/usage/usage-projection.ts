import * as ExecutionEvent from "@rika/product/execution-event"
import { Duration, Function, Result } from "effect"
import * as TranscriptCorrelation from "@rika/transcript/child-parent-correlation"
import * as ActiveTime from "./usage-active-time"
import * as UsageEvent from "./usage-event"
import * as UsageFold from "./usage-fold"
import type { RootExecution } from "./usage-event"
import type { Snapshot } from "./usage-snapshot"
import { noTotals, type Totals } from "./usage-total"

export const materialize: {
  (
    turnId: string,
    threadId: string,
  ): (snapshot: Snapshot) => {
    readonly costNanoUsd?: number
    readonly tokens?: number
    readonly activeMillis?: number
    readonly activeIntervals?: ReadonlyArray<ActiveTime.Interval>
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
    readonly activeIntervals?: ReadonlyArray<ActiveTime.Interval>
    readonly pricedAttempts: number
    readonly unpricedAttempts: number
    readonly countedAttempts: number
    readonly uncountedAttempts: number
    readonly sourceComplete: false
  }
} = Function.dual(3, (snapshot: Snapshot, turnId: string, threadId: string) => {
  const totals = turnTotals(snapshot, turnId)
  const time = ActiveTime.activeTime(snapshot, threadId)
  const intervals = ActiveTime.activeIntervals(snapshot, threadId)
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

export const turnTotals: {
  (snapshot: Snapshot, turnId: string): Totals
  (turnId: string): (snapshot: Snapshot) => Totals
} = Function.dual(2, (snapshot: Snapshot, turnId: string): Totals => snapshot.turns.get(turnId) ?? noTotals)

export const threadTotals: {
  (snapshot: Snapshot, threadId: string): Totals
  (threadId: string): (snapshot: Snapshot) => Totals
} = Function.dual(2, (snapshot: Snapshot, threadId: string): Totals => snapshot.threads.get(threadId) ?? noTotals)

export const observe: {
  (
    input: RootExecution & { readonly event: ExecutionEvent.Event },
  ): (snapshot: Snapshot) => Result.Result<Snapshot, UsageEvent.ProjectionFailure>
  (
    snapshot: Snapshot,
    input: RootExecution & { readonly event: ExecutionEvent.Event },
  ): Result.Result<Snapshot, UsageEvent.ProjectionFailure>
} = Function.dual(2, (snapshot: Snapshot, input: RootExecution & { readonly event: ExecutionEvent.Event }) => {
  const fold = UsageFold.restoreUsageFold(snapshot)
  const applied = UsageFold.applyUsageFoldEvent(fold, input)
  if (Result.isFailure(applied)) return Result.fail(applied.failure)
  return Result.succeed(UsageFold.usageFoldChanged(fold) ? UsageFold.snapshotUsageFold(fold) : snapshot)
})

const isSnapshot = (value: unknown): value is Snapshot =>
  typeof value === "object" && value !== null && "turns" in value && value.turns instanceof Map

export const foldBatch: {
  (
    observations: ReadonlyArray<RootExecution & { readonly event: ExecutionEvent.Event }>,
    completeExecutionIds?: ReadonlySet<string>,
  ): (snapshot: Snapshot) => Result.Result<Snapshot, UsageEvent.ProjectionFailure>
  (
    snapshot: Snapshot,
    observations: ReadonlyArray<RootExecution & { readonly event: ExecutionEvent.Event }>,
    completeExecutionIds?: ReadonlySet<string>,
  ): Result.Result<Snapshot, UsageEvent.ProjectionFailure>
} = Function.dual(
  (args): boolean => args.length > 0 && isSnapshot(args[0]),
  (
    snapshot: Snapshot,
    observations: ReadonlyArray<RootExecution & { readonly event: ExecutionEvent.Event }>,
    completeExecutionIds: ReadonlySet<string> = new Set(),
  ) => {
    const folded = UsageFold.foldEvents(snapshot, observations)
    if (Result.isFailure(folded)) return folded
    for (const identity of completeExecutionIds) {
      const executionId = TranscriptCorrelation.executionKey(identity)
      const events = folded.success.executionEvents.get(executionId) ?? []
      const complete = UsageFold.completeExecution(folded.success, new Set([identity]))
      if (events.length === 0 || Result.isFailure(complete))
        return complete as Result.Result<Snapshot, UsageEvent.ProjectionFailure>
    }
    return folded
  },
)
