import { persistedThreadUsage } from "../dispatch/execution-operation-coordination"
import { makeInitialTranscriptWindow, makeInteractiveTranscriptPage } from "./interactive-transcript-page"
import { makeInteractiveTranscriptLifecycle } from "./interactive-transcript-lifecycle"

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
