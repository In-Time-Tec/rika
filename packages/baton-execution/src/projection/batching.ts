import type { RunTree } from "@batonfx/runtime"
import { Effect, Schedule, Sink, Stream } from "effect"
import { cellToolName } from "./cell"

export const projectionBatchSize = 256
export const projectionBatchWindow = "25 millis"

export const flushProjectionBatch = (input: RunTree.TreeEvent): boolean => {
  const event = input.event
  switch (event._tag) {
    case "ModelPart":
      return (
        (event.part.type === "tool-params-start" || event.part.type === "tool-call") && event.part.name === cellToolName
      )
    case "ToolExecutionStarted":
    case "ToolExecutionCompleted":
      return event.call.name === cellToolName
    case "RunAccepted":
    case "RunAttemptStarted":
    case "ApprovalRequested":
    case "RunWaiting":
    case "RunResumed":
    case "OperationUnknown":
    case "ChildLinked":
    case "ChildSettled":
    case "RunCompleted":
    case "RunFailed":
    case "RunCancellationRequested":
    case "RunCancelled":
      return true
    default:
      return false
  }
}

export const batchProjectionEvents = <E, R>(events: Stream.Stream<RunTree.TreeEvent, E, R>) =>
  events.pipe(
    Stream.aggregateWithin(
      Sink.fold(
        () => [] as Array<RunTree.TreeEvent>,
        (batch) =>
          batch.length === 0 || (batch.length < projectionBatchSize && !flushProjectionBatch(batch[batch.length - 1]!)),
        (batch, event) => Effect.succeed([...batch, event]),
      ),
      Schedule.spaced(projectionBatchWindow),
    ),
  )
