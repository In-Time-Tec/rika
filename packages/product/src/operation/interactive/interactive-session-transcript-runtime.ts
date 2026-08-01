import * as UsageSnapshot from "@rika/product/usage-snapshot"
import type { InteractiveEvent } from "./interactive-event"
import { makeInitialTranscriptWindow, makeInteractiveTranscriptPage } from "./interactive-transcript-page"
import { makeInteractiveTranscriptLifecycle } from "./interactive-transcript-lifecycle"

export const persistedThreadUsage = (
  value: UsageSnapshot.Aggregate,
): Pick<
  Extract<InteractiveEvent, { readonly _tag: "ThreadUsageUpdated" }>,
  "context" | "cost" | "tokens" | "time"
> => ({
  context: { _tag: "Unavailable" },
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

export const makeInteractiveTranscript = (input: any) => {
  const lifecycleInput = { ...input, persistedThreadUsage }
  const lifecycle = makeInteractiveTranscriptLifecycle(lifecycleInput)
  const initialTranscriptWindow = makeInitialTranscriptWindow(input)
  const loadTranscriptPage = makeInteractiveTranscriptPage({
    ...input,
    ...lifecycle,
    initialTranscriptWindow,
    startSelectionUsage: lifecycle.startSelectionUsage,
  })
  lifecycleInput.loadTranscriptPage = loadTranscriptPage
  return { initialTranscriptWindow, loadTranscriptPage, ...lifecycle }
}
