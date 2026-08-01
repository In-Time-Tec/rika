import { Function } from "effect"
export interface Totals {
  readonly costUsd: number
  readonly pricedAttempts: number
  readonly unpricedAttempts: number
  readonly tokens: number
  readonly countedAttempts: number
  readonly uncountedAttempts: number
}

export const noTotals: Totals = {
  costUsd: 0,
  pricedAttempts: 0,
  unpricedAttempts: 0,
  tokens: 0,
  countedAttempts: 0,
  uncountedAttempts: 0,
}

const accumulateImpl = (left: Totals, right: Totals): Totals => ({
  costUsd: left.costUsd + right.costUsd,
  pricedAttempts: left.pricedAttempts + right.pricedAttempts,
  unpricedAttempts: left.unpricedAttempts + right.unpricedAttempts,
  tokens: left.tokens + right.tokens,
  countedAttempts: left.countedAttempts + right.countedAttempts,
  uncountedAttempts: left.uncountedAttempts + right.uncountedAttempts,
})

export const accumulate: {
  (arg1: Totals): (arg0: Totals) => ReturnType<typeof accumulateImpl>
  (arg0: Totals, arg1: Totals): ReturnType<typeof accumulateImpl>
} = Function.dual(2, accumulateImpl)

const differenceImpl = (next: Totals, previous: Totals): Totals => ({
  costUsd: next.costUsd - previous.costUsd,
  pricedAttempts: next.pricedAttempts - previous.pricedAttempts,
  unpricedAttempts: next.unpricedAttempts - previous.unpricedAttempts,
  tokens: next.tokens - previous.tokens,
  countedAttempts: next.countedAttempts - previous.countedAttempts,
  uncountedAttempts: next.uncountedAttempts - previous.uncountedAttempts,
})

export const difference: {
  (arg1: Totals): (arg0: Totals) => ReturnType<typeof differenceImpl>
  (arg0: Totals, arg1: Totals): ReturnType<typeof differenceImpl>
} = Function.dual(2, differenceImpl)

export const shifts = (delta: Totals): boolean =>
  delta.costUsd !== 0 ||
  delta.pricedAttempts !== 0 ||
  delta.unpricedAttempts !== 0 ||
  delta.tokens !== 0 ||
  delta.countedAttempts !== 0 ||
  delta.uncountedAttempts !== 0

const addUsageTotalsImpl = (left: Totals, right: Totals): Totals => accumulate(left, right)

export const addUsageTotals: {
  (arg1: Totals): (arg0: Totals) => ReturnType<typeof addUsageTotalsImpl>
  (arg0: Totals, arg1: Totals): ReturnType<typeof addUsageTotalsImpl>
} = Function.dual(2, addUsageTotalsImpl)
