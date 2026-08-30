import type { ProjectorEventHandler } from "./projector-event-context"

const noOpTags = new Set([
  "TurnCompleted",
  "StructuredOutput",
  "HandoffRequested",
  "HandoffCompleted",
  "HandoffRejected",
  "ModelAttemptFirstOutput",
  "ModelRetryScheduled",
  "ModelFallbackScheduled",
  "FanOutAdmitted",
  "FanOutJoined",
  "ChildReadinessChanged",
])

const handleSteeringNoopEvent: ProjectorEventHandler = (context, treeEvent, node) => {
  const event = treeEvent.event
  switch (event._tag) {
    case "SteeringAccepted":
      context.steering.accept(treeEvent.runId, event)
      return true
    case "SteeringConsumed":
      context.steering.consume(treeEvent.runId, event, node)
      return true
    case "SteeringDiscarded":
      context.steering.discard(treeEvent.runId, event)
      return true
    case "SteeringDrained":
      if (event.queue === "steering") context.core.steeringMessages += event.count
      else context.core.followUpMessages += event.count
      return true
    case "TurnStarted":
      node.phase += 1
      return true
    case "ProgramLog":
      if (event.level === "error")
        context.diagnostics.error(node, "program-log", event.operation, event.message, event.eventId)
      else if (event.level === "warn")
        context.diagnostics.notice(node, "program-log", event.operation, event.message, event.eventId)
      return true
    default:
      return noOpTags.has(event._tag)
  }
}

export const SteeringNoopEvents = { handle: handleSteeringNoopEvent } satisfies {
  readonly handle: ProjectorEventHandler
}
