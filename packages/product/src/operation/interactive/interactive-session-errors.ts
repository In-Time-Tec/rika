import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "@rika/product/turn-repository"
import { Schema } from "effect"
import type { InteractiveEvent } from "./interactive-event"
import { operationFailureDetail } from "../operation-error"

export const dispatchInteractiveFailure = (
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
