import type { RunEvent } from "generalist/runtime"
import type { Node } from "../model"
import type { ProjectorEventContext, ProjectorEventHandler } from "./projector-event-context"

const startAttempt = (context: ProjectorEventContext, node: Node, event: RunEvent.RunAttemptStarted): void => {
  if (node.attempt !== undefined && event.attempt < node.attempt)
    throw new TypeError(`Generalist Run ${node.rawRunId} attempt regressed`)
  if (node.attempt === event.attempt) {
    context.usage.observeLifecycleAt(event)
    return
  }
  node.started = true
  node.attempt = event.attempt
  node.needsResolution = false
  if (node.lifecycle === "active") context.usage.observeLifecycleAt(event)
  else context.usage.activate(node, event)
  const card = context.cardsByChild.get(node.rawRunId)
  if (card !== undefined) context.subagents.updateCard(card, "running")
}

const resume = (context: ProjectorEventContext, node: Node, event: RunEvent.RunResumed): void => {
  node.needsResolution = false
  if (node.started) context.usage.activate(node, event)
  else {
    context.usage.observeLifecycleAt(event)
    node.lifecycle = "unknown"
  }
  node.status = "running"
  const card = context.cardsByChild.get(node.rawRunId)
  if (card !== undefined) context.subagents.updateCard(card, "running")
  if (node.parentRawRunId === undefined) context.core.rootStatus = "running"
  if (event.resolution._tag === "Approved") context.authorization.resolveAuthorization(node, event.waitId, "approved")
  if (event.resolution._tag === "Denied") context.authorization.resolveAuthorization(node, event.waitId, "denied")
}

const fail = (context: ProjectorEventContext, node: Node, event: RunEvent.RunFailed): void => {
  context.usage.deactivate(node, event, "terminal")
  context.usage.settleCalls(node)
  context.authorization.settleAuthorizations(node, "expired")
  if (node.hidden) {
    node.status = "failed"
    return
  }
  const failure: Parameters<ProjectorEventContext["diagnostics"]["executionFailureError"]>[2] =
    event.error.message.length === 0 ? { status: "failed" } : { reason: event.error.message, status: "failed" }
  context.diagnostics.executionFailureError(node, event.error.message, failure)
  context.settleNode(node, "failed", event, event.error.message)
}

const complete = (context: ProjectorEventContext, node: Node, event: RunEvent.RunCompleted): void => {
  context.usage.deactivate(node, event, "terminal")
  context.usage.settleCalls(node)
  if (node.hidden) {
    node.status = "completed"
    if ("text" in event.result) context.core.title = { text: event.result.text }
  } else context.settleNode(node, "completed", event)
}

const cancel = (context: ProjectorEventContext, node: Node, event: RunEvent.RunCancelled): void => {
  context.usage.deactivate(node, event, "terminal")
  context.usage.settleCalls(node)
  context.authorization.settleAuthorizations(node, "cancelled")
  if (node.hidden) node.status = "cancelled"
  else context.settleNode(node, "cancelled", event, event.reason)
}

const handleRunProgressEvent: ProjectorEventHandler = (context, treeEvent, node) => {
  const event = treeEvent.event
  switch (event._tag) {
    case "RunAccepted":
      context.usage.observeLifecycleAt(event)
      if (node.lifecycle === "unknown") node.lifecycle = "accepted"
      return true
    case "RunAttemptStarted":
      startAttempt(context, node, event)
      return true
    case "RunWaiting": {
      context.usage.deactivate(node, event, "waiting")
      node.status = "waiting"
      const waitingCard = context.cardsByChild.get(node.rawRunId)
      if (waitingCard !== undefined) context.subagents.updateCard(waitingCard, "waiting")
      if (node.parentRawRunId === undefined) context.core.rootStatus = "waiting"
      if (event.wait.reason._tag === "Approval")
        context.authorization.putAuthorization(node, event.wait.waitId, event.wait.reason.request)
      return true
    }
    case "RunResumed":
      resume(context, node, event)
      return true
    case "OperationUnknown": {
      // Generalist supplies no tool-call identity here. Do not attach this operation to a guessed tool.
      if (context.core.rootStatus !== "cancelling") {
        node.needsResolution = true
        if (node.lifecycle === "active") context.usage.deactivate(node, event, "waiting")
        node.status = "waiting"
        if (node.parentRawRunId === undefined) context.core.rootStatus = "waiting"
        context.diagnostics.notice(
          node,
          "operation",
          "Waiting for operation recovery",
          [
            `Run: ${node.rawRunId}; operation: ${event.operationId}.`,
            "Execution paused because the outcome is unknown. The operation may already have taken effect; reconnecting does not retry it.",
            "Generalist cannot expose operation details, replay policy, or the result schema. Do not guess the outcome.",
            "In another terminal, replace <thread-id> with this Thread's ID and <run-id>/<operation-id> with the IDs above:",
            "rika thread recovery inspect <thread-id> <run-id>",
            "Authorized operators can explicitly resolve the operation:",
            'rika thread recovery abort <thread-id> <run-id> <operation-id> "reason"',
            "Abort records failure; it does not undo side effects. To stop the whole Turn, use Ctrl+C in the active TUI.",
            "Retry can repeat side effects; even shell_command_status consumes buffered output. Only retry after checking what happened:",
            "rika thread recovery retry <thread-id> <run-id> <operation-id>",
            "Accept requires a known correct result, not a guessed value:",
            "rika thread recovery accept <thread-id> <run-id> <operation-id> '<json-value>'",
          ].join("\n"),
          event.operationId,
        )
      }
      return true
    }
    default:
      return false
  }
}

const handleRunSettlementEvent: ProjectorEventHandler = (context, treeEvent, node) => {
  const event = treeEvent.event
  switch (event._tag) {
    case "RunCompleted":
      complete(context, node, event)
      return true
    case "RunFailed":
      fail(context, node, event)
      return true
    case "RunCancellationRequested": {
      const card = context.cardsByChild.get(node.rawRunId)
      if (card !== undefined) context.subagents.updateCard(card, "cancelling")
      if (node.parentRawRunId === undefined) context.core.rootStatus = "cancelling"
      return true
    }
    case "RunCancelled":
      cancel(context, node, event)
      return true
    default:
      return false
  }
}

const handleRunLifecycleEvent: ProjectorEventHandler = (context, treeEvent, node) =>
  handleRunProgressEvent(context, treeEvent, node) || handleRunSettlementEvent(context, treeEvent, node)

export const RunLifecycleEvents = { handle: handleRunLifecycleEvent } satisfies {
  readonly handle: ProjectorEventHandler
}
