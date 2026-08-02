import type { InteractiveSession } from "./interactive-session"
import { makeInteractiveSessionControls } from "./interactive-session-interface-controls"
import { makeInteractiveSessionEvents } from "./interactive-session-interface-events"
import { makeInteractiveSessionSelection } from "./interactive-session-interface-selection"

export const makeInteractiveImplementation = (input: any): InteractiveSession => {
  const events = makeInteractiveSessionEvents(input)
  const controls = makeInteractiveSessionControls({ ...input, ...events })
  const selection = makeInteractiveSessionSelection({ ...input, ...events, ...controls })
  return { ...events, ...controls, ...selection }
}
