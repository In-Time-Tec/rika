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
const count = (condition: boolean) => (condition ? 1 : 0)
const replaceInputTotals = (
  current: UsageAccumulator,
  previous: ExecutionProjection.UsageState | undefined,
  next: ExecutionProjection.UsageState,
) => ({
  inputTotal: replaceOptional(current.inputTotal, previous?.tokens?.input.total, next.tokens?.input.total),
  inputUncached: replaceOptional(current.inputUncached, previous?.tokens?.input.uncached, next.tokens?.input.uncached),
  ...replaceInputCacheTotals(current, previous, next),
})
const replaceInputCacheTotals = (
  current: UsageAccumulator,
  previous: ExecutionProjection.UsageState | undefined,
  next: ExecutionProjection.UsageState,
) => ({
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
})
const replaceOutputTotals = (
  current: UsageAccumulator,
  previous: ExecutionProjection.UsageState | undefined,
  next: ExecutionProjection.UsageState,
) => ({
  tokenTotal: replaceOptional(current.tokenTotal, previous?.tokens?.total, next.tokens?.total),
  outputTotal: replaceOptional(current.outputTotal, previous?.tokens?.output.total, next.tokens?.output.total),
  outputText: replaceOptional(current.outputText, previous?.tokens?.output.text, next.tokens?.output.text),
  ...replaceOutputRemainder(current, previous, next),
})
const replaceOutputRemainder = (
  current: UsageAccumulator,
  previous: ExecutionProjection.UsageState | undefined,
  next: ExecutionProjection.UsageState,
) => ({
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
})

const replaceContribution = (
  current: UsageAccumulator,
  previous: ExecutionProjection.UsageState | undefined,
  next: ExecutionProjection.UsageState,
): UsageAccumulator => ({
  ...replaceInputTotals(current, previous, next),
  ...replaceOutputTotals(current, previous, next),
  contributions: current.contributions + count(previous === undefined),
  incomplete: current.incomplete - count(previous?.sourceComplete === false) + count(!next.sourceComplete),
  costNanoUsd: replaceOptional(current.costNanoUsd, previous?.costNanoUsd, next.costNanoUsd),
  tokens: current.tokens - count(previous?.tokens !== undefined) + count(next.tokens !== undefined),
  ...replaceAttemptTotals(current, previous, next),
  activeAvailable:
    current.activeAvailable - count(previous?.active._tag === "Available") + count(next.active._tag === "Available"),
  activeAccumulatedMillis: current.activeAccumulatedMillis - activeMillis(previous) + activeMillis(next),
})

const replaceAttemptTotals = (
  current: UsageAccumulator,
  previous: ExecutionProjection.UsageState | undefined,
  next: ExecutionProjection.UsageState,
) => ({
  pricedAttempts: current.pricedAttempts - (previous?.pricedAttempts ?? 0) + next.pricedAttempts,
  unpricedAttempts: current.unpricedAttempts - (previous?.unpricedAttempts ?? 0) + next.unpricedAttempts,
  includedAttempts: current.includedAttempts - (previous?.includedAttempts ?? 0) + (next.includedAttempts ?? 0),
  countedAttempts: current.countedAttempts - (previous?.countedAttempts ?? 0) + next.countedAttempts,
  uncountedAttempts: current.uncountedAttempts - (previous?.uncountedAttempts ?? 0) + next.uncountedAttempts,
})

const optional = (value: typeof OptionalSum.Type) => (value.present === 0 ? undefined : value.sum)

const tokenParts = (accumulator: UsageAccumulator) => {
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
  return { input, output }
}

const activeUsage = (accumulator: UsageAccumulator, activeSince: number | undefined) => {
  if (accumulator.activeAvailable === 0) return { _tag: "Unavailable" as const }
  const available = { _tag: "Available" as const, accumulatedMillis: accumulator.activeAccumulatedMillis }
  return activeSince === undefined ? available : { ...available, activeSince }
}

const summarize = (
  accumulator: UsageAccumulator,
  newest: ExecutionProjection.UsageState | undefined,
  context: ExecutionProjection.UsageState | undefined,
  contextCapacity: ContextCapacity | undefined,
  activeSince: number | undefined,
): UsageSummary => {
  const { input, output } = tokenParts(accumulator)
  const usage: ExecutionProjection.UsageState = {
    pricedAttempts: accumulator.pricedAttempts,
    unpricedAttempts: accumulator.unpricedAttempts,
    includedAttempts: accumulator.includedAttempts,
    countedAttempts: accumulator.countedAttempts,
    uncountedAttempts: accumulator.uncountedAttempts,
    sourceComplete: accumulator.contributions > 0 && accumulator.incomplete === 0,
    contextPending: newest?.contextPending ?? false,
    active: activeUsage(accumulator, activeSince),
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

const contextCapacityFor = (turn: Turn, next: ExecutionProjection.UsageState): ContextCapacity | undefined => {
  if (next.context === undefined || turn._tag !== "AgentExecution") return undefined
  return {
    contextWindow: turn.executionRoute.main.compaction.contextWindow,
    reserveTokens: turn.executionRoute.main.compaction.reserveTokens,
  }
}

const decodeOptionalUsage = (row: { readonly usageJson: string } | undefined) =>
  row === undefined ? undefined : decodeUsage(row.usageJson)

const decodeOptionalCapacity = (value: string | null | undefined) =>
  value === null || value === undefined ? undefined : decodeCapacity(value)

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
  const contextCapacity = contextCapacityFor(turn, next)
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
    decodeOptionalUsage(newestRow),
    decodeOptionalUsage(contextRow),
    decodeOptionalCapacity(contextRow?.contextCapacityJson),
    activeRow?.activeSince ?? undefined,
  )
  yield* tx
    .update(rikaTranscriptThreadUsage)
    .set({ accumulatorJson: encodeAccumulator(accumulator), summaryJson: encodeSummary(summary), updatedAt: now })
    .where(eq(rikaTranscriptThreadUsage.threadId, turn.threadId))
})
