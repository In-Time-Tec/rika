import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import * as ExecutionBackend from "@rika/product/execution-service"
import { followChildRun, observeChildRun } from "./child-run-follower"
import { Effect, Clock } from "effect"
import type { InteractiveEvent } from "./interactive-event"

export const ignoreInteractiveEvent = (_event: InteractiveEvent) => {}

export const makeInteractiveFollowing = (input: any): any => {
  const {
    rootTurnOwner,
    ensureIngest,
    deliverResultEvents,
    setTurnStatus,
    projectExecutionResult,
    settleThread,
    threadForTurn,
    titleThread,
    claimTurnObserver,
    releaseTurnObserver,
    emit,
  } = input
  const followClaimedTurn = Effect.fn("ProductOperation.interactive.followClaimedTurn")(function* (
    turnId: Turn.TurnId,
    dispatch: (event: InteractiveEvent) => void,
  ) {
    const turns = (yield* TurnRepository.Service) as TurnRepository.Interface
    const backend = yield* ExecutionBackend.Service
    return yield* followChildRun({
      turnId,
      turns,
      backend,
      owner: rootTurnOwner,
      ensureIngest,
      deliverResultEvents,
      setTurnStatus,
      projectExecutionResult,
      settleThread,
      threadForTurn,
      titleThread,
      dispatch,
      emit,
      now: Clock.currentTimeMillis,
    })
  })
  const observeTurn = Effect.fn("ProductOperation.interactive.observeTurn")(function* (
    turn: Turn.AgentExecutionTurn,
    dispatch: (event: InteractiveEvent) => void,
  ) {
    const backend = yield* ExecutionBackend.Service
    return yield* observeChildRun({
      turn,
      backend,
      claim: claimTurnObserver,
      release: releaseTurnObserver,
      follow: followClaimedTurn(turn.id, dispatch),
    })
  })
  return { followClaimedTurn, observeTurn }
}
