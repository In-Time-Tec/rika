import type { ProjectorEventHandler } from "./projector-event-context"

const noOpTags = new Set([
  "TurnCompleted",
  "HandoffRequested",
  "HandoffCompleted",
  "HandoffRejected",
  "ModelAttemptFirstOutput",
  "ModelRetryScheduled",
  "ModelFallbackScheduled",
  "FanOutAdmitted",
  "FanOutJoined",
  "ChildReadinessChanged",
  // These facts accompany RunWaiting/RunResumed or describe execution metadata,
  // without adding transcript content or changing the Run lifecycle themselves.
  "Awaiting",
  "Duplicate",
  "TimedOut",
  "WakeReceived",
  "BudgetExtended",
  "Rewarded",
])

const handleExecutionNotice: ProjectorEventHandler = (context, treeEvent, node) => {
  const event = treeEvent.event
  switch (event._tag) {
    case "GateResult":
      if (event.verdict === "fail")
        context.diagnostics.notice(node, "completion-gate", "Completion check failed", event.name, event.eventId)
      return true
    case "BudgetSuspended":
      context.usage.deactivate(node, event, "waiting")
      node.status = "waiting"
      if (node.parentRawRunId === undefined) context.core.rootStatus = "waiting"
      context.diagnostics.notice(
        node,
        "budget",
        "Execution budget reached",
        `Waiting for an increase to the ${event.budget} budget.`,
        event.eventId,
      )
      return true
    case "Substituted":
      context.diagnostics.notice(
        node,
        "operation",
        "Operation result replaced",
        `The fork uses a supplied result for operation ${event.operationId}.`,
        event.eventId,
      )
      return true
    default:
      return false
  }
}

const handleSteeringNoopEvent: ProjectorEventHandler = (context, treeEvent, node) => {
  const event = treeEvent.event
  switch (event._tag) {
    case "Inbox":
      context.steering.accept(treeEvent.runId, {
        entryId: event.entryId,
        idempotencyKey: event.idempotencyKey,
        prompt: event.message,
        steeringSequence: event.inboxSequence,
      })
      return true
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

export const SteeringNoopEvents = {
  handle: (context, event, node) =>
    handleExecutionNotice(context, event, node) || handleSteeringNoopEvent(context, event, node),
} satisfies {
  readonly handle: ProjectorEventHandler
}
