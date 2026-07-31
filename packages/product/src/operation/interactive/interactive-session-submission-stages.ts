import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as ThreadActivity from "../../thread/query/thread-activity"
import { Cause, Clock, Effect, Ref } from "effect"
import { admitInteractiveTurn } from "./interactive-turn-submission"
import { failureKind, operationError } from "../operation-error"
import type { ModeId } from "@rika/configuration/behavior-mode"
import type { InteractiveEvent } from "./interactive-event"

const emitEvent = (input: any, dispatch: (event: InteractiveEvent) => void, event: InteractiveEvent) =>
  input.emit(dispatch, event)

export const admitInteractiveSubmission = (
  input: any,
  thread: Thread.Thread,
  prompt: string,
  mode: ModeId,
  modelTuning: { readonly fastMode?: boolean } | undefined,
  promptParts: ReadonlyArray<Turn.PromptPart> | undefined,
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
    const turns = (yield* TurnRepository.Service) as TurnRepository.Interface
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
        claim: rootTurnOwner.claim,
      }),
    )
    if (observed.turn.status !== "queued" && !observed.claimed)
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

export const settleInteractiveSubmission = (input: any, state: any) => {
  const {
    setTurnStatus,
    deliverResultEvents,
    projectExecutionResult,
    ensureIngest,
    settleThread,
    titleThread,
    executionStartFailureMessage,
  } = input
  const { thread, turn, outcome, deliveredCursors, dispatch } = state
  return Effect.uninterruptible(
    Effect.gen(function* () {
      if (outcome._tag === "Failure") {
        if (Cause.hasInterruptsOnly(outcome.cause)) return
        yield* setTurnStatus(turn.id, "failed", turn.lastCursor, yield* Clock.currentTimeMillis)
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
      if (result === undefined) return yield* settleThread(thread, dispatch)
      deliverResultEvents(turn.id, result.events, deliveredCursors)
      const updated = yield* setTurnStatus(
        turn.id,
        result.status,
        result.checkpoint?.cursor ?? ThreadActivity.latestCursor(turn.id, result.events) ?? turn.lastCursor,
        yield* Clock.currentTimeMillis,
      )
      yield* projectExecutionResult(thread.id, result)
      yield* ensureIngest(updated.threadId, updated.id)
      if (result.status === "completed") {
        yield* settleThread(thread, dispatch)
        if (turn.id === (yield* (yield* TurnRepository.Service).list(thread.id))[0]?.id)
          yield* Effect.interruptible(
            titleThread(thread, updated, (event: InteractiveEvent) => emitEvent(input, dispatch, event)),
          )
        return
      }
      if (result.status === "waiting" || result.status === "running" || result.status === "queued") return
      if (
        result.status === "failed" &&
        !result.events.some((event: ExecutionBackend.Event) => event.type === "execution.failed")
      )
        emitEvent(input, dispatch, {
          _tag: "ExecutionFailed",
          selectionEpoch: 0,
          threadId: thread.id,
          turnId: turn.id,
          message: `Execution ${result.status}`,
        })
      if (result.status !== "failed") yield* settleThread(thread, dispatch)
    }),
  )
}

export const executeInteractiveSubmission = (
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
  return Effect.gen(function* () {
    const backend = yield* ExecutionBackend.Service
    const startedAt = yield* Clock.currentTimeMillis
    const deliveredCursors = new Set<string>()
    const outcome = yield* Effect.exit(
      Effect.gen(function* () {
        if ((yield* awaitSessionQuiescence(backend, thread.id)) !== undefined) {
          const turns = (yield* TurnRepository.Service) as TurnRepository.Interface
          const requeued = yield* turns.requeueAccepted(turn.id, pendingTurnCapacity, yield* Clock.currentTimeMillis)
          emitEvent(input, dispatch, queueMutationEvent(requeued.queue))
          return undefined
        }
        const prepared = yield* prepareExecution(turn, thread.workspace)
        if (prepared.messages.length > 0)
          emitEvent(input, dispatch, {
            _tag: "ContextDiagnostics",
            selectionEpoch: 0,
            threadId: thread.id,
            turnId: turn.id,
            messages: prepared.messages,
          })
        const running = yield* setTurnStatus(turn.id, "running", turn.lastCursor, startedAt)
        if (running.status !== "running") return undefined
        emitEvent(input, dispatch, {
          _tag: "TurnStarted",
          selectionEpoch: 0,
          threadId: thread.id,
          turn: running,
          ...(submissionId === undefined ? {} : { submissionId }),
        })
        yield* ensureIngest(thread.id, turn.id)
        return yield* rootTurnOwner.start({
          threadId: thread.id,
          turnId: turn.id,
          prompt: prepared.prompt,
          ...(prepared.promptParts === undefined ? {} : { promptParts: prepared.promptParts }),
          executionRoute: turn.executionRoute,
          ...(modelTuning?.fastMode === undefined ? {} : { fastMode: modelTuning.fastMode }),
          eventScope: "execution",
          onEvent: (event: ExecutionBackend.Event) => {
            deliveredCursors.add(event.cursor)
            input.executionIngest.deliver(turn.id, event)
          },
          ...(prepared.extensionPin === undefined ? {} : { extensionPin: prepared.extensionPin }),
        })
      }),
    )
    yield* settleInteractiveSubmission(input, { thread, turn, outcome, deliveredCursors, dispatch })
  }).pipe(
    Effect.provide(executionDependencies),
    Effect.scoped,
    Effect.tapCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.logError("interactive.submit.failed").pipe(
            Effect.annotateLogs("rika.failure.kind", failureKind(cause)),
          ),
    ),
    Effect.catch((error) => Effect.sync(() => dispatchFailure(dispatch, error))),
    Effect.ensuring(releaseTurnObserver(turn.id).pipe(Effect.andThen(notifyTurnChanged(turn)))),
  )
}

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
  const submit = Effect.fn("ProductOperation.interactive.submit")(function* (
    prompt: string,
    dispatch: (event: InteractiveEvent) => void,
    mode: ModeId = "medium",
    promptParts?: ReadonlyArray<Turn.PromptPart>,
    modelTuning?: { readonly fastMode?: boolean },
    submissionId?: string,
  ) {
    let observerTurn: Turn.Turn | undefined
    let executionLaunched = false
    const program = Effect.gen(function* () {
      const threads = (yield* ThreadRepository.Service) as ThreadRepository.Interface
      let thread = (yield* Ref.get(input.interactiveThread)) as Thread.Thread | undefined
      if (thread === undefined) {
        thread = yield* threads.create({
          id: yield* options.makeThreadId,
          workspace,
          title: temporaryThreadTitle(prompt),
          now: yield* Clock.currentTimeMillis,
        })
        yield* input.activateCreatedThread(thread, input.getCurrentSelectionEpoch(), dispatch)
      }
      const turns = (yield* TurnRepository.Service) as TurnRepository.Interface
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
        Effect.catch((error) => Effect.sync(() => dispatchFailure(dispatch, error))),
        Effect.ensuring(
          Effect.suspend(() =>
            observerTurn === undefined || executionLaunched
              ? Effect.void
              : releaseTurnObserver(observerTurn!.id).pipe(Effect.andThen(notifyTurnChanged(observerTurn!))),
          ),
        ),
      )
  })
  return submit
}
