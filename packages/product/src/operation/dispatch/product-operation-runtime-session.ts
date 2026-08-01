import { Effect } from "effect"
import {
  makeInteractiveSession as makeInteractiveSessionRuntime,
  type InteractiveSessionInput,
  type InteractiveSessionRuntimeResult,
} from "../interactive/interactive-session-runtime"
import { selectionInitialTurnWindow, selectionInitialEntryWindow } from "../interactive/interactive-session-constants"
import { isTerminalStatus } from "../../execution/contract/execution-status"
import {
  executionStartFailureMessage,
  recordedShellStartedEvent,
  recordedShellSettledEvents,
  temporaryThreadTitle,
  executeShellCommand,
} from "../interactive/interactive-operation-leaves"
import { queueMutationEvent } from "./product-operation-runtime-support"
import { OperationError } from "../operation-error"

type ProductOperationInteractiveSessionInput = Omit<
  InteractiveSessionInput,
  | "selectionInitialTurnWindow"
  | "selectionInitialEntryWindow"
  | "isTerminalStatus"
  | "executionStartFailureMessage"
  | "temporaryThreadTitle"
  | "queueMutationEvent"
  | "recordedShellStartedEvent"
  | "recordedShellSettledEvents"
  | "executeShellCommand"
  | "nextSessionId"
>

export type ProductOperationInteractiveSessionFactory = (
  workspace: string,
  settings?: { readonly initialThreadId?: string; readonly registerPromoter?: boolean },
) => Effect.Effect<InteractiveSessionRuntimeResult, OperationError, never>

export const makeProductOperationInteractiveSession = (
  input: ProductOperationInteractiveSessionInput,
): ProductOperationInteractiveSessionFactory => {
  let sequence = 0
  return (
    workspace: string,
    settings: { readonly initialThreadId?: string; readonly registerPromoter?: boolean } = {},
  ) => {
    const runtimeInput: InteractiveSessionInput = {
      ...input,
      selectionInitialTurnWindow,
      selectionInitialEntryWindow,
      encodeJson: input.encodeJson,
      isTerminalStatus,
      executionStartFailureMessage,
      temporaryThreadTitle,
      queueMutationEvent,
      recordedShellStartedEvent,
      recordedShellSettledEvents,
      executeShellCommand,
      nextSessionId: () => (sequence += 1),
      activitySequence: input.activitySequence,
    }
    return makeInteractiveSessionRuntime(runtimeInput)(workspace, settings)
  }
}
