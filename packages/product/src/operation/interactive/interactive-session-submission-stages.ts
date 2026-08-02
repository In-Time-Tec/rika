import { Function } from "effect"
import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionRequest from "@rika/product/execution-request"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as ExecutionEvent from "@rika/product/execution-event"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as ThreadActivity from "../../thread/query/thread-activity"
import { Context, Cause, Clock, Effect, Ref, Semaphore } from "effect"
import { admitInteractiveTurn } from "./interactive-turn-submission"
import { OperationError, failureKind, operationError } from "../operation-error"
import type { ModeId } from "@rika/configuration/behavior-mode"
import type { InteractiveEvent } from "./interactive-event"
import { agentResponseArrived } from "./interactive-session-interface-support"

const emitEvent = (input: any, dispatch: (event: InteractiveEvent) => void, event: InteractiveEvent) =>
  input.emit(dispatch, event)

const admitInteractiveSubmissionImpl = (
  input: any,
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
  const typedAdmission: Semaphore.Semaphore = turnMutationAdmission
  const typedResolveExecutionRoute: (
    mode: ModeId,
    tuning: { readonly fastMode?: boolean } | undefined,
    workspace: string,
  ) => Effect.Effect<ExecutionRouteSnapshot.ExecutionRouteSnapshot, OperationError, never> = resolveExecutionRoute
  const typedEnsureTurnSummary: (turn: Turn.Turn) => Effect.Effect<void, OperationError, never> = ensureTurnSummary
  const typedMakeTurnId: Effect.Effect<Turn.TurnId, never, never> = options.makeTurnId
  const typedRootTurnOwner: import("../../thread/queue/root-turn-owner").Interface = rootTurnOwner
  return Effect.gen(function* () {
    const turns = (yield* TurnRepository.Service) as TurnRepository.Interface
    const executionRoute = yield* typedResolveExecutionRoute(mode, modelTuning, thread.workspace)
    const observed = yield* typedAdmission.withPermits(1)(
      admitInteractiveTurn({
        turns,
        submission: {
          id: yield* typedMakeTurnId,
          threadId: thread.id,
          prompt,
          ...(promptParts === undefined ? {} : { promptParts }),
          executionRoute,
          queueCapacity: pendingTurnCapacity,
          now: yield* Clock.currentTimeMillis,
        },
        claim: (turnId, status) =>
          typedRootTurnOwner
            .claim(turnId, status)
            .pipe(Effect.mapError((error) => operationError(String(error), error))),
      }),
    )
    if (observed.turn.status !== "queued" && observed.claimed !== true)
      return yield* operationError(`Turn ${observed.turn.id} already has an execution observer`)
    yield* typedEnsureTurnSummary(observed.turn)
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
  ): (arg0: any) => ReturnType<typeof admitInteractiveSubmissionImpl>
  (
    arg0: any,
    arg1: Thread.Thread,
    arg2: string,
    arg3: ModeId,
    arg4: { readonly fastMode?: boolean } | undefined,
    arg5: ReadonlyArray<ExecutionRequest.PromptPart> | undefined,
    arg6: (event: InteractiveEvent) => void,
    arg7?: string,
  ): ReturnType<typeof admitInteractiveSubmissionImpl>
} = Function.dual(8, admitInteractiveSubmissionImpl)

const settleInteractiveSubmissionImpl = (input: any, state: any) => {
  const {
    setTurnStatus,
    deliverResultEvents,
    projectExecutionResult,
    ensureIngest,
    settleThread,
    titleThread,
    executionStartFailureMessage,
  } = input
  const typedSetTurnStatus: (
    id: Turn.TurnId,
    status: import("@rika/product/execution-status").Status,
    cursor: string | undefined,
    now: number,
    responseArrived?: boolean,
  ) => Effect.Effect<Turn.Turn, OperationError, never> = setTurnStatus
  const typedProjectExecutionResult: (
    threadId: Turn.Turn["threadId"],
    result: ExecutionEvent.Result,
  ) => Effect.Effect<void, OperationError, never> = projectExecutionResult
  const typedEnsureIngest: (
    threadId: Turn.Turn["threadId"],
    turnId: Turn.Turn["id"],
  ) => Effect.Effect<void, OperationError, never> = ensureIngest
  const typedSettleThread: (
    thread: Thread.Thread,
    dispatch: (event: InteractiveEvent) => void,
  ) => Effect.Effect<void, OperationError, never> = settleThread
  const typedTitleThread: (
    thread: Thread.Thread,
    turn: Turn.Turn,
    dispatch: (event: InteractiveEvent) => void,
  ) => Effect.Effect<void, OperationError, never> = titleThread
  const { thread, turn, outcome, deliveredCursors, dispatch } = state
  return Effect.uninterruptible(
    Effect.gen(function* () {
      if (outcome._tag === "Failure") {
        if (Cause.hasInterruptsOnly(outcome.cause)) return
        yield* typedSetTurnStatus(turn.id, "failed", turn.lastCursor, yield* Clock.currentTimeMillis)
        emitEvent(input, dispatch, {
          _tag: "ExecutionFailed",
          selectionEpoch: 0,
          threadId: thread.id,
          turnId: turn.id,
          message: executionStartFailureMessage,
        })
        return
      }
      const result = outcome.value
      if (result === undefined) return yield* typedSettleThread(thread, dispatch)
      deliverResultEvents(turn.id, result.events, deliveredCursors)
      const updated = yield* typedSetTurnStatus(
        turn.id,
        result.status,
        result.checkpoint?.cursor ?? ThreadActivity.latestCursor(turn.id, result.events) ?? turn.lastCursor,
        yield* Clock.currentTimeMillis,
        result.status === "cancelled" ? agentResponseArrived(result.events) : undefined,
      )
      yield* typedProjectExecutionResult(thread.id, result)
      yield* typedEnsureIngest(updated.threadId, updated.id)
      if (result.status === "completed") {
        yield* typedSettleThread(thread, dispatch)
        if (turn.id === (yield* (yield* TurnRepository.Service).list(thread.id))[0]?.id)
          yield* Effect.interruptible(
            typedTitleThread(thread, updated, (event: InteractiveEvent) => emitEvent(input, dispatch, event)),
          )
        return
      }
      if (result.status === "waiting" || result.status === "running" || result.status === "queued") return
      if (
        result.status === "failed" &&
        result.events.some((event: ExecutionEvent.Event) => event.type === "execution.failed") === false
      )
        emitEvent(input, dispatch, {
          _tag: "ExecutionFailed",
          selectionEpoch: 0,
          threadId: thread.id,
          turnId: turn.id,
          message: `Execution ${result.status}`,
        })
      if (result.status !== "failed") yield* typedSettleThread(thread, dispatch)
    }),
  )
}

export const settleInteractiveSubmission: {
  (arg1: any): (arg0: any) => ReturnType<typeof settleInteractiveSubmissionImpl>
  (arg0: any, arg1: any): ReturnType<typeof settleInteractiveSubmissionImpl>
} = Function.dual(2, settleInteractiveSubmissionImpl)

const executeInteractiveSubmissionImpl = (
  input: any,
  thread: Thread.Thread,
  turn: Turn.AgentExecutionTurn,
  modelTuning: { readonly fastMode?: boolean } | undefined,
  dispatch: (event: InteractiveEvent) => void,
  submissionId?: string,
) => {
  const {
    awaitSessionQuiescence,
    pendingTurnCapacity,
    prepareExecution,
    setTurnStatus,
    ensureIngest,
    rootTurnOwner,
    executionDependencies,
    dispatchFailure,
    releaseTurnObserver,
    notifyTurnChanged,
    queueMutationEvent,
  } = input
  const typedAwaitSessionQuiescence: (
    backend: ExecutionBackend.Interface,
    threadId: Turn.Turn["threadId"],
  ) => Effect.Effect<Turn.Turn | undefined, OperationError, never> = awaitSessionQuiescence
  const typedPrepareExecution: (
    turn: Turn.AgentExecutionTurn,
    workspace: string,
  ) => Effect.Effect<
    {
      readonly prompt: string
      readonly promptParts?: ReadonlyArray<ExecutionRequest.PromptPart>
      readonly extensionPin?: Turn.AgentExecutionTurn["extensionPin"]
      readonly messages: ReadonlyArray<string>
    },
    OperationError,
    never
  > = prepareExecution
  const typedSetTurnStatus: (
    id: Turn.TurnId,
    status: import("@rika/product/execution-status").Status,
    cursor: string | undefined,
    now: number,
    responseArrived?: boolean,
  ) => Effect.Effect<Turn.Turn, OperationError, never> = setTurnStatus
  const typedEnsureIngest: (
    threadId: Turn.Turn["threadId"],
    turnId: Turn.Turn["id"],
  ) => Effect.Effect<void, OperationError, never> = ensureIngest
  const typedRootTurnOwner: import("../../thread/queue/root-turn-owner").Interface = rootTurnOwner
  const typedExecutionDependencies: Context.Context<ExecutionBackend.Service | TurnRepository.Service> =
    executionDependencies
  const typedReleaseTurnObserver: (turnId: Turn.TurnId) => Effect.Effect<void, OperationError, never> =
    releaseTurnObserver
  const typedNotifyTurnChanged: (
    turn: Pick<Turn.Turn, "id" | "threadId">,
  ) => Effect.Effect<void, OperationError, never> = notifyTurnChanged
  return Effect.gen(function* () {
    const backend = yield* ExecutionBackend.Service
    const startedAt = yield* Clock.currentTimeMillis
    const deliveredCursors = new Set<string>()
    const outcome = yield* Effect.exit(
      Effect.gen(function* () {
        if ((yield* typedAwaitSessionQuiescence(backend, thread.id)) !== undefined) {
          const turns = (yield* TurnRepository.Service) as TurnRepository.Interface
          const requeued = yield* turns.requeueAccepted(turn.id, pendingTurnCapacity, yield* Clock.currentTimeMillis)
          emitEvent(input, dispatch, queueMutationEvent(requeued.queue))
          return undefined
        }
        const prepared = yield* typedPrepareExecution(turn, thread.workspace)
        if (prepared.messages.length > 0)
          emitEvent(input, dispatch, {
            _tag: "ContextDiagnostics",
            selectionEpoch: 0,
            threadId: thread.id,
            turnId: turn.id,
            messages: prepared.messages,
          })
        const running = yield* typedSetTurnStatus(turn.id, "running", turn.lastCursor, startedAt)
        if (running.status !== "running") return undefined
        emitEvent(input, dispatch, {
          _tag: "TurnStarted",
          selectionEpoch: 0,
          activitySequence: 0,
          threadId: thread.id,
          turn: running,
          ...(submissionId === undefined ? {} : { submissionId }),
        })
        yield* typedEnsureIngest(thread.id, turn.id)
        return yield* typedRootTurnOwner.start({
          threadId: thread.id,
          turnId: turn.id,
          prompt: prepared.prompt,
          ...(prepared.promptParts === undefined ? {} : { promptParts: prepared.promptParts }),
          executionRoute: turn.executionRoute,
          ...(modelTuning?.fastMode === undefined ? {} : { fastMode: modelTuning.fastMode }),
          eventScope: "execution",
          onEvent: (event: ExecutionEvent.Event) => {
            deliveredCursors.add(event.cursor)
            input.executionIngest.deliver(turn.id, event)
          },
          ...(prepared.extensionPin === undefined ? {} : { extensionPin: prepared.extensionPin }),
        })
      }),
    )
    yield* settleInteractiveSubmission(input, { thread, turn, outcome, deliveredCursors, dispatch })
  }).pipe(
    Effect.provide(typedExecutionDependencies),
    Effect.scoped,
    Effect.tapCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.logError("interactive.submit.failed").pipe(
            Effect.annotateLogs("rika.failure.kind", failureKind(cause)),
          ),
    ),
    Effect.catch((error) => Effect.sync(() => dispatchFailure(dispatch, error))),
    Effect.ensuring(
      typedReleaseTurnObserver(turn.id).pipe(Effect.andThen(typedNotifyTurnChanged(turn)), Effect.ignore),
    ),
  )
}

export const executeInteractiveSubmission: {
  (
    arg1: Thread.Thread,
    arg2: Turn.AgentExecutionTurn,
    arg3: { readonly fastMode?: boolean } | undefined,
    arg4: (event: InteractiveEvent) => void,
    arg5?: string,
  ): (arg0: any) => ReturnType<typeof executeInteractiveSubmissionImpl>
  (
    arg0: any,
    arg1: Thread.Thread,
    arg2: Turn.AgentExecutionTurn,
    arg3: { readonly fastMode?: boolean } | undefined,
    arg4: (event: InteractiveEvent) => void,
    arg5?: string,
  ): ReturnType<typeof executeInteractiveSubmissionImpl>
} = Function.dual(6, executeInteractiveSubmissionImpl)

export const submitInteractiveOperation = (input: any) => {
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
  } = input
  const typedSubmissionAdmission: Semaphore.Semaphore = submissionAdmission
  const typedSubmitExecutionDependencies: Context.Context<
    ThreadRepository.Service | TurnRepository.Service | ExecutionBackend.Service
  > = executionDependencies
  const typedSubmitReleaseTurnObserver: (turnId: Turn.TurnId) => Effect.Effect<void, OperationError, never> =
    releaseTurnObserver
  const typedSubmitNotifyTurnChanged: (
    turn: Pick<Turn.Turn, "id" | "threadId">,
  ) => Effect.Effect<void, OperationError, never> = notifyTurnChanged
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
    const typedInteractiveThread: Ref.Ref<Thread.Thread | undefined> = input.interactiveThread
    const typedMakeThreadId: Effect.Effect<Thread.ThreadId, never, never> = options.makeThreadId
    const typedTemporaryThreadTitle: (prompt: string) => string = temporaryThreadTitle
    const typedActivateCreatedThread: (
      thread: Thread.Thread,
      epoch: number,
      dispatch: (event: InteractiveEvent) => void,
    ) => Effect.Effect<void, OperationError, never> = input.activateCreatedThread
    const typedNotifyThreadSummaries: Effect.Effect<void, OperationError, never> = notifyThreadSummaries
    const program = Effect.gen(function* () {
      const threads = (yield* ThreadRepository.Service) as ThreadRepository.Interface
      let thread = (yield* Ref.get(typedInteractiveThread)) as Thread.Thread | undefined
      if (thread === undefined) {
        thread = yield* threads.create({
          id: yield* typedMakeThreadId,
          workspace,
          title: typedTemporaryThreadTitle(prompt),
          now: yield* Clock.currentTimeMillis,
        })
        yield* typedActivateCreatedThread(thread, input.getCurrentSelectionEpoch(), dispatch)
      }
      const turns = (yield* TurnRepository.Service) as TurnRepository.Interface
      if (thread.title === "New thread" && (yield* turns.list(thread.id)).length === 1) {
        const renamed = yield* threads.renameIfTitle(
          thread.id,
          "New thread",
          typedTemporaryThreadTitle(prompt),
          yield* Clock.currentTimeMillis,
        )
        if (renamed !== undefined) {
          thread = renamed
          emitEvent(input, dispatch, { _tag: "ThreadTitled", threadId: String(thread.id), title: thread.title })
          yield* typedNotifyThreadSummaries
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
    yield* typedSubmissionAdmission
      .withPermits(1)(program)
      .pipe(
        Effect.provide(typedSubmitExecutionDependencies),
        Effect.scoped,
        Effect.catch((error) => Effect.sync(() => dispatchFailure(dispatch, error))),
        Effect.ensuring(
          Effect.suspend(() =>
            observerTurn === undefined || executionLaunched
              ? Effect.void
              : typedSubmitReleaseTurnObserver(observerTurn!.id).pipe(
                  Effect.andThen(typedSubmitNotifyTurnChanged(observerTurn!)),
                  Effect.ignore,
                ),
          ),
        ),
      )
  })
  return submit
}
