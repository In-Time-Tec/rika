export const pricingVersion = "provider-cost"

const nonNegativeFinite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined

const token = (value: Record<string, unknown>, key: string): number | undefined => nonNegativeFinite(value[key])

export type UsageTokens = { readonly _tag: "Available"; readonly total: number } | { readonly _tag: "Unavailable" }

export const usageTokens = (value: Record<string, unknown>): UsageTokens => {
  const input = token(value, "input_tokens")
  const output = token(value, "output_tokens")
  if (input === undefined || output === undefined) return { _tag: "Unavailable" }
  return { _tag: "Available", total: input + output }
}
