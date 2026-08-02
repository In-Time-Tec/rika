import { Schema } from "effect"

const NonEmptyString = Schema.String.check(Schema.isMinLength(1))
const BoundedText = Schema.String.check(Schema.isMaxLength(8_000))
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
const PreviewLimit = PositiveInt.check(Schema.isLessThanOrEqualTo(20))
export const Result = Schema.Struct({ text: Schema.String, truncated: Schema.Boolean })
export type Result = typeof Result.Type
export class ToolError extends Schema.TaggedErrorClass<ToolError>()("ThreadToolError", {
  tool: Schema.String,
  message: Schema.String,
}) {}
export const ToolFailure = Schema.Struct({
  _tag: Schema.tag("ThreadToolError"),
  tool: Schema.String,
  code: Schema.Literals(["not_found", "invalid_state", "unavailable", "timeout", "operation"]),
  message: BoundedText,
  retryable: Schema.Boolean,
})
const TurnCursor = Schema.Struct({ createdAt: Schema.Finite, id: NonEmptyString })
const TranscriptCursor = Schema.Struct({
  createdAt: Schema.Finite,
  turnId: NonEmptyString,
  orderKey: NonEmptyString,
})
const SubtreeCursor = Schema.Union([
  Schema.Struct({
    offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    before: Schema.optionalKey(TranscriptCursor),
  }),
  Schema.Struct({ before: TranscriptCursor }),
])
const RelationshipCursor = Schema.Struct({ createdAt: Schema.Finite, targetTurnId: NonEmptyString })
const ReadSelection = Schema.Union([
  Schema.Struct({ mode: Schema.tag("overview") }),
  Schema.Struct({
    mode: Schema.tag("recent"),
    limit: Schema.optionalKey(PreviewLimit),
    cursor: Schema.optionalKey(TurnCursor),
  }),
  Schema.Struct({
    mode: Schema.tag("relevant"),
    query: NonEmptyString,
    limit: Schema.optionalKey(PreviewLimit),
    cursor: Schema.optionalKey(TranscriptCursor),
  }),
  Schema.Struct({
    mode: Schema.tag("subtree"),
    childExecutionId: NonEmptyString,
    cursor: Schema.optionalKey(SubtreeCursor),
  }),
  Schema.Struct({ mode: Schema.tag("related"), cursor: Schema.optionalKey(RelationshipCursor) }),
])
export const ReadThreadInput = Schema.Struct({
  threadId: NonEmptyString,
  includeArchived: Schema.optionalKey(Schema.Boolean),
  selection: Schema.optionalKey(ReadSelection),
  maxTurns: Schema.optionalKey(PositiveInt),
  maxChars: Schema.optionalKey(PositiveInt),
})
