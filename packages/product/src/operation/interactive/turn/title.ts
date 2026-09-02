import type * as Thread from "@rika/product/thread-record"
import type * as ExecutionProjection from "@rika/product/execution-projection"
import { Cause, Effect } from "effect"
import type { InteractiveEvent } from "../session-event"
import type { InteractiveRuntimeContext } from "../session"
import { applyGeneratedTitle } from "../../thread-title"

/** Renames the Thread after its title Run and tells interactive clients and Thread summaries about the new title. */
export const publishGeneratedTitle = Effect.fn("InteractiveTurn.publishGeneratedTitle")(
  function* (
    input: InteractiveRuntimeContext,
    threadId: Thread.ThreadId,
    expectedTitle: string,
    result: ExecutionProjection.Result,
    dispatch: (event: InteractiveEvent) => void,
  ) {
    const renamed = yield* applyGeneratedTitle(threadId, expectedTitle, result)
    if (renamed === undefined) return
    input.emit(dispatch, { _tag: "ThreadTitled", threadId: String(renamed.id), title: renamed.title })
    yield* input.notifyThreadSummaries
  },
  Effect.catchCause((cause) => Effect.logWarning("thread-title.apply-failed", { cause: Cause.pretty(cause) })),
)
