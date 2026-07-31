import type { Block } from "../schema/transcript-presentation-model"
import type { SourceEvent } from "../schema/transcript-source-event"
import { toolBlock } from "./transcript-tool-event-fold"
import { foldState } from "./transcript-fold-state"
const { encodeInput, sourcePayload, string } = foldState
import { identityKey, scopedIdentity } from "../ordering/transcript-unit-identity"

const genericBlock = (turnId: string, event: SourceEvent): Block | undefined => {
  const value = sourcePayload(event)
  if (event.type.startsWith("permission.ask.") || event.type.startsWith("tool.approval.")) return undefined
  if (event.type.includes("diff"))
    return { _tag: "Diff", path: string(value.path, "diff"), patch: event.text ?? string(value.patch ?? value.diff) }
  if (event.type === "agent.compaction.started")
    return { _tag: "Compaction", summary: event.text ?? string(value.summary), status: "running" }
  if (event.type === "agent.compaction.completed")
    return {
      _tag: "Compaction",
      summary: event.text ?? string(value.summary),
      status: "complete",
    }
  if (event.type === "agent.compaction.committed")
    return {
      _tag: "Compaction",
      summary: event.text ?? string(value.summary),
      status: "complete",
      ...(string(value.checkpoint ?? value.checkpoint_id).length === 0
        ? {}
        : { checkpoint: string(value.checkpoint ?? value.checkpoint_id) }),
    }
  if (event.type === "agent.compaction.failed")
    return {
      _tag: "Compaction",
      summary: event.text ?? string(value.summary ?? value.message),
      status: "failed",
    }
  if (event.type.includes("notification"))
    return {
      _tag: "Notification",
      title: string(value.title ?? value.name, "Notification"),
      detail: event.text ?? string(value.detail ?? value.message),
    }
  if (event.type.includes("image") && event.type.includes("attachment"))
    return {
      _tag: "ImageAttachment",
      name: string(value.name ?? value.filename, "image"),
      mediaType: string(value.media_type ?? value.mediaType, "application/octet-stream"),
      ...(typeof value.width === "number" ? { width: value.width } : {}),
      ...(typeof value.height === "number" ? { height: value.height } : {}),
      ...(typeof value.bytes === "number" ? { bytes: value.bytes } : {}),
    }
  if (event.type.includes("workflow")) {
    let status: Extract<Block, { _tag: "Workflow" }>["status"] = "running"
    if (event.type.includes("failed")) status = "failed"
    else if (event.type.includes("completed")) status = "complete"
    else if (event.type.includes("wait")) status = "waiting"
    return {
      _tag: "Workflow",
      name: string(value.workflow ?? value.name, "workflow"),
      step: event.text ?? string(value.step ?? value.status),
      status,
    }
  }
  if (event.type.includes("error") || event.type.includes("failed") || event.type === "budget.exceeded")
    return {
      _tag: "Error",
      title: string(value.title, event.type === "budget.exceeded" ? "Budget exceeded" : "Error"),
      detail: event.text ?? string(value.message ?? value.error, event.type),
      turnId,
      ...(string(value.recovery).length === 0 ? {} : { recovery: string(value.recovery) }),
    }
  if (event.type.includes("tool") && (event.type.includes("result") || event.type.includes("completed")))
    return {
      _tag: "ToolResult",
      id: scopedIdentity(turnId, string(value.callId ?? value.call_id ?? value.id, event.cursor)),
      output: event.text ?? string(value.output ?? value.result),
      failed: event.type.includes("failed") || value.failed === true,
    }
  if (event.type.includes("tool")) {
    const id = scopedIdentity(turnId, string(value.callId ?? value.call_id ?? value.id, event.cursor))
    const name = string(value.name ?? value.tool, "tool")
    const input = encodeInput(value.input ?? value)
    return toolBlock(id, name, input)
  }
  return undefined
}

const genericKey = (turnId: string, event: SourceEvent, block: Block): string => {
  const value = sourcePayload(event)
  switch (block._tag) {
    case "Diff":
      return identityKey("diff", turnId, block.path)
    case "Compaction":
      return identityKey("compaction", turnId)
    case "ChildAgent":
      return identityKey("child", turnId, block.id)
    case "Workflow": {
      const id = string(value.run_id ?? value.runId ?? value.workflow_id)
      return identityKey("workflow", turnId, id.length === 0 ? event.cursor : id)
    }
    case "ImageAttachment":
      return identityKey("image", turnId, string(value.id, event.cursor))
    case "Notification":
      return identityKey("notification", turnId, string(value.id, event.cursor))
    case "Error":
      return identityKey("error", turnId, string(value.id, event.cursor))
    default: {
      const id = "id" in block && typeof block.id === "string" ? block.id : `${event.sequence}:${event.type}`
      return identityKey("event", turnId, id)
    }
  }
}

export { genericBlock, genericKey }
