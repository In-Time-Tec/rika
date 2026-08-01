import { Effect, Schema, Semaphore } from "effect"
import { OperationUnavailable } from "../contract/product-operation"
import type { InteractiveSession } from "./interactive-session"
import { makeInteractiveShell } from "./interactive-shell-session"
import type { InteractiveOperationFeed } from "./interactive-operation-feed"
import type { InteractiveEvent } from "./interactive-event"
import { OperationError } from "../operation-error"

export const makeInteractiveSessionEvents = (
  input: any,
): Pick<InteractiveSession, "events" | "submit" | "newThread" | "shell" | "editQueued" | "dequeue" | "steerQueued"> => {
  const operationFeed: InteractiveOperationFeed = input.operationFeed
  const dispatchThreadSummaries: (
    dispatch: (event: InteractiveEvent) => void,
  ) => Effect.Effect<void, OperationError, never> = input.dispatchThreadSummaries
  const submissionAdmission: Semaphore.Semaphore = input.submissionAdmission
  const createAndSelectThread: Effect.Effect<void, OperationUnavailable, never> = input.createAndSelectThread()
  const safe: <A, E, R>(
    dispatch: (event: InteractiveEvent) => void,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, OperationUnavailable, never> = input.safe
  const events = (dispatch: Parameters<InteractiveSession["events"]>[0]) =>
    Effect.gen(function* () {
      yield* dispatchThreadSummaries(input.sessionDispatch)
      yield* operationFeed.events(dispatch, input.getCurrentSelectionEpoch, input.getSelectedThreadId)
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
    newThread: safe(
      input.sessionDispatch,
      submissionAdmission.withPermits(1)(Effect.uninterruptible(createAndSelectThread)),
    ),
    shell: (threadId, command, incognito) => shell(threadId, command, incognito),
    editQueued: (id, prompt) => input.safe(input.sessionDispatch, input.control.editQueued(id, prompt)),
    dequeue: (id) => input.safe(input.sessionDispatch, input.control.dequeue(id)),
    steerQueued: (id, text) => input.safe(input.sessionDispatch, input.control.steerQueued(id, text)),
  }
}
