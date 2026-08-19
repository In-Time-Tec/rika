import * as TranscriptPage from "@rika/product/transcript-page"
import * as ExecutionStatus from "../../execution/contract/execution-status"
import * as ExecutionProjection from "../../execution/contract/execution-projection"
import * as ThreadResult from "@rika/product/thread-result"
import * as ToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as ThreadSummaryRepository from "@rika/product/thread-summary-repository"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import * as ThreadRepository from "@rika/product/thread-repository"
import { Function, Effect, Cause, Clock, type Exit, Context, Layer, Ref } from "effect"
import { type InteractiveEvent } from "./session-event"
import { operationError, OperationError, failureKind } from "../operation-error"
import { clampThreadTitle } from "../../thread/query/thread-title-policy"
import { recordedShellProjection, settleRecordedShellProjection } from "@rika/transcript/recorded-shell-presentation"
import {
  type InteractiveExecutionContext,
  type InteractiveSessionInput,
  type InteractiveRuntimeContext,
} from "./session"
import { makeFailure } from "../operation-failure"

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

const appendShellOutput = (output: RecordedShellOutput, text: string): RecordedShellOutput => {
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

export const recordedShellStartedEvent: {
  (
    arg1: TranscriptPage.Projection,
  ): (arg0: ThreadResult.RunningRecordedShellTurn) => ReturnType<typeof recordedShellStartedEventImpl>
  (
    arg0: ThreadResult.RunningRecordedShellTurn,
    arg1: TranscriptPage.Projection,
  ): ReturnType<typeof recordedShellStartedEventImpl>
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
  (
    arg1: TranscriptPage.Projection,
  ): (arg0: ThreadResult.TerminalRecordedShellTurn) => ReturnType<typeof recordedShellSettledEventsImpl>
  (
    arg0: ThreadResult.TerminalRecordedShellTurn,
    arg1: TranscriptPage.Projection,
  ): ReturnType<typeof recordedShellSettledEventsImpl>
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
    args: ["-c", command],
    waitMillis: 10_000,
  })
  while (true) {
    output = appendShellOutput({ ...output, truncated: output.truncated || result.truncated }, result.text)
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
  ThreadSummaryRepository.Service | TranscriptRepository.Service | TurnRepository.Service | ToolRuntime.Service
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
    executeShellCommand: runShellCommand,
    recordedShellStartedEvent: shellStartedEvent,
    recordedShellSettledEvents: shellSettledEvents,
  } = input
  return Effect.gen(function* () {
    const tools = yield* ToolRuntime.Service
    if (incognito) {
      const result = yield* runShellCommand(tools, command)
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
        emit(dispatch, shellStartedEvent(runningTurn, runningProjection))
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
              Effect.andThen(runShellCommand(tools, command)),
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
        const terminalEvents = shellSettledEvents(settledTurn, settledProjection)
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

export const makeInteractiveShell = (
  input: InteractiveRuntimeContext,
): ((
  requestedThreadId: Thread.ThreadId | undefined,
  command: string,
  incognito: boolean,
) => Effect.Effect<void, never, never>) => {
  const {
    options,
    sessionDispatch,
    workspace,
    sessionId,
    emit,
    dispatchFailure,
    ensureTurnSummary,
    notifyThreadSummaries,
    notifyTurnChanged,
    publishInteractiveActivity,
    selectionAdmission,
    interactiveThread,
    activateCreatedThread,
    getCurrentSelectionEpoch,
    executionDependencies,
    sessionScope,
    executeShellCommand: runShellCommand,
    recordedShellStartedEvent: shellStartedEvent,
    recordedShellSettledEvents: shellSettledEvents,
  } = input
  return (requestedThreadId: Thread.ThreadId | undefined, command: string, incognito: boolean) => {
    const dispatch = sessionDispatch
    const toolRuntimeLayer: Layer.Layer<ToolRuntime.Service, OperationError, never> | undefined =
      options.toolRuntimeLayer?.(workspace)
    let ownerThreadId = requestedThreadId
    const runOwnedShell = (thread: Thread.Thread) =>
      runRecordedShell(
        {
          options,
          dispatch,
          emit,
          ensureTurnSummary,
          notifyThreadSummaries,
          notifyTurnChanged,
          publishInteractiveActivity,
          sessionId,
          executionDependencies,
          executeShellCommand: runShellCommand,
          recordedShellStartedEvent: shellStartedEvent,
          recordedShellSettledEvents: shellSettledEvents,
        },
        thread,
        command,
        incognito,
      )
    const program = Effect.gen(function* () {
      const threads = yield* ThreadRepository.Service
      const thread = yield* selectionAdmission.withPermits(1)(
        Effect.gen(function* () {
          if (requestedThreadId !== undefined) {
            const requested = yield* threads.get(requestedThreadId)
            if (requested === undefined) return yield* operationError(`Thread ${requestedThreadId} does not exist`)
            if (requested.workspace !== workspace)
              return yield* operationError(
                `Thread ${requestedThreadId} belongs to workspace ${requested.workspace}, not ${workspace}`,
              )
            return requested
          }
          const selected = yield* Ref.get(interactiveThread)
          if (selected !== undefined) return selected
          const now = yield* Clock.currentTimeMillis
          const created = yield* threads.create({
            id: yield* options.makeThreadId,
            workspace,
            title: incognito ? "New thread" : clampThreadTitle(`$ ${command}`),
            now,
          })
          yield* activateCreatedThread(created, getCurrentSelectionEpoch(), dispatch)
          return created
        }),
      )
      ownerThreadId = thread.id
      if (toolRuntimeLayer === undefined) {
        dispatch({
          _tag: "ExecutionFailed",
          selectionEpoch: 0,
          threadId: thread.id,
          failure: makeFailure("Shell runtime is unavailable"),
        })
        return
      }
      const toolContext = yield* Layer.build(toolRuntimeLayer)
      yield* runOwnedShell(thread).pipe(
        Effect.provide(Context.merge(executionDependencies, toolContext)),
        Effect.catch((error) => Effect.sync(() => dispatchFailure(dispatch, error, thread.id))),
      )
    })
    return program.pipe(
      Effect.provide(executionDependencies),
      Effect.scoped,
      Effect.catch((error) => Effect.sync(() => dispatchFailure(dispatch, error, ownerThreadId))),
      Effect.forkIn(sessionScope),
      Effect.asVoid,
    )
  }
}
