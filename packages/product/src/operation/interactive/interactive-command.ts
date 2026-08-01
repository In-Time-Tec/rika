import * as Thread from "@rika/product/thread-record"
import * as TranscriptPage from "@rika/product/transcript-page"
import * as ExecutionRequest from "@rika/product/execution-request"
import { Effect, Function, Schema } from "effect"
import { ModeId } from "@rika/configuration/behavior-mode"
import { OperationUnavailable } from "../contract/product-operation-service"
import type { InteractiveSession } from "./interactive-session"

const Mode = ModeId

export const InteractiveCommand = Schema.Union([
  Schema.Struct({
    _tag: Schema.tag("Submit"),
    prompt: Schema.String,
    submissionId: Schema.optionalKey(Schema.String),
    mode: Schema.optionalKey(Mode),
    promptParts: Schema.optionalKey(Schema.Array(ExecutionRequest.PromptPart)),
    modelTuning: Schema.optionalKey(
      Schema.Struct({
        fastMode: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  }),
  Schema.Struct({
    _tag: Schema.tag("Shell"),
    threadId: Schema.optionalKey(Thread.ThreadId),
    command: Schema.String,
    incognito: Schema.Boolean,
  }),
  Schema.Struct({ _tag: Schema.tag("EditQueued"), turnId: Schema.String, prompt: Schema.String }),
  Schema.Struct({ _tag: Schema.tag("Dequeue"), turnId: Schema.String }),
  Schema.Struct({ _tag: Schema.tag("SteerQueued"), turnId: Schema.String, text: Schema.String }),
  Schema.Struct({ _tag: Schema.tag("Steer"), text: Schema.String, turnId: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ _tag: Schema.tag("InterruptAndSend"), prompt: Schema.String }),
  Schema.Struct({ _tag: Schema.tag("Cancel") }),
  Schema.Struct({ _tag: Schema.tag("Quit") }),
  Schema.Struct({ _tag: Schema.tag("NewThread") }),
  Schema.Struct({
    _tag: Schema.tag("SelectThread"),
    threadId: Schema.String,
    selectionEpoch: Schema.Int,
  }),
  Schema.Struct({ _tag: Schema.tag("ReadQueue"), threadId: Schema.String }),
  Schema.Struct({
    _tag: Schema.tag("LoadOlder"),
    threadId: Schema.String,
    selectionEpoch: Schema.Int,
    before: TranscriptPage.PageCursor,
    loadedKeys: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    _tag: Schema.tag("LoadNewer"),
    threadId: Schema.String,
    selectionEpoch: Schema.Int,
    after: TranscriptPage.PageCursor,
  }),
  Schema.Struct({ _tag: Schema.tag("PreviewThread"), threadId: Schema.String }),
  Schema.Struct({ _tag: Schema.tag("ReopenThread"), selectionEpoch: Schema.Int }),
])
export type InteractiveCommand = typeof InteractiveCommand.Type

const executeInteractiveCommandImpl = (session: InteractiveSession, command: InteractiveCommand) => {
  switch (command._tag) {
    case "Submit":
      return session.submit(
        command.prompt,
        command.mode,
        command.promptParts,
        command.modelTuning,
        command.submissionId,
      )
    case "Shell":
      return session.shell(command.threadId, command.command, command.incognito)
    case "EditQueued":
      return session.editQueued(command.turnId, command.prompt)
    case "Dequeue":
      return session.dequeue(command.turnId)
    case "SteerQueued":
      return session.steerQueued(command.turnId, command.text)
    case "Steer":
      return session.steer(command.text, command.turnId)
    case "InterruptAndSend":
      return session.interruptAndSend(command.prompt)
    case "Cancel":
      return session.cancel
    case "Quit":
      return session.quit
    case "NewThread":
      return session.newThread
    case "SelectThread":
      return session.selectThread(command.threadId, command.selectionEpoch)
    case "ReadQueue":
      return session.readQueue(command.threadId)
    case "LoadOlder":
      return session.loadOlder(command.threadId, command.selectionEpoch, command.before, command.loadedKeys)
    case "LoadNewer":
      return session.loadNewer(command.threadId, command.selectionEpoch, command.after)
    case "PreviewThread":
      return session.previewThread(command.threadId)
    case "ReopenThread":
      return session.reopenThread(command.selectionEpoch)
  }
}

export const executeInteractiveCommand: {
  (command: InteractiveCommand): (session: InteractiveSession) => Effect.Effect<void, OperationUnavailable>
  (session: InteractiveSession, command: InteractiveCommand): Effect.Effect<void, OperationUnavailable>
} = Function.dual(2, executeInteractiveCommandImpl)
