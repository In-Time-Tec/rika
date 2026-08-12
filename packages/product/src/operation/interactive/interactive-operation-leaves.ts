import { Function } from "effect"
import * as TranscriptPage from "@rika/product/transcript-page"
import * as ExecutionStatus from "../../execution/contract/execution-status"
import * as ExecutionProjection from "../../execution/contract/execution-projection"
import * as ThreadResult from "@rika/product/thread-result"
import type { InteractiveEvent } from "./interactive-runtime-event"
import { Effect } from "effect"
import { operationError } from "../operation-error"
import { clampThreadTitle } from "../../thread/query/thread-title-policy"
import * as ToolRuntime from "@rika/coding-tools/coding-tool-runtime"
export const executionStartFailureMessage =
  "Rika could not start this message. Run rika diagnostics status if it keeps happening."
export const ingestFailureMessage =
  "Rika lost its place in this thread's event history and stopped recording it. Reopen the thread to rebuild it."
const recordedShellOutputLimit = 64 * 1024

export const isTerminalStatus = ExecutionStatus.isTerminalStatus

interface RecordedShellOutput {
  readonly text: string
  readonly truncated: boolean
}

const boundedTextPrefix = (text: string, limit: number): string => {
  const prefix = text.slice(0, Math.max(0, limit))
  const final = prefix.charCodeAt(prefix.length - 1)
  return final >= 0xd800 && final <= 0xdbff ? prefix.slice(0, -1) : prefix
}

const appendRecordedShellOutput = (output: RecordedShellOutput, text: string): RecordedShellOutput => {
  const accepted = boundedTextPrefix(text, recordedShellOutputLimit - output.text.length)
  return {
    text: output.text + accepted,
    truncated: output.truncated || accepted.length < text.length,
  }
}

const recordedShellChange = (
  turn: ThreadResult.RunningRecordedShellTurn | ThreadResult.TerminalRecordedShellTurn,
  projection: TranscriptPage.Projection,
): ExecutionProjection.Snapshot => ({
  _tag: "ProjectionSnapshot",
  revision: projection.revision,
  units: projection.units,
  hasOlder: false,
  state: {
    status: turn.status,
    usage: {
      ...ExecutionProjection.emptyUsageState(),
      sourceComplete: turn.status === "completed" || turn.status === "failed" || turn.status === "cancelled",
    },
    steering: { steeringMessages: 0, followUpMessages: 0 },
  },
})

const recordedShellStartedEventImpl = (
  turn: ThreadResult.RunningRecordedShellTurn,
  projection: TranscriptPage.Projection,
): InteractiveEvent => ({
  _tag: "ExecutionProjectionChanged",
  threadId: turn.threadId,
  turn,
  change: recordedShellChange(turn, projection),
})

type RecordedShellEvent = Extract<InteractiveEvent, { readonly _tag: "ExecutionProjectionChanged" }>

export const recordedShellStartedEvent: {
  (arg1: TranscriptPage.Projection): (arg0: ThreadResult.RunningRecordedShellTurn) => RecordedShellEvent
  (arg0: ThreadResult.RunningRecordedShellTurn, arg1: TranscriptPage.Projection): RecordedShellEvent
} = Function.dual(2, recordedShellStartedEventImpl)

const recordedShellSettledEventsImpl = (
  turn: ThreadResult.TerminalRecordedShellTurn,
  projection: TranscriptPage.Projection,
): readonly [InteractiveEvent] => [
  {
    _tag: "ExecutionProjectionChanged",
    threadId: turn.threadId,
    turn,
    change: recordedShellChange(turn, projection),
  },
]

export const recordedShellSettledEvents: {
  (arg1: TranscriptPage.Projection): (arg0: ThreadResult.TerminalRecordedShellTurn) => readonly [RecordedShellEvent]
  (arg0: ThreadResult.TerminalRecordedShellTurn, arg1: TranscriptPage.Projection): readonly [RecordedShellEvent]
} = Function.dual(2, recordedShellSettledEventsImpl)

export const temporaryThreadTitle = (prompt: string) => clampThreadTitle(prompt) || "New thread"

export const executeShellCommand = Effect.fn("ProductOperation.executeShellCommand")(function* (
  tools: ToolRuntime.Interface,
  command: string,
) {
  let output: RecordedShellOutput = { text: "", truncated: false }
  let result = yield* tools.run({
    _tag: "Shell",
    command: "sh",
    args: ["-lc", command],
    waitMillis: 10_000,
  })
  while (true) {
    output = appendRecordedShellOutput({ ...output, truncated: output.truncated || result.truncated }, result.text)
    if (result.running !== true) {
      if (result.exitCode === undefined || !Number.isSafeInteger(result.exitCode))
        return yield* operationError("Shell command ended without an integer exit code")
      return {
        ...output,
        exitCode: result.exitCode,
      }
    }
    if (result.processId === undefined)
      return yield* operationError("Shell command is running without a process identifier")
    result = yield* tools.run({
      _tag: "ShellCommandStatus",
      processId: result.processId,
      waitMillis: 9_000,
    })
  }
})
