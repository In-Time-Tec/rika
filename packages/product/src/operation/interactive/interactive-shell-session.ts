import * as ThreadRepository from "@rika/product/thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as ToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import { OperationError } from "../operation-error"
import { Clock, Context, Effect, Layer, Ref } from "effect"
import { clampThreadTitle } from "../../thread/query/thread-title-policy"
import { runRecordedShell } from "./interactive-recorded-shell"
import { operationError } from "../operation-error"
import type { InteractiveRuntimeContext } from "./interactive-session-runtime"

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
    executeShellCommand,
    recordedShellStartedEvent,
    recordedShellSettledEvents,
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
          executeShellCommand,
          recordedShellStartedEvent,
          recordedShellSettledEvents,
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
          message: "Shell runtime is unavailable",
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
