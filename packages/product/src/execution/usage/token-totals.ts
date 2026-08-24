import { Schema } from "effect"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const OptionalTokenCount = Schema.optionalKey(Count)

export const InputTokenTotals = Schema.Struct({
  total: OptionalTokenCount,
  uncached: OptionalTokenCount,
  cacheRead: OptionalTokenCount,
  cacheWrite: OptionalTokenCount,
})
export type InputTokenTotals = typeof InputTokenTotals.Type

export const OutputTokenTotals = Schema.Struct({
  total: OptionalTokenCount,
  text: OptionalTokenCount,
  reasoning: OptionalTokenCount,
})
export type OutputTokenTotals = typeof OutputTokenTotals.Type

export const TokenTotals = Schema.Struct({
  total: OptionalTokenCount,
  input: InputTokenTotals,
  output: OutputTokenTotals,
  failedProviderTotal: OptionalTokenCount,
})
export type TokenTotals = typeof TokenTotals.Type

export const addOptional = (values: ReadonlyArray<number | undefined>): number | undefined =>
  values.some((value) => value !== undefined)
    ? values.reduce<number>((total, value) => total + (value ?? 0), 0)
    : undefined

export const sumTokenTotals = (values: ReadonlyArray<TokenTotals | undefined>): TokenTotals | undefined => {
  if (!values.some((value) => value !== undefined)) return undefined
  const total = addOptional(values.map((value) => value?.total))
  const inputTotal = addOptional(values.map((value) => value?.input.total))
  const inputUncached = addOptional(values.map((value) => value?.input.uncached))
  const inputCacheRead = addOptional(values.map((value) => value?.input.cacheRead))
  const inputCacheWrite = addOptional(values.map((value) => value?.input.cacheWrite))
  const outputTotal = addOptional(values.map((value) => value?.output.total))
  const outputText = addOptional(values.map((value) => value?.output.text))
  const outputReasoning = addOptional(values.map((value) => value?.output.reasoning))
  const failedProviderTotal = addOptional(values.map((value) => value?.failedProviderTotal))
  let input: InputTokenTotals = {}
  if (inputTotal !== undefined) input = { ...input, total: inputTotal }
  if (inputUncached !== undefined) input = { ...input, uncached: inputUncached }
  if (inputCacheRead !== undefined) input = { ...input, cacheRead: inputCacheRead }
  if (inputCacheWrite !== undefined) input = { ...input, cacheWrite: inputCacheWrite }
  let output: OutputTokenTotals = {}
  if (outputTotal !== undefined) output = { ...output, total: outputTotal }
  if (outputText !== undefined) output = { ...output, text: outputText }
  if (outputReasoning !== undefined) output = { ...output, reasoning: outputReasoning }
  let totals: TokenTotals = { input, output }
  if (total !== undefined) totals = { ...totals, total }
  if (failedProviderTotal !== undefined) totals = { ...totals, failedProviderTotal }
  return totals
}
