import type { Block } from "../schema/transcript-presentation-model"
import type { SourceEvent } from "../schema/transcript-source-event"
import { identityKey } from "../ordering/transcript-unit-identity"

const text = (value: unknown): string => (typeof value === "string" ? value : "")

const genericBlock = ({
  turnId,
  event,
}: {
  readonly turnId: string
  readonly event: SourceEvent
}): Block | undefined => {
  const data = event.data ?? {}
  if (event.type === "agent.compaction.started")
    return { _tag: "Compaction", summary: event.text ?? "", status: "running" }
  if (event.type === "agent.compaction.completed")
    return {
      _tag: "Compaction",
      summary: event.text ?? "",
      status: "complete",
      ...(text(data.checkpoint).length === 0 ? {} : { checkpoint: text(data.checkpoint) }),
    }
  if (event.type === "agent.compaction.failed")
    return { _tag: "Compaction", summary: event.text ?? "", status: "failed" }
  if (event.type === "model.retry.scheduled")
    return {
      _tag: "Notification",
      title: "Retrying model response",
      detail: `${text(data.category)}${typeof data.delay_millis === "number" ? ` after ${data.delay_millis} ms` : ""}`,
    }
  if (event.type === "fan_out.admitted")
    return {
      _tag: "Notification",
      title: "Running child executions",
      detail: `${typeof data.member_count === "number" ? data.member_count : 0} admitted, up to ${typeof data.concurrency === "number" ? data.concurrency : 0} at once`,
    }
  if (event.type === "fan_out.joined")
    return {
      _tag: "Notification",
      title: data.status === "succeeded" ? "Child executions completed" : "Child executions settled",
      detail: `${typeof data.succeeded === "number" ? data.succeeded : 0} succeeded, ${typeof data.failed === "number" ? data.failed : 0} failed, ${typeof data.cancelled === "number" ? data.cancelled : 0} cancelled, ${typeof data.abandoned === "number" ? data.abandoned : 0} abandoned`,
    }
  if (event.type === "program.log") {
    if (data.level === "debug") return undefined
    if (data.level === "error")
      return { _tag: "Error", title: text(data.operation) || "Program", detail: event.text ?? "", turnId }
    return {
      _tag: "Notification",
      title: text(data.operation) || (data.level === "warn" ? "Program warning" : "Program"),
      detail: event.text ?? "",
    }
  }
  if (event.type === "program.operation.failed")
    return { _tag: "Error", title: "Program operation failed", detail: event.text ?? "", turnId }
  return undefined
}

const genericKey = ({
  turnId,
  event,
  block,
}: {
  readonly turnId: string
  readonly event: SourceEvent
  readonly block: Block
}): string => {
  if (block._tag === "Compaction") return identityKey("compaction", turnId)
  if (event.type === "fan_out.admitted" || event.type === "fan_out.joined")
    return identityKey("fan-out", turnId, text(event.data?.fan_out_id))
  return identityKey("event", turnId, event.sequence, event.type)
}

export { genericBlock, genericKey }
