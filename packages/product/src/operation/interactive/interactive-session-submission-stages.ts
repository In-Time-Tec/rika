import { Function } from "effect"
import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionRequest from "@rika/product/execution-request"
import { Clock, Effect, Ref } from "effect"
import { admitInteractiveTurn } from "./interactive-turn-submission"
import type { ModeId } from "@rika/configuration/behavior-mode"
import type { InteractiveEvent } from "./interactive-runtime-event"
import type { InteractiveRuntimeContext } from "./interactive-session-runtime"
import type { makeInteractiveQueue } from "./interactive-session-queue"

export type InteractiveSubmissionContext = InteractiveRuntimeContext & ReturnType<typeof makeInteractiveQueue>

const emitEvent = (
  input: InteractiveRuntimeContext,
  dispatch: (event: InteractiveEvent) => void,
  event: InteractiveEvent,
) => input.emit(dispatch, event)

const admitInteractiveSubmissionImpl = (
  input: InteractiveRuntimeContext,
  thread: Thread.Thread,
  prompt: string,
  mode: ModeId,
  modelTuning: { readonly fastMode?: boolean } | undefined,
  promptParts: ReadonlyArray<ExecutionRequest.PromptPart> | undefined,
  dispatch: (event: InteractiveEvent) => void,
  submissionId?: string,
) => {
  const {
    options,
    pendingTurnCapacity,
    turnMutationAdmission,
    resolveExecutionRoute,
    ensureTurnSummary,
    submissionRegistry,
  } = input
  return Effect.gen(function* () {
    const turns = yield* TurnRepository.Service
    if (submissionId !== undefined) {
      // A client that reconnects after its submission was durably admitted re-issues the same
      // submissionId; resolve it to the admitted turn instead of creating a duplicate.
      const existing = submissionRegistry.resolve(submissionId)
      if (existing !== undefined && String(existing.threadId) === String(thread.id)) {
        const turn = yield* turns.get(existing.turnId)
        if (turn !== undefined && turn._tag === "AgentExecution" && turn.prompt === prompt) {
          emitEvent(input, dispatch, {
            _tag: "SubmissionAdmitted",
            selectionEpoch: 0,
            threadId: thread.id,
            turnId: turn.id,
            status: turn.status === "queued" ? "queued" : "active",
            ...(submissionId === undefined ? {} : { submissionId }),
          })
          return turn
        }
      }
    }
    const executionRoute = yield* resolveExecutionRoute(mode, modelTuning, thread.workspace)
    const observed = yield* turnMutationAdmission.withPermits(1)(
      admitInteractiveTurn({
        turns,
        submission: {
          id: yield* options.makeTurnId,
          threadId: thread.id,
          prompt,
          ...(promptParts === undefined ? {} : { promptParts }),
          executionRoute,
          queueCapacity: pendingTurnCapacity,
          now: yield* Clock.currentTimeMillis,
        },
      }),
    )
    if (submissionId !== undefined) submissionRegistry.register(submissionId, observed.turn.id, thread.id)
    yield* ensureTurnSummary(observed.turn)
    emitEvent(input, dispatch, {
      _tag: "SubmissionAdmitted",
      selectionEpoch: 0,
      threadId: thread.id,
      turnId: observed.turn.id,
      status: observed.turn.status === "queued" ? "queued" : "active",
      ...(submissionId === undefined ? {} : { submissionId }),
    })
    return observed.turn
  })
}

export const admitInteractiveSubmission: {
  (
    arg1: Thread.Thread,
    arg2: string,
    arg3: ModeId,
    arg4: { readonly fastMode?: boolean } | undefined,
    arg5: ReadonlyArray<ExecutionRequest.PromptPart> | undefined,
    arg6: (event: InteractiveEvent) => void,
    arg7?: string,
  ): (arg0: InteractiveRuntimeContext) => ReturnType<typeof admitInteractiveSubmissionImpl>
  (
    arg0: InteractiveRuntimeContext,
    arg1: Thread.Thread,
    arg2: string,
    arg3: ModeId,
    arg4: { readonly fastMode?: boolean } | undefined,
    arg5: ReadonlyArray<ExecutionRequest.PromptPart> | undefined,
    arg6: (event: InteractiveEvent) => void,
    arg7?: string,
  ): ReturnType<typeof admitInteractiveSubmissionImpl>
} = Function.dual(8, admitInteractiveSubmissionImpl)

export const submitInteractiveOperation = (input: InteractiveSubmissionContext) => {
  const {
    workspace,
    options,
    temporaryThreadTitle,
    notifyThreadSummaries,
    submissionAdmission,
    executionDependencies,
    dispatchFailure,
    queueMutationEvent,
    interactiveThread,
    activateCreatedThread,
    getCurrentSelectionEpoch,
  } = input
  const submit = Effect.fn("ProductOperation.interactive.submit")(function* (
    prompt: string,
    dispatch: (event: InteractiveEvent) => void,
    mode: ModeId = "medium",
    promptParts?: ReadonlyArray<ExecutionRequest.PromptPart>,
    modelTuning?: { readonly fastMode?: boolean },
    submissionId?: string,
  ) {
    let observerTurn: Turn.Turn | undefined
    let created = false
    const program = Effect.gen(function* () {
      const threads = yield* ThreadRepository.Service
      let thread = yield* Ref.get(interactiveThread)
      if (thread === undefined) {
        thread = yield* threads.create({
          id: yield* options.makeThreadId,
          workspace,
          title: temporaryThreadTitle(prompt),
          now: yield* Clock.currentTimeMillis,
        })
        created = true
      }
      const turns = yield* TurnRepository.Service
      if (thread.title === "New thread" && (yield* turns.list(thread.id)).length === 1) {
        const renamed = yield* threads.renameIfTitle(
          thread.id,
          "New thread",
          temporaryThreadTitle(prompt),
          yield* Clock.currentTimeMillis,
        )
        if (renamed !== undefined) {
          thread = renamed
          emitEvent(input, dispatch, { _tag: "ThreadTitled", threadId: String(thread.id), title: thread.title })
          yield* notifyThreadSummaries
        }
      }
      const admitted: import("../../thread/repository/turn-repository-queue").Submission =
        yield* admitInteractiveSubmission(input, thread, prompt, mode, modelTuning, promptParts, dispatch, submissionId)
      const turn = admitted as Turn.Turn
      observerTurn = turn
      if (created) yield* activateCreatedThread(thread, getCurrentSelectionEpoch(), dispatch, turn)
      if (turn.status === "queued") {
        if ("queue" in admitted && admitted.queue !== undefined)
          emitEvent(input, dispatch, queueMutationEvent(admitted.queue))
        return
      }
    })
    yield* submissionAdmission
      .withPermits(1)(program)
      .pipe(
        Effect.provide(executionDependencies),
        Effect.scoped,
        Effect.catch((error) => Effect.sync(() => dispatchFailure(dispatch, error, undefined, observerTurn?.id))),
      )
  })
  return submit
}
