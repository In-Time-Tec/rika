import { submitInteractiveOperation } from "./interactive-session-submission-stages"
import type { InteractiveSubmissionContext } from "./interactive-session-submission-stages"

export const makeInteractiveSubmission = (input: InteractiveSubmissionContext) => submitInteractiveOperation(input)
