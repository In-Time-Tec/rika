import * as Turn from "@rika/product/turn-record"
import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as ThreadSummaryRepository from "@rika/product/thread-summary-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import * as ResolvedContext from "../../context/context-resolution-service"
import * as ExecutionExtensions from "@rika/extensions/execution-extension-service"
import * as ExecutionStatus from "@rika/product/execution-status"
import { observeRootTurn, watchRootTurn } from "./root-turn-watcher"
import { Effect, Clock } from "effect"
import { OperationError } from "../operation-error"
import type * as RootTurnOwner from "../../thread/queue/root-turn-owner"
import type { InteractiveEvent } from "./interactive-runtime-event"

export const ignoreInteractiveEvent = (_event: InteractiveEvent) => {}

export interface InteractiveFollowingInput {
  readonly rootTurnOwner: RootTurnOwner.Interface
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
  readonly claimTurnObserver: (
    turnId: Turn.TurnId,
    expectedStatus?: ExecutionStatus.Status,
  ) => Effect.Effect<boolean, TurnRepository.RepositoryError, never>
  readonly releaseTurnObserver: (turnId: Turn.TurnId, notify?: boolean) => Effect.Effect<void, never, never>
}

export const makeInteractiveFollowing = (input: InteractiveFollowingInput) => {
  const { rootTurnOwner, setTurnStatus, settleThread, threadForTurn, claimTurnObserver, releaseTurnObserver } = input
  const watchClaimedTurn = Effect.fn("ProductOperation.interactive.watchClaimedTurn")(function* (
    turnId: Turn.TurnId,
    dispatch: (event: InteractiveEvent) => void,
  ) {
    const turns = (yield* TurnRepository.Service) as TurnRepository.Interface
    return yield* watchRootTurn({
      turnId,
      turns,
      owner: rootTurnOwner,
      setTurnStatus,
      settleThread,
      threadForTurn,
      dispatch,
      now: Clock.currentTimeMillis,
    })
  })
  const observeTurn = Effect.fn("ProductOperation.interactive.observeTurn")(function* (
    turn: Turn.AgentExecutionTurn,
    dispatch: (event: InteractiveEvent) => void,
  ) {
    return yield* observeRootTurn({
      turn,
      claim: claimTurnObserver,
      release: releaseTurnObserver,
      watch: watchClaimedTurn(turn.id, dispatch),
    })
  })
  return { watchClaimedTurn, observeTurn }
}
