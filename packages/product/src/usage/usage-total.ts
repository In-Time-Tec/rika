export interface UsageTotal {
  readonly costNanoUsd: number
  readonly tokens: number
  readonly activeMillis: number
}

export const addUsageTotals = (left: UsageTotal, right: UsageTotal): UsageTotal => ({
  costNanoUsd: left.costNanoUsd + right.costNanoUsd,
  tokens: left.tokens + right.tokens,
  activeMillis: left.activeMillis + right.activeMillis,
})
