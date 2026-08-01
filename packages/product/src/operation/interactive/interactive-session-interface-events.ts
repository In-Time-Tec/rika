import { Effect, Schema } from "effect"
import { OperationUnavailable } from "../contract/product-operation-errors"
import type { InteractiveSession } from "./interactive-session"
import { makeInteractiveShell } from "./interactive-shell-session"

export const makeInteractiveSessionEvents = (
  input: any,
): Pick<InteractiveSession, "events" | "submit" | "newThread" | "shell" | "editQueued" | "dequeue" | "steerQueued"> => {
  const events = (dispatch: Parameters<InteractiveSession["events"]>[0]) =>
    Effect.gen(function* () {
      yield* input.dispatchThreadSummaries(input.sessionDispatch)
      yield* input.operationFeed.events(dispatch, input.getCurrentSelectionEpoch, input.getSelectedThreadId)
    }).pipe(
      Effect.provide(input.executionDependencies),
      Effect.mapError((error) =>
        Schema.is(OperationUnavailable)(error)
          ? error
          : OperationUnavailable.make({ operation: "InteractiveSession.events", message: String(error) }),
      ),
    ) as any
  const submit = (prompt: string, mode: any, parts: any, tuning: any, submissionId?: string) =>
    input.submit(prompt, input.sessionDispatch, mode, parts, tuning, submissionId) as Effect.Effect<
      void,
      OperationUnavailable,
      never
    >
  const shell = makeInteractiveShell(input)
  return {
    events,
    submit: (prompt, mode, parts, tuning, submissionId) => submit(prompt, mode, parts, tuning, submissionId),
    newThread: input.safe(
      input.sessionDispatch,
      input.submissionAdmission.withPermits(1)(Effect.uninterruptible(input.createAndSelectThread())),
    ),
    shell: (threadId, command, incognito) => shell(threadId, command, incognito),
    editQueued: (id, prompt) => input.safe(input.sessionDispatch, input.control.editQueued(id, prompt)),
    dequeue: (id) => input.safe(input.sessionDispatch, input.control.dequeue(id)),
    steerQueued: (id, text) => input.safe(input.sessionDispatch, input.control.steerQueued(id, text)),
  }
}
