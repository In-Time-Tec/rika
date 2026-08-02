import { Effect } from "effect"
import { OperationError, operationError } from "../operation-error"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as ExecutionEvent from "@rika/product/execution-event"
import * as Turn from "@rika/product/turn-record"
import * as ThreadResult from "@rika/product/thread-result"
import * as ExecutionStatus from "@rika/product/execution-status"
import * as TurnRepository from "@rika/product/turn-repository"
import * as Thread from "@rika/product/thread-record"
import * as ThreadActivity from "../../thread/query/thread-activity"
import type * as RootTurnOwner from "../../thread/queue/root-turn-owner"
import { isTerminalStatus } from "../../execution/contract/execution-status"
import type { InteractiveEvent } from "./interactive-event"

export const followChildRun = (input: {
  readonly turnId: Turn.TurnId
  readonly turns: TurnRepository.Interface
  readonly backend: ExecutionBackend.Interface
  readonly owner: RootTurnOwner.Interface
  readonly ensureIngest: (threadId: Thread.ThreadId, turnId: Turn.TurnId) => Effect.Effect<void, OperationError, never>
  readonly deliverResultEvents: (
    turnId: Turn.TurnId,
    events: ReadonlyArray<ExecutionEvent.Event>,
    delivered?: ReadonlySet<string>,
  ) => void
  readonly setTurnStatus: (
    id: Turn.TurnId,
    status: ExecutionStatus.Status,
    cursor: string | undefined,
    now: number,
  ) => Effect.Effect<Turn.Turn, OperationError, never>
  readonly projectExecutionResult: (
    threadId: Thread.ThreadId,
    result: ExecutionEvent.Result,
  ) => Effect.Effect<void, OperationError, never>
  readonly settleThread: (
    thread: Thread.Thread,
    dispatch: (event: InteractiveEvent) => void,
  ) => Effect.Effect<void, OperationError, never>
  readonly threadForTurn: (turn: Turn.Turn) => Effect.Effect<Thread.Thread, OperationError, never>
  readonly titleThread: (
    thread: Thread.Thread,
    turn: Turn.AgentExecutionTurn,
    dispatch: (event: InteractiveEvent) => void,
  ) => Effect.Effect<void, OperationError, never>
  readonly dispatch: (event: InteractiveEvent) => void
  readonly emit: (dispatch: (event: InteractiveEvent) => void, event: InteractiveEvent) => void
  readonly now: Effect.Effect<number>
}) =>
  Effect.gen(function* () {
    if (input.backend.follow === undefined) return
    const turn = yield* input.turns.get(input.turnId)
    if (turn === undefined) return yield* operationError(`Turn ${input.turnId} does not exist`)
    if (!ThreadResult.TurnResult.isAgentExecution(turn))
      return yield* operationError(`Recorded shell turn ${input.turnId} cannot be followed as an execution`)
    const thread = yield* input.threadForTurn(turn)
    yield* input.ensureIngest(turn.threadId, turn.id)
    const delivered = new Set<string>()
    const result = yield* input.owner.follow!(
      turn.id,
      turn.lastCursor,
      (event) => {
        delivered.add(event.cursor)
        input.deliverResultEvents(turn.id, [event])
      },
      undefined,
      "execution",
    )
    input.deliverResultEvents(turn.id, result.events, delivered)
    const updated = yield* input.setTurnStatus(
      turn.id,
      result.status,
      result.checkpoint?.cursor ?? ThreadActivity.latestCursor(turn.id, result.events) ?? turn.lastCursor,
      yield* input.now,
    )
    yield* input.projectExecutionResult(turn.threadId, result)
    yield* input.ensureIngest(updated.threadId, updated.id)
    if (isTerminalStatus(result.status)) {
      yield* input.settleThread(thread, input.dispatch)
      if (
        result.status === "completed" &&
        ThreadResult.TurnResult.isAgentExecution(updated) &&
        (yield* input.turns.list(thread.id))[0]?.id === updated.id
      )
        yield* input.titleThread(thread, updated, (event) => input.emit(input.dispatch, event))
    } else if (!["waiting", "running", "queued"].includes(result.status))
      input.emit(input.dispatch, {
        _tag: "ExecutionFailed",
        selectionEpoch: 0,
        threadId: turn.threadId,
        turnId: turn.id,
        message: `Execution ${result.status}`,
      })
  })

export const observeChildRun = (input: {
  readonly turn: Turn.AgentExecutionTurn
  readonly backend: ExecutionBackend.Interface
  readonly claim: (turnId: Turn.TurnId) => Effect.Effect<boolean, OperationError, never>
  readonly release: (turnId: Turn.TurnId, notify?: boolean) => Effect.Effect<void, OperationError, never>
  readonly follow: Effect.Effect<
    void,
    OperationError | ExecutionBackend.BackendError | TurnRepository.RepositoryError,
    ExecutionBackend.Service | TurnRepository.Service
  >
}) =>
  Effect.gen(function* () {
    if ((yield* input.backend.inspect(input.turn.id)) === undefined) return false
    return yield* Effect.uninterruptibleMask((restore) =>
      input
        .claim(input.turn.id)
        .pipe(
          Effect.flatMap((claimed) =>
            !claimed
              ? Effect.succeed(false)
              : restore(input.follow).pipe(
                  Effect.as(true),
                  Effect.ensuring(input.release(input.turn.id, false).pipe(Effect.ignore)),
                ),
          ),
        ),
    )
  })
