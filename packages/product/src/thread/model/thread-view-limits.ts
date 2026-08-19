import { Schema } from "effect"
import { PageCursor } from "./transcript-page"

const PositiveProjectionVersion = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

export const limits = {
  pending: 64,
  patchItems: 120,
  turnChanges: 6,
} as const

export const ThreadViewSource = Schema.Struct({
  projectionVersion: PositiveProjectionVersion,
  oldestCursor: Schema.optionalKey(PageCursor),
  newestCursor: Schema.optionalKey(PageCursor),
})
export type ThreadViewSource = typeof ThreadViewSource.Type

export const duplicateKey = (values: ReadonlyArray<string>): string | undefined => {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) return value
    seen.add(value)
  }
  return undefined
}
