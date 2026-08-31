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
  if (node.lifecycle === "active") context.usage.observeLifecycleAt(event)
  else context.usage.activate(node, event)
  const card = context.cardsByChild.get(node.rawRunId)
  if (card !== undefined) context.subagents.updateCard(card, "running")
}

const resume = (context: ProjectorEventContext, node: Node, event: RunEvent.RunResumed): void => {
  if (node.started) context.usage.activate(node, event)
  else {
    context.usage.observeLifecycleAt(event)
    node.lifecycle = "unknown"
  }
  node.status = "running"
  if (node.parentRawRunId === undefined) context.core.rootStatus = "running"
  if (event.resolution._tag === "Approved") context.authorization.resolveAuthorization(node, event.waitId, "approved")
  if (event.resolution._tag === "Denied") context.authorization.resolveAuthorization(node, event.waitId, "denied")
}

const fail = (context: ProjectorEventContext, node: Node, event: RunEvent.RunFailed): void => {
  context.usage.deactivate(node, event, "terminal")
  context.usage.settleOpenAttempts(node)
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
  context.usage.settleOpenAttempts(node)
  if (node.hidden) {
    node.status = "completed"
    if ("text" in event.result) context.core.title = { text: event.result.text }
  } else context.settleNode(node, "completed", event)
}

const cancel = (context: ProjectorEventContext, node: Node, event: RunEvent.RunCancelled): void => {
  context.usage.deactivate(node, event, "terminal")
  context.usage.settleOpenAttempts(node)
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
    case "RunWaiting":
      context.usage.deactivate(node, event, "waiting")
      node.status = "waiting"
      if (node.parentRawRunId === undefined) context.core.rootStatus = "waiting"
      if (event.wait.reason._tag === "Approval")
        context.authorization.putAuthorization(node, event.wait.waitId, event.wait.reason.request)
      return true
    case "RunResumed":
      resume(context, node, event)
      return true
    case "OperationUnknown":
      if (context.core.rootStatus !== "cancelling") {
        if (node.lifecycle === "active") context.usage.deactivate(node, event, "waiting")
        node.status = "waiting"
        if (node.parentRawRunId === undefined) context.core.rootStatus = "waiting"
        context.diagnostics.error(
          node,
          "operation",
          "Execution needs resolution",
          `Unknown operation ${event.operationId} in Run ${node.rawRunId}. Inspect it with rika thread recovery inspect <thread-id> ${node.rawRunId}.`,
          event.operationId,
        )
      }
      return true
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
