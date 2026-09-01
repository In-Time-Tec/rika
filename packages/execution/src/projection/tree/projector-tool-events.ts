import { Option, Schema } from "effect"
import { completeTool } from "../tool/state"
import * as SubagentCard from "../subagent/card"
import { encoded } from "../decoding"
import { optionalString, projectorNames, record, string } from "../values"
import type { Node } from "../model"
import type { SemanticTreeEvent } from "../semantic/event"
import type { ProjectorEventContext, ProjectorEventHandler } from "./projector-event-context"
import { subagentCardStatus } from "./nodes"

const toolStarted = (context: ProjectorEventContext, treeEvent: SemanticTreeEvent, node: Node): void => {
  const event = treeEvent.event
  if (event._tag !== "ToolExecutionStarted") return
  if (event.call.name === projectorNames.runChild) {
    const input = record(event.call.params)
    context.subagents.cardFor(
      node,
      event.call.id,
      string(input.selection, "Subagent"),
      optionalString(input.prompt),
      optionalString(input.label) || undefined,
    )
    context.remove(context.tools.toolState(node, event.call.id).key)
  } else if (event.call.name === projectorNames.runChildGroup) {
    const params = Schema.decodeUnknownOption(SubagentCard.SubagentGroupParams)(event.call.params)
    if (Option.isSome(params)) context.subagents.groupCards(node, event.call.id, params.value)
    context.remove(context.tools.toolState(node, event.call.id).key)
  } else if (event.call.name === "shell_command_status") {
    context.tools.linkProcessCheck(node, event.call.id, encoded(event.call.params), true)
  } else context.tools.putTool(node, event.call.id, event.call.name, encoded(event.call.params), undefined, true)
}

const toolCompleted = (context: ProjectorEventContext, treeEvent: SemanticTreeEvent, node: Node): void => {
  const event = treeEvent.event
  if (event._tag !== "ToolExecutionCompleted") return
  if (event.call.name === projectorNames.runChild) {
    const card = context.cardsByInvocation.get(`${node.rawRunId}\u0000${event.call.id}`)
    const result = record(event.result.result)
    if (card !== undefined && optionalString(result._tag) !== "Succeeded")
      context.subagents.updateCard(
        card,
        optionalString(result._tag) === "Cancelled" ? "cancelled" : "failed",
        optionalString(result.message ?? result.reason),
      )
  } else if (event.call.name === projectorNames.runChildGroup) {
    completeGroup(context, event, node)
  } else
    context.tools.updateTool(
      node,
      event.call.id,
      (tool) => completeTool(tool, event.result.result, event.result.isFailure),
      false,
    )
}

const completeGroup = (
  context: ProjectorEventContext,
  event: Extract<SemanticTreeEvent["event"], { _tag: "ToolExecutionCompleted" }>,
  node: Node,
): void => {
  const params = Schema.decodeUnknownOption(SubagentCard.SubagentGroupParams)(event.call.params)
  if (event.result.isFailure && Option.isSome(params)) {
    const detail = optionalString(record(event.result.result).message)
    for (const card of context.subagents.groupCards(node, event.call.id, params.value))
      if (card.rawChildRunId === undefined) context.subagents.updateCard(card, "failed", detail)
  }
  const result = Schema.decodeUnknownOption(SubagentCard.SubagentGroupResult)(event.result.result)
  context.subagents.settleGroup(
    node,
    event.call.id,
    Option.isSome(result) ? result.value : undefined,
    event.result.isFailure,
  )
}

const handleToolSubagentEvent: ProjectorEventHandler = (context, treeEvent, node) => {
  const event = treeEvent.event
  switch (event._tag) {
    case "ModelResponseCommitted":
    case "ModelResponseInterrupted":
      context.semanticResponse.apply(node, event)
      return true
    case "ToolExecutionStarted":
      toolStarted(context, treeEvent, node)
      return true
    case "ToolProgress":
      context.tools.updateTool(node, event.toolCallId, (tool) =>
        event.message === undefined
          ? tool
          : { ...tool, result: `${Schema.is(Schema.String)(tool.result) ? `${tool.result}\n` : ""}${event.message}` },
      )
      return true
    case "ToolExecutionWaiting":
      return true
    case "ToolExecutionCompleted":
      toolCompleted(context, treeEvent, node)
      return true
    case "ApprovalRequested":
      context.authorization.putAuthorization(node, event.request.approvalId, event.request)
      return true
    case "ChildLinked":
      context.subagents.bindChild(node, event.childRunId, event)
      return true
    case "ChildSettled": {
      const card = context.cardsByChild.get(event.childRunId)
      const child = context.nodes.get(event.childRunId)
      if (card !== undefined && child !== undefined)
        context.subagents.updateCard(card, subagentCardStatus(child.status))
      return true
    }
    default:
      return false
  }
}

export const ToolSubagentEvents = { handle: handleToolSubagentEvent } satisfies {
  readonly handle: ProjectorEventHandler
}
