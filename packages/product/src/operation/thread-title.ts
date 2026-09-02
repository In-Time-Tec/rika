import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "@rika/product/thread-repository"
import type * as ExecutionProjection from "@rika/product/execution-projection"
import { Clock, Effect } from "effect"
import { clampThreadTitle } from "../thread/query/title-policy"

/**
 * Renames a Thread to the title its title Run generated, but only while the Thread still carries the provisional
 * title the Run was asked to replace. Returns the renamed Thread, or `undefined` when nothing changed.
 */
export const applyGeneratedTitle = Effect.fn("ProductOperation.applyGeneratedTitle")(function* (
  threadId: Thread.ThreadId,
  expectedTitle: string,
  result: Pick<ExecutionProjection.Result, "state">,
) {
  const text = result.state.title?.text
  if (text === undefined) return undefined
  const title = clampThreadTitle(text)
  if (title.length === 0 || title === expectedTitle) return undefined
  const threads = yield* ThreadRepository.Service
  return yield* threads.renameIfTitle(threadId, expectedTitle, title, yield* Clock.currentTimeMillis)
})
