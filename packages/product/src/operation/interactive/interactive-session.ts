import * as Thread from "@rika/product/thread-record"
import * as TranscriptPage from "@rika/product/transcript-page"
import * as ExecutionRequest from "@rika/product/execution-request"
import { Effect } from "effect"
import { ModeId } from "@rika/configuration/behavior-mode"
import { OperationUnavailable } from "../contract/product-operation"
import type { InteractiveEvent } from "./interactive-event"

export interface InteractiveSession {
  readonly events: (dispatch: (event: InteractiveEvent) => void) => Effect.Effect<void, OperationUnavailable>
  readonly submit: (
    prompt: string,
    mode?: ModeId,
    promptParts?: ReadonlyArray<ExecutionRequest.PromptPart>,
    modelTuning?: { readonly fastMode?: boolean },
    submissionId?: string,
  ) => Effect.Effect<void, OperationUnavailable>
  readonly shell: (
    threadId: Thread.ThreadId | undefined,
    command: string,
    incognito: boolean,
  ) => Effect.Effect<void, OperationUnavailable>
  readonly editQueued: (turnId: string, prompt: string) => Effect.Effect<void, OperationUnavailable>
  readonly dequeue: (turnId: string) => Effect.Effect<void, OperationUnavailable>
  readonly steerQueued: (turnId: string, text: string) => Effect.Effect<void, OperationUnavailable>
  readonly steer: (text: string, targetTurnId?: string) => Effect.Effect<void, OperationUnavailable>
  readonly approveAuthorization: (turnId: string, authorizationId: string) => Effect.Effect<void, OperationUnavailable>
  readonly denyAuthorization: (turnId: string, authorizationId: string) => Effect.Effect<void, OperationUnavailable>
  readonly interruptAndSend: (prompt: string) => Effect.Effect<void, OperationUnavailable>
  readonly cancel: Effect.Effect<void, OperationUnavailable>
  readonly quit: Effect.Effect<void, OperationUnavailable>
  readonly newThread: Effect.Effect<void, OperationUnavailable>
  readonly selectThread: (threadId: string) => Effect.Effect<void, OperationUnavailable>
  readonly readQueue: (threadId: string) => Effect.Effect<void, OperationUnavailable>
  readonly loadOlder: (
    threadId: string,
    before: TranscriptPage.PageCursor,
    loadedKeys: ReadonlyArray<string>,
  ) => Effect.Effect<void, OperationUnavailable>
  readonly loadNewer: (threadId: string, after: TranscriptPage.PageCursor) => Effect.Effect<void, OperationUnavailable>
  readonly previewThread: (threadId: string) => Effect.Effect<void, OperationUnavailable>
  readonly reopenThread: Effect.Effect<void, OperationUnavailable>
}
