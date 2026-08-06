import type { InteractiveSession } from "./interactive-session"
import { makeInteractiveSessionControls } from "./interactive-session-interface-controls"
import { makeInteractiveSessionEvents } from "./interactive-session-interface-events"
import { makeInteractiveSessionSelection } from "./interactive-session-interface-selection"
import type { makeInteractiveExecution } from "./interactive-session-execution"
import type { makeInteractiveFollowing } from "./interactive-session-following"
import type { makeInteractiveTranscript } from "./interactive-session-transcript-runtime"
import type { makeInteractiveSupervisionComponents } from "./interactive-session-runtime-components"
import type { InteractiveRuntimeContext } from "./interactive-session-runtime"
import type { SelectionEpochState } from "./interactive-thread-selection"

export type InteractiveImplementationInput = InteractiveRuntimeContext &
  ReturnType<typeof makeInteractiveExecution> &
  ReturnType<typeof makeInteractiveFollowing> &
  ReturnType<typeof makeInteractiveTranscript> &
  ReturnType<typeof makeInteractiveSupervisionComponents> & {
    readonly getCurrentSelectionEpoch: () => number
    readonly getSelectedThreadId: () => string | undefined
    readonly getActiveSelectionState: () => SelectionEpochState | undefined
    readonly selectionMatches: (candidate: SelectionEpochState | undefined, threadId: string, epoch: number) => boolean
  }

export type InteractiveSessionControlsInput = Omit<InteractiveImplementationInput, "submit">

export type InteractiveSessionSelectionInput = Omit<InteractiveImplementationInput, "submit">

export const makeInteractiveImplementation = (input: InteractiveImplementationInput): InteractiveSession => {
  const events = makeInteractiveSessionEvents(input)
  const controls = makeInteractiveSessionControls({ ...input, ...events })
  const selection = makeInteractiveSessionSelection({ ...input, ...events, ...controls })
  return { ...events, ...controls, ...selection }
}
