import type { Totals } from "./usage-total"

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

const stringField = (data: Readonly<Record<string, unknown>> | undefined, name: string) => {
  const value = data?.[name]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value !== null && typeof value === "object") {
    const object = value as Readonly<Record<string, unknown>>
    return `{${Object.keys(object)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`
  }
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

export const Attempt = {
  stringField,
  canonicalJson,
  providerCostUsd,
  providerPriced,
  unpriceable,
  countedTokens,
  uncountable,
  settle,
  contribution,
}
