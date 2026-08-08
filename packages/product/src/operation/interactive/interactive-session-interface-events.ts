import { Effect, Schema, Semaphore } from "effect"
import { OperationUnavailable } from "../contract/product-operation"
import type { InteractiveSession } from "./interactive-session"
import { makeInteractiveShell } from "./interactive-shell-session"
import type { InteractiveOperationFeed } from "./interactive-operation-feed"
import type { ModeId } from "@rika/config/behavior-mode"
import type * as ExecutionRequest from "@rika/product/execution-request"
import type { InteractiveImplementationInput } from "./interactive-session-interface"

export const makeInteractiveSessionEvents = (
  input: InteractiveImplementationInput,
): Pick<
  InteractiveSession,
  | "events"
  | "submit"
  | "newThread"
  | "shell"
  | "editQueued"
  | "dequeue"
  | "steerQueued"
  | "approveAuthorization"
  | "denyAuthorization"
> => {
  const operationFeed: InteractiveOperationFeed = input.operationFeed
  const submissionAdmission: Semaphore.Semaphore = input.submissionAdmission
  const events = (dispatch: Parameters<InteractiveSession["events"]>[0]) =>
    Effect.gen(function* () {
      yield* input.dispatchThreadSummaries(input.sessionDispatch)
      yield* operationFeed.events(dispatch, input.getCurrentSelectionEpoch, input.getSelectedThreadId)
    }).pipe(
      Effect.provide(input.executionDependencies),
      Effect.mapError((error) =>
        Schema.is(OperationUnavailable)(error)
          ? error
          : OperationUnavailable.make({ operation: "InteractiveSession.events", message: String(error) }),
      ),
    )
  const submit = (
    prompt: string,
    mode?: ModeId,
    parts?: ReadonlyArray<ExecutionRequest.PromptPart>,
    tuning?: { readonly fastMode?: boolean },
    submissionId?: string,
  ) =>
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
      submissionAdmission.withPermits(1)(Effect.uninterruptible(input.createAndSelectThread())),
    ),
    shell: (threadId, command, incognito) => shell(threadId, command, incognito),
    editQueued: (id, prompt) => input.safe(input.sessionDispatch, input.control.editQueued(id, prompt)),
    dequeue: (id) => input.safe(input.sessionDispatch, input.control.dequeue(id)),
    steerQueued: (id, text) => input.safe(input.sessionDispatch, input.control.steerQueued(id, text)),
    approveAuthorization: (turnId, authorizationId) =>
      input.safe(input.sessionDispatch, input.control.approveAuthorization(turnId, authorizationId)),
    denyAuthorization: (turnId, authorizationId) =>
      input.safe(input.sessionDispatch, input.control.denyAuthorization(turnId, authorizationId)),
  }
}
