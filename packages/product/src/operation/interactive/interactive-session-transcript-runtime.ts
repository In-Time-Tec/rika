import * as UsageSnapshot from "@rika/product/usage-snapshot"
import { Function } from "effect"
import type { InteractiveEvent } from "./interactive-event"
import {
  makeInitialTranscriptWindow,
  makeInteractiveTranscriptPage,
  type InteractiveTranscriptPageLoader,
} from "./interactive-transcript-page"
import {
  makeInteractiveTranscriptLifecycle,
  type InteractiveTranscriptLifecycleInput,
} from "./interactive-transcript-lifecycle"
import type { ThreadContext } from "./interactive-thread-context"
import type { InteractiveRuntimeContext } from "./interactive-session-runtime"

const persistedThreadUsageImpl = (
  value: UsageSnapshot.Aggregate,
  context: ThreadContext,
): Pick<
  Extract<InteractiveEvent, { readonly _tag: "ThreadUsageUpdated" }>,
  "context" | "cost" | "tokens" | "time"
> => ({
  context,
  cost:
    value.costNanoUsd === undefined
      ? { _tag: "Unavailable" }
      : { _tag: "Available", usd: value.costNanoUsd / 1_000_000_000, unpricedAttempts: value.unpricedAttempts },
  tokens:
    value.tokens === undefined
      ? { _tag: "Unavailable" }
      : { _tag: "Available", total: value.tokens, uncountedAttempts: value.uncountedAttempts },
  time:
    value.activeMillis === undefined
      ? { _tag: "Unavailable" }
      : {
          _tag: "Available",
          accumulatedMillis: value.activeMillis,
          ...(value.activeSince === undefined ? {} : { activeSince: value.activeSince }),
        },
})

export const persistedThreadUsage: {
  (value: UsageSnapshot.Aggregate, context: ThreadContext): ReturnType<typeof persistedThreadUsageImpl>
  (context: ThreadContext): (value: UsageSnapshot.Aggregate) => ReturnType<typeof persistedThreadUsageImpl>
} = Function.dual(2, persistedThreadUsageImpl)

export const makeInteractiveTranscript = (input: InteractiveRuntimeContext) => {
  const lifecycleInput: InteractiveTranscriptLifecycleInput = {
    ...input,
    persistedThreadUsage,
    loadTranscriptPage: undefined as never,
  }
  const lifecycle = makeInteractiveTranscriptLifecycle(lifecycleInput)
  const initialTranscriptWindow = makeInitialTranscriptWindow(input)
  const loadTranscriptPage = makeInteractiveTranscriptPage({
    ...input,
    ...lifecycle,
    initialTranscriptWindow,
    startSelectionUsage: lifecycle.startSelectionUsage,
  })
  lifecycleInput.loadTranscriptPage = loadTranscriptPage as InteractiveTranscriptPageLoader
  return { initialTranscriptWindow, loadTranscriptPage, ...lifecycle }
}
