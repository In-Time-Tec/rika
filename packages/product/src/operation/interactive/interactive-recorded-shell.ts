import { Function } from "effect"
import * as ThreadSummaryRepository from "@rika/product/thread-summary-repository"
import * as Thread from "@rika/product/thread-record"
import * as ThreadResult from "@rika/product/thread-result"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import { recordedShellProjection, settleRecordedShellProjection } from "@rika/transcript/recorded-shell-presentation"
import * as ToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import { Cause, Clock, Effect } from "effect"
import type { Exit } from "effect"
import { OperationError, operationError, failureKind } from "../operation-error"
import type { InteractiveEvent } from "./interactive-runtime-event"
import type { InteractiveExecutionContext, InteractiveSessionInput } from "./interactive-session-runtime"

const appendRecordedShellOutput = (output: { readonly text: string; readonly truncated: boolean }, text: string) => {
  const accepted = text.slice(0, Math.max(0, 64 * 1024 - output.text.length))
  return { text: output.text + accepted, truncated: output.truncated || accepted.length < text.length }
}

export interface InteractiveRecordedShellInput {
  readonly options: InteractiveSessionInput["options"]
  readonly dispatch: (event: InteractiveEvent) => void
  readonly hub: InteractiveSessionInput["hub"]
  readonly ensureTurnSummary: InteractiveSessionInput["ensureTurnSummary"]
  readonly notifyThreadSummaries: InteractiveSessionInput["notifyThreadSummaries"]
  readonly notifyTurnChanged: InteractiveSessionInput["notifyTurnChanged"]
  readonly executionDependencies: InteractiveExecutionContext
  readonly executeShellCommand: InteractiveSessionInput["executeShellCommand"]
  readonly recordedShellStartedEvent: InteractiveSessionInput["recordedShellStartedEvent"]
  readonly recordedShellSettledEvents: InteractiveSessionInput["recordedShellSettledEvents"]
}

const runRecordedShellImpl = (
  input: InteractiveRecordedShellInput,
  thread: Thread.Thread,
  command: string,
  incognito: boolean,
): Effect.Effect<
  void,
  OperationError,
  ThreadSummaryRepository.Service | TranscriptRepository.Service | TurnRepository.Service | ToolRuntime.Service
> => {
  const {
    options,
    dispatch,
    hub,
    ensureTurnSummary,
    notifyThreadSummaries,
    notifyTurnChanged,
    executeShellCommand,
    recordedShellStartedEvent,
    recordedShellSettledEvents,
  } = input
  return Effect.gen(function* () {
    const tools = yield* ToolRuntime.Service
    if (incognito) {
      const result = yield* executeShellCommand(tools, command)
      dispatch({
        _tag: "ShellCompleted",
        threadId: thread.id,
        command,
        text: result.text,
        incognito: true,
        status: result.exitCode === 0 ? "completed" : "failed",
      })
      return
    }
    const transcripts = yield* TranscriptRepository.Service
    const turns = yield* TurnRepository.Service
    const now = yield* Clock.currentTimeMillis
    const runningTurn: ThreadResult.RunningRecordedShellTurn = {
      _tag: "RecordedShell",
      id: yield* options.makeTurnId,
      threadId: thread.id,
      prompt: `$ ${command}`,
      command,
      status: "running",
      author: { _tag: "Human" },
      lineage: { _tag: "Original" },
      createdAt: now,
      updatedAt: now,
    }
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* turns.createRecordedShell(runningTurn)
        const runningProjection = yield* transcripts.replaceUnits(
          runningTurn,
          recordedShellProjection(runningTurn).units,
        )
        hub.commitChange(
          runningTurn.threadId,
          runningTurn,
          recordedShellStartedEvent(runningTurn, runningProjection).change,
        )
        const processExit = (yield* Effect.exit(
          restore(
            ensureTurnSummary(runningTurn).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.failCause(cause)
                  : Effect.logError("recorded-shell.summary.start.failed").pipe(
                      Effect.annotateLogs({
                        "rika.thread.id": String(runningTurn.threadId),
                        "rika.turn.id": String(runningTurn.id),
                        "rika.failure.kind": failureKind(cause),
                      }),
                    ),
              ),
              Effect.andThen(executeShellCommand(tools, command)),
            ),
          ),
        )) as Exit.Exit<{ readonly text: string; readonly truncated: boolean; readonly exitCode?: number }, unknown>
        const completedAt = yield* Clock.currentTimeMillis
        const interrupted = processExit._tag === "Failure" && Cause.hasInterrupts(processExit.cause)
        const terminalTurn: ThreadResult.TerminalRecordedShellTurn =
          processExit._tag === "Success"
            ? {
                ...runningTurn,
                status: processExit.value.exitCode === 0 ? "completed" : "failed",
                result: processExit.value,
                updatedAt: completedAt,
              }
            : {
                ...runningTurn,
                status: interrupted ? "cancelled" : "failed",
                result: appendRecordedShellOutput(
                  { text: "", truncated: false },
                  interrupted ? "Shell command cancelled" : String(Cause.squash(processExit.cause)),
                ),
                updatedAt: completedAt,
              }
        const settledTurn = yield* turns.settleRecordedShell(runningTurn, terminalTurn)
        if (settledTurn === undefined)
          return yield* operationError(`Recorded shell turn ${runningTurn.id} lost write authority`)
        const settledProjection = yield* transcripts.replaceUnits(
          settledTurn,
          settleRecordedShellProjection(recordedShellProjection(runningTurn), settledTurn).units,
        )
        const terminalEvents = recordedShellSettledEvents(settledTurn, settledProjection)
        if (!interrupted) {
          dispatch({
            _tag: "ShellCompleted",
            threadId: thread.id,
            command,
            text: terminalTurn.result.text,
            incognito: false,
            status: terminalTurn.status,
          })
        }
        for (const event of terminalEvents) hub.commitChange(settledTurn.threadId, settledTurn, event.change)
        yield* Effect.gen(function* () {
          const summaries = yield* ThreadSummaryRepository.Service
          yield* summaries.replaceTurn({
            turnId: terminalTurn.id,
            threadId: terminalTurn.threadId,
            complete: true,
            editTotals: { added: 0, modified: 0, removed: 0 },
            lastEventAt: terminalTurn.updatedAt,
            now: terminalTurn.updatedAt,
          })
          yield* notifyThreadSummaries
          yield* notifyTurnChanged(terminalTurn)
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("recorded-shell.summary.settle.failed").pipe(
              Effect.annotateLogs({
                "rika.thread.id": String(terminalTurn.threadId),
                "rika.turn.id": String(terminalTurn.id),
                "rika.failure.kind": failureKind(cause),
              }),
            ),
          ),
        )
        if (interrupted) return yield* Effect.interrupt
      }),
    )
  }).pipe(Effect.mapError((error) => operationError(String(error), error)))
}

export const runRecordedShell: {
  (
    arg1: Thread.Thread,
    arg2: string,
    arg3: boolean,
  ): (arg0: InteractiveRecordedShellInput) => ReturnType<typeof runRecordedShellImpl>
  (
    arg0: InteractiveRecordedShellInput,
    arg1: Thread.Thread,
    arg2: string,
    arg3: boolean,
  ): ReturnType<typeof runRecordedShellImpl>
} = Function.dual(4, runRecordedShellImpl)
