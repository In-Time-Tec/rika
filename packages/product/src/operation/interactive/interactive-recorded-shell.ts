import { Function } from "effect"
import * as ThreadSummaryRepository from "@rika/product/thread-summary-repository"
import * as Thread from "@rika/product/thread-record"
import * as ThreadResult from "@rika/product/thread-result"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as ToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as ExecutionIngest from "../../execution/ingest/execution-ingest-service"
import { Cause, Clock, Effect } from "effect"
import type { Exit } from "effect"
import { OperationError, operationError, failureKind } from "../operation-error"
import type { InteractiveEvent } from "./interactive-event"
import type { InteractiveExecutionContext, InteractiveSessionInput } from "./interactive-session-runtime"

const appendRecordedShellOutput = (output: { readonly text: string; readonly truncated: boolean }, text: string) => {
  const accepted = text.slice(0, Math.max(0, 64 * 1024 - output.text.length))
  return { text: output.text + accepted, truncated: output.truncated || accepted.length < text.length }
}

export interface InteractiveRecordedShellInput {
  readonly options: InteractiveSessionInput["options"]
  readonly dispatch: (event: InteractiveEvent) => void
  readonly emit: (dispatch: (event: InteractiveEvent) => void, event: InteractiveEvent) => void
  readonly ensureTurnSummary: InteractiveSessionInput["ensureTurnSummary"]
  readonly notifyThreadSummaries: InteractiveSessionInput["notifyThreadSummaries"]
  readonly notifyTurnChanged: InteractiveSessionInput["notifyTurnChanged"]
  readonly publishInteractiveActivity: InteractiveSessionInput["publishInteractiveActivity"]
  readonly sessionId: number
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
  ThreadSummaryRepository.Service | TranscriptRepository.Service | ToolRuntime.Service
> => {
  const {
    options,
    dispatch,
    emit,
    ensureTurnSummary,
    notifyThreadSummaries,
    notifyTurnChanged,
    publishInteractiveActivity,
    sessionId,
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
        const runningProjection = yield* transcripts.createRecordedShell(runningTurn, ExecutionIngest.projectionVersion)
        emit(dispatch, recordedShellStartedEvent(runningTurn, runningProjection))
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
        const settled = yield* transcripts.settleRecordedShell(
          runningTurn,
          terminalTurn,
          runningProjection.checkpointGeneration,
          ExecutionIngest.projectionVersion,
        )
        if (settled._tag === "Stale")
          return yield* operationError(`Recorded shell turn ${runningTurn.id} lost projection write authority`)
        const terminalEvents = recordedShellSettledEvents(terminalTurn, settled.projection)
        if (interrupted) {
          for (const event of terminalEvents) publishInteractiveActivity(sessionId, event)
        } else {
          for (const event of terminalEvents) emit(dispatch, event)
          dispatch({
            _tag: "ShellCompleted",
            threadId: thread.id,
            command,
            text: terminalTurn.result.text,
            incognito: false,
            status: terminalTurn.status,
          })
        }
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
