import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "@rika/product/turn-repository"
import { Function, Schema } from "effect"
import type { InteractiveEvent } from "./interactive-runtime-event"
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
  (error: unknown, threadId?: Thread.ThreadId): (dispatch: (event: InteractiveEvent) => void) => void
  (dispatch: (event: InteractiveEvent) => void, error: unknown, threadId?: Thread.ThreadId): void
} = Function.dual((args) => typeof args[0] === "function", dispatchInteractiveFailureImpl)
