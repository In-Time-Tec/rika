import { Schema } from "effect"

const NonEmptyString = Schema.String.check(Schema.isMinLength(1))
const ListText = Schema.String.check(Schema.isMaxLength(128))
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
const FindLimit = PositiveInt.check(Schema.isLessThanOrEqualTo(50))

export const ThreadState = Schema.Literals(["idle", "queued", "running", "error"])
export type ThreadState = typeof ThreadState.Type
export const findDefaultLimit = 10
export const findMaximumLimit = 50
export const FindThreadInput = Schema.Struct({
  query: NonEmptyString,
  includeArchived: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(FindLimit),
})
export const FindThreadSuccess = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  threads: Schema.Array(
    Schema.Struct({
      threadId: NonEmptyString,
      state: ThreadState,
      archived: Schema.Boolean,
      title: ListText,
      updatedAt: NonEmptyString,
      summary: ListText,
      truncated: Schema.Boolean,
    }),
  ).check(Schema.isMaxLength(50)),
  truncated: Schema.Boolean,
})
