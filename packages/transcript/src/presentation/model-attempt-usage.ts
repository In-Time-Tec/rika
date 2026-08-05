export const pricingVersion = "provider-cost"

const nonNegativeFinite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined

const token = (value: Record<string, unknown>, key: string): number | undefined => nonNegativeFinite(value[key])

export type UsageTokens = { readonly _tag: "Available"; readonly total: number } | { readonly _tag: "Unavailable" }

export const usageInputTokens = (value: Record<string, unknown>): UsageTokens => {
  const input = token(value, "input_tokens")
  return input === undefined ? { _tag: "Unavailable" } : { _tag: "Available", total: input }
}

export const usageTokens = (value: Record<string, unknown>): UsageTokens => {
  const input = usageInputTokens(value)
  const output = token(value, "output_tokens")
  if (input._tag === "Unavailable" || output === undefined) return { _tag: "Unavailable" }
  return { _tag: "Available", total: input.total + output }
}
