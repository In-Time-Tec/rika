import { Effect } from "effect"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as Turn from "@rika/product/turn-record"
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
  readonly ensureIngest: (threadId: Thread.ThreadId, turnId: Turn.TurnId) => Effect.Effect<any, any, any>
  readonly deliverResultEvents: (
    turnId: Turn.TurnId,
    events: ReadonlyArray<ExecutionBackend.Event>,
    delivered?: ReadonlySet<string>,
  ) => void
  readonly setTurnStatus: (
    id: Turn.TurnId,
    status: Turn.Status,
    cursor: string | undefined,
    now: number,
  ) => Effect.Effect<any, any, any>
  readonly projectExecutionResult: (
    threadId: Thread.ThreadId,
    result: ExecutionBackend.Result,
  ) => Effect.Effect<any, any, any>
  readonly settleThread: (
    thread: Thread.Thread,
    dispatch: (event: InteractiveEvent) => void,
  ) => Effect.Effect<any, any, any>
  readonly threadForTurn: (turn: Turn.Turn) => Effect.Effect<any, any, any>
  readonly titleThread: (
    thread: Thread.Thread,
    turn: Turn.AgentExecutionTurn,
    dispatch: (event: InteractiveEvent) => void,
  ) => Effect.Effect<any, any, any>
  readonly dispatch: (event: InteractiveEvent) => void
  readonly emit: (dispatch: (event: InteractiveEvent) => void, event: InteractiveEvent) => void
  readonly now: Effect.Effect<number>
}) =>
  Effect.gen(function* () {
    if (input.backend.follow === undefined) return
    const turn = yield* input.turns.get(input.turnId)
    if (turn === undefined) return yield* Effect.fail(new Error(`Turn ${input.turnId} does not exist`))
    if (!Turn.isAgentExecution(turn))
      return yield* Effect.fail(new Error(`Recorded shell turn ${input.turnId} cannot be followed as an execution`))
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
      if (result.status === "completed" && (yield* input.turns.list(thread.id))[0]?.id === updated.id)
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
  readonly claim: (turnId: Turn.TurnId) => Effect.Effect<boolean, any, any>
  readonly release: (turnId: Turn.TurnId, notify?: boolean) => Effect.Effect<any, any, any>
  readonly follow: Effect.Effect<void, any, any>
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
              : restore(input.follow as Effect.Effect<any, never, any>).pipe(
                  Effect.as(true),
                  Effect.ensuring(input.release(input.turn.id, false) as Effect.Effect<void, never, any>),
                ),
          ),
        ),
    )
  })
