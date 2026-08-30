import { Option, Schema } from "effect"
import { completeTool } from "../tool/state"
import * as Cell from "../cell/state"
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
  if (event.call.name === Cell.cellToolName) {
    context.cells.openCell(node, event.call.id, string(record(event.call.params).code, ""))
  } else if (event.call.name === projectorNames.runChild) {
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
  } else context.tools.putTool(node, event.call.id, event.call.name, encoded(event.call.params))
}

const toolCompleted = (context: ProjectorEventContext, treeEvent: SemanticTreeEvent, node: Node): void => {
  const event = treeEvent.event
  if (event._tag !== "ToolExecutionCompleted") return
  if (event.call.name === Cell.cellToolName) {
    const key = `${treeEvent.runId}\u0000${event.call.id}`
    const formatted = context.formattedCellSources.get(key)
    if (formatted !== undefined) {
      context.formattedCellSources.delete(key)
      context.cells.openCell(node, event.call.id, formatted)
    }
    context.cells.completeCell(node, event.call.id, event.result.result, event.result.isFailure)
  } else if (event.call.name === projectorNames.runChild) {
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
    context.tools.updateTool(node, event.call.id, (tool) =>
      completeTool(tool, event.result.result, event.result.isFailure),
    )
}

const completeGroup = (
  context: ProjectorEventContext,
  event: Extract<SemanticTreeEvent["event"], { _tag: "ToolExecutionCompleted" }>,
  node: Node,
): void => {
  if (!event.result.isFailure) return
  const detail = optionalString(record(event.result.result).message)
  const params = Schema.decodeUnknownOption(SubagentCard.SubagentGroupParams)(event.call.params)
  if (Option.isSome(params))
    for (const card of context.subagents.groupCards(node, event.call.id, params.value))
      if (card.rawChildRunId === undefined) context.subagents.updateCard(card, "failed", detail)
}

const handleToolCellSubagentEvent: ProjectorEventHandler = (context, treeEvent, node) => {
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
      if (node.cells.has(event.toolCallId)) context.cells.progressCell(node, event.toolCallId, event.data)
      else
        context.tools.updateTool(node, event.toolCallId, (tool) =>
          event.message === undefined
            ? tool
            : { ...tool, result: `${Schema.is(Schema.String)(tool.result) ? `${tool.result}\n` : ""}${event.message}` },
        )
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

export const ToolCellSubagentEvents = { handle: handleToolCellSubagentEvent } satisfies {
  readonly handle: ProjectorEventHandler
}
