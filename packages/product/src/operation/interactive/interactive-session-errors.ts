import { Function } from "effect"
import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "@rika/product/turn-repository"
import { Schema } from "effect"
import type { InteractiveEvent } from "./interactive-event"
import { operationFailureDetail } from "../operation-error"

const dispatchInteractiveFailureImpl = (
  dispatch: (event: InteractiveEvent) => void,
  error: unknown,
  threadId?: Thread.ThreadId,
) =>
  Schema.is(TurnRepository.QueueFull)(error)
    ? dispatch({
        _tag: "QueueFull",
        selectionEpoch: 0,
        threadId: error.threadId,
        capacity: error.capacity,
        count: error.count,
      })
    : dispatch({
        _tag: "ExecutionFailed",
        selectionEpoch: 0,
        ...(threadId === undefined ? {} : { threadId }),
        message: operationFailureDetail(error),
      })

export const dispatchInteractiveFailure: {
  (
    arg1: unknown,
    arg2?: Thread.ThreadId,
  ): (arg0: (event: InteractiveEvent) => void) => ReturnType<typeof dispatchInteractiveFailureImpl>
  (
    arg0: (event: InteractiveEvent) => void,
    arg1: unknown,
    arg2?: Thread.ThreadId,
  ): ReturnType<typeof dispatchInteractiveFailureImpl>
} = Function.dual(3, dispatchInteractiveFailureImpl)
