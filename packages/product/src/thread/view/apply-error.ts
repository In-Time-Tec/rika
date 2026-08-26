import { Schema } from "effect"
import * as Thread from "../model/record"

const NonNegativeRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export class ResyncRequired extends Schema.TaggedError<ResyncRequired>()("ResyncRequired", {
  threadId: Thread.ThreadId,
  expectedRevision: NonNegativeRevision,
  receivedBaseRevision: NonNegativeRevision,
  currentRevision: NonNegativeRevision,
}) {}

export class ThreadViewForeignThread extends Schema.TaggedError<ThreadViewForeignThread>()("ThreadViewForeignThread", {
  expectedThreadId: Thread.ThreadId,
  receivedThreadId: Thread.ThreadId,
}) {}

export class ThreadViewNonMonotonicRevision extends Schema.TaggedError<ThreadViewNonMonotonicRevision>()(
  "ThreadViewNonMonotonicRevision",
  {
    threadId: Thread.ThreadId,
    baseRevision: NonNegativeRevision,
    revision: NonNegativeRevision,
  },
) {}

export class ThreadViewDuplicateItem extends Schema.TaggedError<ThreadViewDuplicateItem>()("ThreadViewDuplicateItem", {
  threadId: Thread.ThreadId,
  collection: Schema.Literals(["snapshot-turns", "snapshot-units", "pending", "upsert", "remove", "turn-changes"]),
  key: Schema.String,
}) {}

export class ThreadViewInvalidPatch extends Schema.TaggedError<ThreadViewInvalidPatch>()("ThreadViewInvalidPatch", {
  threadId: Thread.ThreadId,
  reason: Schema.Literals([
    "conflicting-item-change",
    "missing-item",
    "missing-turn",
    "unit-turn-mismatch",
    "unit-revision-regressed",
    "turn-thread-mismatch",
    "projection-revision-regressed",
    "bounds-exceeded",
    "invalid-header",
  ]),
  key: Schema.optionalKey(Schema.String),
}) {}

export const ThreadViewApplyError = Schema.Union([
  ResyncRequired,
  ThreadViewForeignThread,
  ThreadViewNonMonotonicRevision,
  ThreadViewDuplicateItem,
  ThreadViewInvalidPatch,
])
export type ThreadViewApplyError = typeof ThreadViewApplyError.Type
