import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import { Effect, Function, Schema } from "effect"
import type { InteractiveEvent } from "./interactive-runtime-event"
import { makeFailure } from "../operation-failure"

const dispatchInteractiveFailureImpl = (
  dispatch: (event: InteractiveEvent) => void,
  error: unknown,
  threadId?: Thread.ThreadId,
  turnId?: Turn.TurnId,
) => {
  if (Schema.is(TurnRepository.QueueFull)(error))
    return dispatch({
      _tag: "QueueFull",
      selectionEpoch: 0,
      threadId: error.threadId,
      capacity: error.capacity,
      count: error.count,
    })
  const failure = makeFailure(error)
  Effect.logError("interactive.failure.dispatched").pipe(
    Effect.annotateLogs({
      "rika.failure.tag": failure.tag,
      "rika.failure.actor": failure.actor,
      "rika.failure.retry": failure.retry,
      ...(threadId === undefined ? {} : { "rika.thread.id": String(threadId) }),
      ...(turnId === undefined ? {} : { "rika.turn.id": String(turnId) }),
    }),
    Effect.runSync,
  )
  return dispatch({
    _tag: "ExecutionFailed",
    selectionEpoch: 0,
    ...(threadId === undefined ? {} : { threadId }),
    ...(turnId === undefined ? {} : { turnId }),
    failure,
  })
}

export const dispatchInteractiveFailure: {
  (
    error: unknown,
    threadId?: Thread.ThreadId,
    turnId?: Turn.TurnId,
  ): (dispatch: (event: InteractiveEvent) => void) => void
  (dispatch: (event: InteractiveEvent) => void, error: unknown, threadId?: Thread.ThreadId, turnId?: Turn.TurnId): void
} = Function.dual((args) => typeof args[0] === "function", dispatchInteractiveFailureImpl)
