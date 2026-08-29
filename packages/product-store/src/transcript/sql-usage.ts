import * as ExecutionProjection from "@rika/product/execution-projection"
import { ContextCapacity, UsageSummary } from "@rika/product/transcript-page"
import type { Turn } from "@rika/product/turn-record"
import { and, asc, desc, eq, isNotNull } from "drizzle-orm"
import type * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Effect, Schema } from "effect"
import { rikaTranscriptThreadUsage, rikaTranscriptTurnUsage } from "../database/schema/product"

type Transaction = Parameters<Parameters<PgDrizzle.EffectPgDatabase["transaction"]>[0]>[0]

const OptionalSum = Schema.Struct({ sum: Schema.Finite, present: Schema.Int })
const UsageAccumulator = Schema.Struct({
  contributions: Schema.Int,
  incomplete: Schema.Int,
  costNanoUsd: OptionalSum,
  tokens: Schema.Int,
  tokenTotal: OptionalSum,
  inputTotal: OptionalSum,
  inputUncached: OptionalSum,
  inputCacheRead: OptionalSum,
  inputCacheWrite: OptionalSum,
  outputTotal: OptionalSum,
  outputText: OptionalSum,
  outputReasoning: OptionalSum,
  failedProviderTotal: OptionalSum,
  pricedAttempts: Schema.Finite,
  unpricedAttempts: Schema.Finite,
  includedAttempts: Schema.Finite,
  countedAttempts: Schema.Finite,
  uncountedAttempts: Schema.Finite,
  activeAvailable: Schema.Int,
  activeAccumulatedMillis: Schema.Finite,
})
type UsageAccumulator = typeof UsageAccumulator.Type

const emptyAccumulator: UsageAccumulator = {
  contributions: 0,
  incomplete: 0,
  costNanoUsd: { sum: 0, present: 0 },
  tokens: 0,
  tokenTotal: { sum: 0, present: 0 },
  inputTotal: { sum: 0, present: 0 },
  inputUncached: { sum: 0, present: 0 },
  inputCacheRead: { sum: 0, present: 0 },
  inputCacheWrite: { sum: 0, present: 0 },
  outputTotal: { sum: 0, present: 0 },
  outputText: { sum: 0, present: 0 },
  outputReasoning: { sum: 0, present: 0 },
  failedProviderTotal: { sum: 0, present: 0 },
  pricedAttempts: 0,
  unpricedAttempts: 0,
  includedAttempts: 0,
  countedAttempts: 0,
  uncountedAttempts: 0,
  activeAvailable: 0,
  activeAccumulatedMillis: 0,
}

const UsageJson = Schema.fromJsonString(ExecutionProjection.UsageState)
const ContextCapacityJson = Schema.fromJsonString(ContextCapacity)
const AccumulatorJson = Schema.fromJsonString(UsageAccumulator)
const SummaryJson = Schema.fromJsonString(UsageSummary)
const encodeUsage = Schema.encodeSync(UsageJson)
const decodeUsage = Schema.decodeSync(UsageJson)
const encodeCapacity = Schema.encodeSync(ContextCapacityJson)
const decodeCapacity = Schema.decodeSync(ContextCapacityJson)
const encodeAccumulator = Schema.encodeSync(AccumulatorJson)
const decodeAccumulator = Schema.decodeSync(AccumulatorJson)
const encodeSummary = Schema.encodeSync(SummaryJson)
const emptyAccumulatorJson = encodeAccumulator(emptyAccumulator)
const emptySummaryJson = encodeSummary({ usage: ExecutionProjection.emptyUsageState() })

const replaceOptional = (
  current: typeof OptionalSum.Type,
  previous: number | undefined,
  next: number | undefined,
): typeof OptionalSum.Type => ({
  sum: current.sum - (previous ?? 0) + (next ?? 0),
  present: current.present - (previous === undefined ? 0 : 1) + (next === undefined ? 0 : 1),
})

const activeMillis = (usage: ExecutionProjection.UsageState | undefined) =>
  usage?.active._tag === "Available" ? usage.active.accumulatedMillis : 0

const replaceContribution = (
  current: UsageAccumulator,
  previous: ExecutionProjection.UsageState | undefined,
  next: ExecutionProjection.UsageState,
): UsageAccumulator => ({
  contributions: current.contributions + (previous === undefined ? 1 : 0),
  incomplete: current.incomplete - (previous?.sourceComplete === false ? 1 : 0) + (next.sourceComplete ? 0 : 1),
  costNanoUsd: replaceOptional(current.costNanoUsd, previous?.costNanoUsd, next.costNanoUsd),
  tokens: current.tokens - (previous?.tokens === undefined ? 0 : 1) + (next.tokens === undefined ? 0 : 1),
  tokenTotal: replaceOptional(current.tokenTotal, previous?.tokens?.total, next.tokens?.total),
  inputTotal: replaceOptional(current.inputTotal, previous?.tokens?.input.total, next.tokens?.input.total),
  inputUncached: replaceOptional(current.inputUncached, previous?.tokens?.input.uncached, next.tokens?.input.uncached),
  inputCacheRead: replaceOptional(
    current.inputCacheRead,
    previous?.tokens?.input.cacheRead,
    next.tokens?.input.cacheRead,
  ),
  inputCacheWrite: replaceOptional(
    current.inputCacheWrite,
    previous?.tokens?.input.cacheWrite,
    next.tokens?.input.cacheWrite,
  ),
  outputTotal: replaceOptional(current.outputTotal, previous?.tokens?.output.total, next.tokens?.output.total),
  outputText: replaceOptional(current.outputText, previous?.tokens?.output.text, next.tokens?.output.text),
  outputReasoning: replaceOptional(
    current.outputReasoning,
    previous?.tokens?.output.reasoning,
    next.tokens?.output.reasoning,
  ),
  failedProviderTotal: replaceOptional(
    current.failedProviderTotal,
    previous?.tokens?.failedProviderTotal,
    next.tokens?.failedProviderTotal,
  ),
  pricedAttempts: current.pricedAttempts - (previous?.pricedAttempts ?? 0) + next.pricedAttempts,
  unpricedAttempts: current.unpricedAttempts - (previous?.unpricedAttempts ?? 0) + next.unpricedAttempts,
  includedAttempts: current.includedAttempts - (previous?.includedAttempts ?? 0) + (next.includedAttempts ?? 0),
  countedAttempts: current.countedAttempts - (previous?.countedAttempts ?? 0) + next.countedAttempts,
  uncountedAttempts: current.uncountedAttempts - (previous?.uncountedAttempts ?? 0) + next.uncountedAttempts,
  activeAvailable:
    current.activeAvailable -
    (previous?.active._tag === "Available" ? 1 : 0) +
    (next.active._tag === "Available" ? 1 : 0),
  activeAccumulatedMillis: current.activeAccumulatedMillis - activeMillis(previous) + activeMillis(next),
})

const optional = (value: typeof OptionalSum.Type) => (value.present === 0 ? undefined : value.sum)

const summarize = (
  accumulator: UsageAccumulator,
  newest: ExecutionProjection.UsageState | undefined,
  context: ExecutionProjection.UsageState | undefined,
  contextCapacity: ContextCapacity | undefined,
  activeSince: number | undefined,
): UsageSummary => {
  const input: ExecutionProjection.TokenTotals["input"] = {}
  const output: ExecutionProjection.TokenTotals["output"] = {}
  const inputTotal = optional(accumulator.inputTotal)
  const inputUncached = optional(accumulator.inputUncached)
  const inputCacheRead = optional(accumulator.inputCacheRead)
  const inputCacheWrite = optional(accumulator.inputCacheWrite)
  const outputTotal = optional(accumulator.outputTotal)
  const outputText = optional(accumulator.outputText)
  const outputReasoning = optional(accumulator.outputReasoning)
  if (inputTotal !== undefined) Object.assign(input, { total: inputTotal })
  if (inputUncached !== undefined) Object.assign(input, { uncached: inputUncached })
  if (inputCacheRead !== undefined) Object.assign(input, { cacheRead: inputCacheRead })
  if (inputCacheWrite !== undefined) Object.assign(input, { cacheWrite: inputCacheWrite })
  if (outputTotal !== undefined) Object.assign(output, { total: outputTotal })
  if (outputText !== undefined) Object.assign(output, { text: outputText })
  if (outputReasoning !== undefined) Object.assign(output, { reasoning: outputReasoning })
  let active: ExecutionProjection.UsageState["active"]
  if (accumulator.activeAvailable === 0) active = { _tag: "Unavailable" }
  else if (activeSince === undefined)
    active = { _tag: "Available", accumulatedMillis: accumulator.activeAccumulatedMillis }
  else active = { _tag: "Available", accumulatedMillis: accumulator.activeAccumulatedMillis, activeSince }
  const usage: ExecutionProjection.UsageState = {
    pricedAttempts: accumulator.pricedAttempts,
    unpricedAttempts: accumulator.unpricedAttempts,
    includedAttempts: accumulator.includedAttempts,
    countedAttempts: accumulator.countedAttempts,
    uncountedAttempts: accumulator.uncountedAttempts,
    sourceComplete: accumulator.contributions > 0 && accumulator.incomplete === 0,
    contextPending: newest?.contextPending ?? false,
    active,
  }
  const costNanoUsd = optional(accumulator.costNanoUsd)
  if (accumulator.pricedAttempts > 0 && costNanoUsd !== undefined) Object.assign(usage, { costNanoUsd })
  if (accumulator.tokens > 0) {
    const tokens: ExecutionProjection.TokenTotals = { input, output }
    const total = optional(accumulator.tokenTotal)
    const failedProviderTotal = optional(accumulator.failedProviderTotal)
    if (total !== undefined) Object.assign(tokens, { total })
    if (failedProviderTotal !== undefined) Object.assign(tokens, { failedProviderTotal })
    Object.assign(usage, { tokens })
  }
  if (context?.context !== undefined) Object.assign(usage, { context: context.context })
  return contextCapacity === undefined ? { usage } : { usage, contextCapacity }
}

export const updateThreadUsage = Effect.fn("TranscriptRepository.updateThreadUsage")(function* (
  tx: Transaction,
  turn: Turn,
  next: ExecutionProjection.UsageState,
  now: number,
) {
  yield* tx
    .insert(rikaTranscriptThreadUsage)
    .values({
      threadId: turn.threadId,
      accumulatorJson: emptyAccumulatorJson,
      summaryJson: emptySummaryJson,
      updatedAt: now,
    })
    .onConflictDoNothing()
  const aggregate = (yield* tx
    .select({ accumulatorJson: rikaTranscriptThreadUsage.accumulatorJson })
    .from(rikaTranscriptThreadUsage)
    .where(eq(rikaTranscriptThreadUsage.threadId, turn.threadId))
    .for("update")
    .limit(1))[0]!
  const stored = (yield* tx
    .select({ usageJson: rikaTranscriptTurnUsage.usageJson })
    .from(rikaTranscriptTurnUsage)
    .where(eq(rikaTranscriptTurnUsage.turnId, turn.id))
    .limit(1))[0]
  const previous = stored === undefined ? undefined : decodeUsage(stored.usageJson)
  const contextCapacity =
    next.context === undefined || turn._tag !== "AgentExecution"
      ? undefined
      : {
          contextWindow: turn.executionRoute.main.compaction.contextWindow,
          reserveTokens: turn.executionRoute.main.compaction.reserveTokens,
        }
  yield* tx
    .insert(rikaTranscriptTurnUsage)
    .values({
      turnId: turn.id,
      threadId: turn.threadId,
      createdAt: turn.createdAt,
      usageJson: encodeUsage(next),
      hasContext: next.context !== undefined,
      contextCapacityJson: contextCapacity === undefined ? null : encodeCapacity(contextCapacity),
      activeSince: next.active._tag === "Available" ? (next.active.activeSince ?? null) : null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: rikaTranscriptTurnUsage.turnId,
      set: {
        usageJson: encodeUsage(next),
        hasContext: next.context !== undefined,
        contextCapacityJson: contextCapacity === undefined ? null : encodeCapacity(contextCapacity),
        activeSince: next.active._tag === "Available" ? (next.active.activeSince ?? null) : null,
        updatedAt: now,
      },
    })
  const accumulator = replaceContribution(decodeAccumulator(aggregate.accumulatorJson), previous, next)
  const newestRow = (yield* tx
    .select({ usageJson: rikaTranscriptTurnUsage.usageJson })
    .from(rikaTranscriptTurnUsage)
    .where(eq(rikaTranscriptTurnUsage.threadId, turn.threadId))
    .orderBy(desc(rikaTranscriptTurnUsage.createdAt), desc(rikaTranscriptTurnUsage.turnId))
    .limit(1))[0]
  const contextRow = (yield* tx
    .select({
      usageJson: rikaTranscriptTurnUsage.usageJson,
      contextCapacityJson: rikaTranscriptTurnUsage.contextCapacityJson,
    })
    .from(rikaTranscriptTurnUsage)
    .where(and(eq(rikaTranscriptTurnUsage.threadId, turn.threadId), eq(rikaTranscriptTurnUsage.hasContext, true)))
    .orderBy(desc(rikaTranscriptTurnUsage.createdAt), desc(rikaTranscriptTurnUsage.turnId))
    .limit(1))[0]
  const activeRow = (yield* tx
    .select({ activeSince: rikaTranscriptTurnUsage.activeSince })
    .from(rikaTranscriptTurnUsage)
    .where(and(eq(rikaTranscriptTurnUsage.threadId, turn.threadId), isNotNull(rikaTranscriptTurnUsage.activeSince)))
    .orderBy(asc(rikaTranscriptTurnUsage.activeSince))
    .limit(1))[0]
  const summary = summarize(
    accumulator,
    newestRow === undefined ? undefined : decodeUsage(newestRow.usageJson),
    contextRow === undefined ? undefined : decodeUsage(contextRow.usageJson),
    contextRow?.contextCapacityJson === null || contextRow?.contextCapacityJson === undefined
      ? undefined
      : decodeCapacity(contextRow.contextCapacityJson),
    activeRow?.activeSince ?? undefined,
  )
  yield* tx
    .update(rikaTranscriptThreadUsage)
    .set({ accumulatorJson: encodeAccumulator(accumulator), summaryJson: encodeSummary(summary), updatedAt: now })
    .where(eq(rikaTranscriptThreadUsage.threadId, turn.threadId))
})
