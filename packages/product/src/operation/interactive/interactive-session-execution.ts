import { Effect } from "effect"
import type { InteractiveEvent } from "./interactive-runtime-event"
import { makeInteractiveQueue } from "./interactive-session-queue"
import { makeInteractiveSubmission } from "./interactive-session-submission"
import type { InteractiveRuntimeContext } from "./interactive-session-runtime"

export const makeInteractiveExecution = (input: InteractiveRuntimeContext) => {
  const queue = makeInteractiveQueue(input)
  const submit = makeInteractiveSubmission({ ...input, ...queue })
  const safe = <A, E, R>(dispatch: (event: InteractiveEvent) => void, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(input.executionDependencies),
      Effect.scoped,
      Effect.catch((error) => Effect.sync(() => input.dispatchFailure(dispatch, error))),
    )
  return { submit, safe, ...queue }
}
