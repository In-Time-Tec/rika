import { Function } from "effect"
import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionRequest from "@rika/product/execution-request"
import * as ExecutionProjection from "@rika/product/execution-projection"
import { Cause, Clock, Effect, Exit, Ref } from "effect"
import { admitInteractiveTurn } from "./interactive-turn-submission"
import { makeFailure } from "../operation-failure"
import { failureKind, operationError } from "../operation-error"
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
    rootTurnOwner,
    turnMutationAdmission,
    resolveExecutionRoute,
    ensureTurnSummary,
  } = input
  return Effect.gen(function* () {
    const turns = yield* TurnRepository.Service
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
        claim: (turnId, status) =>
          rootTurnOwner.claim(turnId, status).pipe(Effect.mapError((error) => operationError(String(error), error))),
      }),
    )
    if (observed.turn.status !== "queued" && observed.claimed !== true)
      return yield* operationError(`Turn ${observed.turn.id} already has an execution observer`)
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

interface SettleInteractiveSubmissionState {
  readonly thread: Thread.Thread
  readonly turn: Turn.AgentExecutionTurn
  readonly outcome: Exit.Exit<ExecutionProjection.Result | undefined, unknown>
  readonly publish: (change: ExecutionProjection.Change) => void
  readonly dispatch: (event: InteractiveEvent) => void
}

const settleInteractiveSubmissionImpl = (
  input: InteractiveSubmissionContext,
  state: SettleInteractiveSubmissionState,
) => {
  const { setTurnStatus, settleThread } = input
  const { thread, turn, outcome, publish, dispatch } = state
  return Effect.uninterruptible(
    Effect.gen(function* () {
      if (outcome._tag === "Failure") {
        if (Cause.hasInterruptsOnly(outcome.cause)) {
          yield* setTurnStatus(turn.id, "cancelled", yield* Clock.currentTimeMillis)
          return
        }
        yield* setTurnStatus(turn.id, "failed", yield* Clock.currentTimeMillis)
        // The cause is right here; a hardcoded sentence would discard the one fact the user needs.
        emitEvent(input, dispatch, {
          _tag: "ExecutionFailed",
          selectionEpoch: 0,
          threadId: thread.id,
          turnId: turn.id,
          failure: makeFailure(Cause.squash(outcome.cause)),
        })
        yield* settleThread(thread, dispatch)
        return
      }
      const result = outcome.value
      if (result === undefined) return yield* settleThread(thread, dispatch)
      for (const change of result.changes) publish(change)
      yield* setTurnStatus(turn.id, result.status, yield* Clock.currentTimeMillis)
      if (result.status === "waiting" || result.status === "running" || result.status === "cancelling") return
      if (result.status === "failed") {
        // The projector carried the run's real failure into the last Error unit; surface it
        // instead of a generic status sentence.
        const errorUnit = [...result.units].reverse().find((unit) => {
          const content = unit.content as { _tag?: string; block?: { _tag?: string } }
          return content._tag === "Block" && content.block?._tag === "Error"
        })
        const errorBlock = (errorUnit?.content as { block?: { title?: string; detail?: string } } | undefined)?.block
        const message =
          errorBlock?.detail !== undefined && errorBlock.detail.length > 0
            ? errorBlock.detail
            : (errorBlock?.title ?? `Execution ${result.status}`)
        emitEvent(input, dispatch, {
          _tag: "ExecutionFailed",
          selectionEpoch: 0,
          threadId: thread.id,
          turnId: turn.id,
          failure: makeFailure(message),
        })
      }
      yield* settleThread(thread, dispatch)
    }),
  )
}

export const settleInteractiveSubmission: {
  (
    arg1: SettleInteractiveSubmissionState,
  ): (arg0: InteractiveSubmissionContext) => ReturnType<typeof settleInteractiveSubmissionImpl>
  (
    arg0: InteractiveSubmissionContext,
    arg1: SettleInteractiveSubmissionState,
  ): ReturnType<typeof settleInteractiveSubmissionImpl>
} = Function.dual(2, settleInteractiveSubmissionImpl)

const executeInteractiveSubmissionImpl = (
  input: InteractiveSubmissionContext,
  thread: Thread.Thread,
  turn: Turn.AgentExecutionTurn,
  modelTuning: { readonly fastMode?: boolean } | undefined,
  dispatch: (event: InteractiveEvent) => void,
  submissionId?: string,
) => {
  const { prepareExecution, setTurnStatus, rootTurnOwner, dispatchFailure, releaseTurnObserver, notifyTurnChanged } =
    input
  return Effect.gen(function* () {
    const clock = yield* Clock.Clock
    const startedAt = clock.currentTimeMillisUnsafe()
    const delivered = new Set<string>()
    const publish = (change: ExecutionProjection.Change) => {
      const key = `${change._tag}:${change.revision}`
      if (delivered.has(key)) return
      delivered.add(key)
      emitEvent(input, dispatch, {
        _tag: "ExecutionProjectionChanged",
        threadId: thread.id,
        turn: { ...turn, status: change.state.status, updatedAt: clock.currentTimeMillisUnsafe() },
        change,
      })
    }
    const outcome = yield* Effect.exit(
      Effect.gen(function* () {
        const prepared = yield* prepareExecution(turn, thread.workspace)
        if (prepared.messages.length > 0)
          emitEvent(input, dispatch, {
            _tag: "ContextDiagnostics",
            selectionEpoch: 0,
            threadId: thread.id,
            turnId: turn.id,
            messages: prepared.messages,
          })
        const running = yield* setTurnStatus(turn.id, "running", startedAt)
        if (running.status !== "running") return undefined
        emitEvent(input, dispatch, {
          _tag: "TurnStarted",
          selectionEpoch: 0,
          activitySequence: 0,
          threadId: thread.id,
          turn: running,
          ...(submissionId === undefined ? {} : { submissionId }),
        })
        const turns = yield* TurnRepository.Service
        const titleIntent =
          (yield* turns.list(thread.id)).length === 1 && thread.title === input.temporaryThreadTitle(turn.prompt)
            ? ({ _tag: "GenerateThreadTitle", expectedTitle: thread.title } as const)
            : undefined
        yield* rootTurnOwner.startTurn({
          threadId: thread.id,
          turnId: turn.id,
          workspace: thread.workspace,
          prompt: prepared.prompt,
          ...(prepared.promptParts === undefined ? {} : { promptParts: prepared.promptParts }),
          executionRoute: turn.executionRoute,
          ...(titleIntent === undefined ? {} : { titleIntent }),
        })
        return yield* rootTurnOwner.watchTurn(turn.id, publish)
      }),
    )
    yield* settleInteractiveSubmission(input, { thread, turn, outcome, publish, dispatch })
  }).pipe(
    Effect.provide(input.executionDependencies),
    Effect.scoped,
    Effect.tapCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.logError("interactive.submit.failed").pipe(
            Effect.annotateLogs("rika.failure.kind", failureKind(cause)),
          ),
    ),
    Effect.catch((error) => Effect.sync(() => dispatchFailure(dispatch, error, undefined, turn.id))),
    Effect.ensuring(releaseTurnObserver(turn.id).pipe(Effect.andThen(notifyTurnChanged(turn)), Effect.ignore)),
  )
}

export const executeInteractiveSubmission: {
  (
    arg1: Thread.Thread,
    arg2: Turn.AgentExecutionTurn,
    arg3: { readonly fastMode?: boolean } | undefined,
    arg4: (event: InteractiveEvent) => void,
    arg5?: string,
  ): (arg0: InteractiveSubmissionContext) => ReturnType<typeof executeInteractiveSubmissionImpl>
  (
    arg0: InteractiveSubmissionContext,
    arg1: Thread.Thread,
    arg2: Turn.AgentExecutionTurn,
    arg3: { readonly fastMode?: boolean } | undefined,
    arg4: (event: InteractiveEvent) => void,
    arg5?: string,
  ): ReturnType<typeof executeInteractiveSubmissionImpl>
} = Function.dual(6, executeInteractiveSubmissionImpl)

export const submitInteractiveOperation = (input: InteractiveSubmissionContext) => {
  const {
    workspace,
    options,
    temporaryThreadTitle,
    notifyThreadSummaries,
    sessionScope,
    submissionAdmission,
    executionDependencies,
    dispatchFailure,
    releaseTurnObserver,
    notifyTurnChanged,
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
    let executionLaunched = false
    const program = Effect.gen(function* () {
      const threads = yield* ThreadRepository.Service
      let thread = yield* Ref.get(interactiveThread)
      let created = false
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
      const admitted = yield* admitInteractiveSubmission(
        input,
        thread,
        prompt,
        mode,
        modelTuning,
        promptParts,
        dispatch,
        submissionId,
      )
      const turn = admitted as Turn.Turn
      observerTurn = turn.status === "queued" ? undefined : turn
      if (created) yield* activateCreatedThread(thread, getCurrentSelectionEpoch(), dispatch, turn)
      if (turn.status === "queued") {
        if ("queue" in admitted && admitted.queue !== undefined)
          emitEvent(input, dispatch, queueMutationEvent(admitted.queue))
        return
      }
      yield* Effect.uninterruptible(
        Effect.forkIn(
          Effect.interruptible(
            executeInteractiveSubmission(
              input,
              thread,
              turn as Turn.AgentExecutionTurn,
              modelTuning,
              dispatch,
              submissionId,
            ),
          ),
          sessionScope,
        ).pipe(Effect.asVoid),
      )
      executionLaunched = true
    })
    yield* submissionAdmission
      .withPermits(1)(program)
      .pipe(
        Effect.provide(executionDependencies),
        Effect.scoped,
        Effect.catch((error) => Effect.sync(() => dispatchFailure(dispatch, error, undefined, observerTurn?.id))),
        Effect.ensuring(
          Effect.suspend(() =>
            observerTurn === undefined || executionLaunched
              ? Effect.void
              : releaseTurnObserver(observerTurn!.id).pipe(
                  Effect.andThen(notifyTurnChanged(observerTurn!)),
                  Effect.ignore,
                ),
          ),
        ),
      )
  })
  return submit
}
