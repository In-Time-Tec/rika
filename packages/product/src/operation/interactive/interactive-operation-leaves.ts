import * as ExecutionStatus from "../../execution/contract/execution-status"
import * as ExecutionIngest from "../../execution/ingest/execution-ingest-service"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as Turn from "@rika/product/turn-record"
import type { InteractiveEvent } from "./interactive-event"
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

const projectionVisibleState = (
  projection: Pick<TranscriptRepository.Projection, "revision" | "modelPhase" | "usableCompletionSequence">,
): ExecutionIngest.ProjectionSnapshot["state"] => ({
  revision: projection.revision,
  modelPhase: projection.modelPhase,
  ...(projection.usableCompletionSequence === undefined
    ? {}
    : { usableCompletionSequence: projection.usableCompletionSequence }),
})

const recordedShellStreamId = (turnId: Turn.TurnId): string => `recorded-shell:${turnId}`

export const recordedShellStartedEvent = (
  turn: Turn.RunningRecordedShellTurn,
  projection: TranscriptRepository.Projection,
): InteractiveEvent => ({
  _tag: "TranscriptProjectionStarted",
  selectionEpoch: 0,
  threadId: turn.threadId,
  rootTurnId: turn.id,
  turn,
  streamId: recordedShellStreamId(turn.id),
  patchRevision: 0,
  state: projectionVisibleState(projection),
  units: projection.units,
})

export const recordedShellSettledEvents = (
  turn: Turn.TerminalRecordedShellTurn,
  projection: TranscriptRepository.Projection,
): readonly [InteractiveEvent, InteractiveEvent] => {
  const streamId = recordedShellStreamId(turn.id)
  return [
    {
      _tag: "TranscriptProjectionPatched",
      selectionEpoch: 0,
      threadId: turn.threadId,
      rootTurnId: turn.id,
      turn,
      streamId,
      baseRevision: 0,
      patchRevision: 1,
      origin: { _tag: "RecordedShell", phase: "settled" },
      state: projectionVisibleState(projection),
      delta: { upsert: projection.units, remove: [] },
      rootStatus: turn.status,
    },
    {
      _tag: "TranscriptProjectionStopped",
      selectionEpoch: 0,
      threadId: turn.threadId,
      rootTurnId: turn.id,
      streamId,
      patchRevision: 1,
      status: turn.status,
    },
  ]
}

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
