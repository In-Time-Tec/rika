import {
  makeInitialTranscriptWindow,
  makeInteractiveTranscriptPage,
  type InteractiveTranscriptPageLoader,
} from "./interactive-transcript-page"
import {
  makeInteractiveTranscriptLifecycle,
  type InteractiveTranscriptLifecycleInput,
} from "./interactive-transcript-lifecycle"
import type { InteractiveRuntimeContext } from "./interactive-session-runtime"

export const makeInteractiveTranscript = (input: InteractiveRuntimeContext) => {
  const lifecycleInput: InteractiveTranscriptLifecycleInput = {
    ...input,
    loadTranscriptPage: undefined as never,
  }
  const lifecycle = makeInteractiveTranscriptLifecycle(lifecycleInput)
  const initialTranscriptWindow = makeInitialTranscriptWindow(input)
  const loadTranscriptPage = makeInteractiveTranscriptPage({
    ...input,
    ...lifecycle,
    initialTranscriptWindow,
  })
  lifecycleInput.loadTranscriptPage = loadTranscriptPage as InteractiveTranscriptPageLoader
  return { initialTranscriptWindow, loadTranscriptPage, ...lifecycle }
}
