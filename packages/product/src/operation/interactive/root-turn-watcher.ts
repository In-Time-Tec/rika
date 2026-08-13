import { Clock, Effect } from "effect"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as ExecutionStatus from "@rika/product/execution-status"
import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as ThreadSummaryRepository from "@rika/product/thread-summary-repository"
import * as Turn from "@rika/product/turn-record"
import * as ThreadResult from "@rika/product/thread-result"
import * as TurnRepository from "@rika/product/turn-repository"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as ResolvedContext from "../../context/context-resolution-service"
import * as ExecutionExtensions from "@rika/extensions/execution-extension-service"
import type * as RootTurnOwner from "../../thread/queue/root-turn-owner"
import { isTerminalStatus } from "../../execution/contract/execution-status"
import { OperationError, operationError } from "../operation-error"
import type { InteractiveEvent } from "./interactive-runtime-event"

export const watchRootTurn = (input: {
  readonly turnId: Turn.TurnId
  readonly turns: TurnRepository.Interface
  readonly owner: RootTurnOwner.Interface
  readonly setTurnStatus: (
    id: Turn.TurnId,
    status: ExecutionStatus.Status,
    now: number,
    responseArrived?: boolean,
  ) => Effect.Effect<
    Turn.Turn,
    OperationError | ThreadSummaryRepository.RepositoryError | TurnRepository.RepositoryError,
    ThreadSummaryRepository.Service | TurnRepository.Service
  >
  readonly settleThread: (
    thread: Thread.Thread,
    dispatch: (event: InteractiveEvent) => void,
  ) => Effect.Effect<
    void,
    never,
    | ResolvedContext.Service
    | ThreadRepository.Service
    | TurnRepository.Service
    | ThreadSummaryRepository.Service
    | ExecutionExtensions.ExecutionExtensionService
  >
  readonly threadForTurn: (
    turn: Turn.Turn,
  ) => Effect.Effect<Thread.Thread, OperationError | ThreadRepository.RepositoryError, never>
  readonly dispatch: (event: InteractiveEvent) => void
  readonly now: Effect.Effect<number>
}) =>
  Effect.gen(function* () {
    const turn = yield* input.turns.get(input.turnId)
    if (turn === undefined) return yield* operationError(`Turn ${input.turnId} does not exist`)
    if (!ThreadResult.TurnResult.isAgentExecution(turn))
      return yield* operationError(`Recorded shell turn ${input.turnId} cannot be watched as an execution`)
    const thread = yield* input.threadForTurn(turn)
    const clock = yield* Clock.Clock
    const publishChange = (change: ExecutionProjection.Change) => {
      input.dispatch({
        _tag: "ExecutionProjectionChanged",
        threadId: turn.threadId,
        turn: { ...turn, status: change.state.status, updatedAt: clock.currentTimeMillisUnsafe() },
        change,
      })
    }
    const publishPreview = (preview: ExecutionGateway.ModelPreviewEvent) => {
      input.dispatch({
        _tag: "ExecutionModelPreviewChanged",
        threadId: turn.threadId,
        turnId: turn.id,
        preview,
      })
    }
    const result = yield* input.owner.watchTurn(turn.id, publishChange, publishPreview)
    if (turn.status !== result.status) yield* input.setTurnStatus(turn.id, result.status, yield* input.now)
    if (isTerminalStatus(result.status)) yield* input.settleThread(thread, input.dispatch)
  })

export const observeRootTurn = (input: {
  readonly turn: Turn.AgentExecutionTurn
  readonly claim: (
    turnId: Turn.TurnId,
    expectedStatus?: ExecutionStatus.Status,
  ) => Effect.Effect<boolean, TurnRepository.RepositoryError, never>
  readonly release: (turnId: Turn.TurnId, notify?: boolean) => Effect.Effect<void, OperationError, never>
  readonly watch: Effect.Effect<
    void,
    | OperationError
    | ExecutionGateway.WatchTurnFailure
    | TurnRepository.RepositoryError
    | TranscriptRepository.RepositoryError
    | ThreadSummaryRepository.RepositoryError
    | ThreadRepository.RepositoryError,
    | ExecutionGateway.Service
    | TurnRepository.Service
    | ThreadSummaryRepository.Service
    | ResolvedContext.Service
    | ThreadRepository.Service
    | ExecutionExtensions.ExecutionExtensionService
  >
}) =>
  input.turn.executionLink === undefined
    ? Effect.succeed(false)
    : Effect.uninterruptibleMask((restore) =>
        input
          .claim(input.turn.id, isTerminalStatus(input.turn.status) ? input.turn.status : undefined)
          .pipe(
            Effect.flatMap((claimed) =>
              !claimed
                ? Effect.succeed(false)
                : restore(input.watch).pipe(
                    Effect.as(true),
                    Effect.ensuring(input.release(input.turn.id, false).pipe(Effect.ignore)),
                  ),
            ),
          ),
      )
