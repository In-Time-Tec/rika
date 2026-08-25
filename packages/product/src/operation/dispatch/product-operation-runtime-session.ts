import { Effect } from "effect"
import {
  makeInteractiveSession as makeInteractiveSessionRuntime,
  type InteractiveSessionInput,
  type InteractiveSessionRuntimeResult,
} from "../interactive/session"
import { isTerminalStatus } from "../../execution/contract/execution-status"
import {
  executionStartFailureMessage,
  recordedShellStartedEvent,
  recordedShellSettledEvents,
  temporaryThreadTitle,
  executeShellCommand,
} from "../interactive/shell"
import { queueMutationEvent } from "./product-operation-runtime-support"
import { OperationError } from "../operation-error"

type ProductOperationInteractiveSessionInput = Omit<
  InteractiveSessionInput,
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
  settings?: {
    readonly initialThreadId?: string
    readonly recoveryOwner?: boolean
    readonly observeExecution?: boolean
  },
) => Effect.Effect<InteractiveSessionRuntimeResult, OperationError, never>

export const makeProductOperationInteractiveSession = (
  input: ProductOperationInteractiveSessionInput,
): ProductOperationInteractiveSessionFactory => {
  let sequence = 0
  return (
    workspace: string,
    settings: {
      readonly initialThreadId?: string
      readonly recoveryOwner?: boolean
      readonly observeExecution?: boolean
    } = {},
  ) => {
    const runtimeInput: InteractiveSessionInput = {
      ...input,
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
