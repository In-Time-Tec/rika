import * as Projection from "@rika/product/execution-projection"
import type { Unit } from "@rika/product/execution-transcript-contract"
import type { ModelCallState } from "../model"
import { boundedInsert } from "./nodes"
import type { ProjectorEventHandler } from "./projector-event-context"

const startCall = (
  context: Parameters<ProjectorEventHandler>[0],
  node: Parameters<ProjectorEventHandler>[2],
  event: Extract<Parameters<ProjectorEventHandler>[1]["event"], { _tag: "ModelCallStarted" }>,
): void => {
  const { usage } = context
  const key = `${node.rawRunId}\u0000${event.modelCallId}`
  const rootConversation = node.parentRawRunId === undefined && !node.hidden && event.purpose === "conversation"
  const existing = usage.modelCalls.get(key)
  if (existing !== undefined) {
    if (existing.purpose !== event.purpose)
      throw new TypeError(`Conflicting Generalist model call: ${event.modelCallId}`)
    return
  }
  const value: ModelCallState = rootConversation
    ? { purpose: event.purpose, requestOrdinal: usage.requestOrdinal() + 1 }
    : { purpose: event.purpose }
  if (boundedInsert(usage.modelCalls, key, value, Projection.limits.modelCalls, "model calls") && rootConversation)
    usage.awaitContext(usage.nextRequestOrdinal())
}

const handleModelEvent: ProjectorEventHandler = (context, treeEvent, node) => {
  const event = treeEvent.event
  switch (event._tag) {
    case "ModelCallStarted":
      startCall(context, node, event)
      return true
    case "ModelCallCompleted":
      settleCall(context, node.rawRunId, event.modelCallId)
      return true
    case "ModelAttemptStarted":
    case "ModelAttemptCompleted":
    case "ModelAttemptFailed":
      return true
    case "ModelCallFailed":
      settleCall(context, node.rawRunId, event.modelCallId)
      context.diagnostics.modelFailureError(node, event.modelCallId, event.category, event.classification)
      return true
    default:
      return false
  }
}

const handleCompactionEvent: ProjectorEventHandler = (context, treeEvent, node) => {
  const event = treeEvent.event
  switch (event._tag) {
    case "CompactionStarted":
      putCompaction(context, node, event.compactionId, "running")
      return true
    case "CompactionSkipped":
    case "CompactionApplied":
      completeCompaction(context, node, event)
      return true
    case "CompactionFailed":
      putCompaction(context, node, event.compactionId, "failed")
      return true
    default:
      return false
  }
}

const handleModelUsageCompactionEvent: ProjectorEventHandler = (context, treeEvent, node) =>
  handleModelEvent(context, treeEvent, node) || handleCompactionEvent(context, treeEvent, node)

const settleCall = (context: Parameters<ProjectorEventHandler>[0], runId: string, modelCallId: string): void => {
  const key = `${runId}\u0000${modelCallId}`
  const call = context.usage.modelCalls.get(key)
  if (call?.requestOrdinal === context.usage.pendingContextOrdinal()) context.usage.awaitContext(undefined)
  context.usage.modelCalls.delete(key)
}

const putCompaction = (
  context: Parameters<ProjectorEventHandler>[0],
  node: Parameters<ProjectorEventHandler>[2],
  id: string,
  status: "running" | "failed",
): void => {
  const key = context.localId("compaction", node.publicId, id)
  context.put(context.unit(node, key, { _tag: "Block", block: { _tag: "Compaction", summary: "", status } }))
}

const completeCompaction = (
  context: Parameters<ProjectorEventHandler>[0],
  node: Parameters<ProjectorEventHandler>[2],
  event: Extract<Parameters<ProjectorEventHandler>[1]["event"], { _tag: "CompactionSkipped" | "CompactionApplied" }>,
): void => {
  const key = context.localId("compaction", node.publicId, event.compactionId)
  const current = context.units.get(key)
  const previous =
    current?.content._tag === "Block" && current.content.block._tag === "Compaction" ? current.content.block : undefined
  const block: Extract<Unit["content"], { readonly _tag: "Block" }>["block"] =
    event._tag === "CompactionApplied"
      ? { _tag: "Compaction", checkpoint: event.checkpointId, status: "complete", summary: previous?.summary ?? "" }
      : { _tag: "Compaction", status: "complete", summary: previous?.summary ?? "" }
  context.put(context.unit(node, key, { _tag: "Block", block }))
}

export const ModelUsageCompactionEvents = { handle: handleModelUsageCompactionEvent } satisfies {
  readonly handle: ProjectorEventHandler
}
