import type { Event } from "@rika/product/execution-event"
import { Status } from "@rika/product/execution-status"

const scrubbedEventMessage = (data: Readonly<Record<string, unknown>> | undefined): string | undefined => {
  const message = data?.message
  return typeof message === "string" && message.length > 0 && message !== "[object Object]" ? message : undefined
}

const overflowDetail = (data: Readonly<Record<string, unknown>> | undefined): string | undefined => {
  const details =
    typeof data?.details === "object" && data.details !== null
      ? (data.details as Readonly<Record<string, unknown>>)
      : undefined
  return details?.failure_classification === "context-overflow"
    ? "Automatic compaction could not reduce the thread enough for this model."
    : undefined
}

export const failureMessage = (data: Readonly<Record<string, unknown>> | undefined): string | undefined => {
  const scrubbed = scrubbedEventMessage(data)
  if (scrubbed !== undefined) return scrubbed
  const overflow = overflowDetail(data)
  if (overflow !== undefined) return overflow
  return data?.message === "[object Object]" ? "The execution failed unexpectedly." : undefined
}

export const event = (value: {
  readonly execution_id: string
  readonly child_execution_id?: string | undefined
  readonly cursor: string
  readonly sequence: number
  readonly type: string
  readonly created_at: number
  readonly timestamp_source?: string | undefined
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string | undefined }> | undefined
  readonly data?: Readonly<Record<string, unknown>> | undefined
}): Event => {
  const contentText = value.content
    ?.filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("")
  let text: string | undefined
  if (contentText !== undefined && contentText.length > 0) text = contentText
  else if (value.type === "execution.failed") text = failureMessage(value.data)
  return {
    executionId: value.execution_id,
    ...(value.child_execution_id === undefined ? {} : { childExecutionId: value.child_execution_id }),
    cursor: value.cursor,
    sequence: value.sequence,
    type: value.type,
    createdAt: value.created_at,
    ...(value.timestamp_source === undefined ? {} : { timestampSource: value.timestamp_source }),
    ...(text === undefined ? {} : { text }),
    ...(value.content === undefined ? {} : { content: [...value.content] }),
    ...(value.data === undefined ? {} : { data: value.data }),
  }
}

export const statusFromEvents = (events: ReadonlyArray<Event>): Status => {
  const type = events.findLast(
    (item) =>
      item.type === "execution.completed" || item.type === "execution.failed" || item.type === "execution.cancelled",
  )?.type
  if (type === "execution.completed") return "completed"
  if (type === "execution.failed") return "failed"
  if (type === "execution.cancelled") return "cancelled"
  if (events.findLast((item) => item.type === "wait.created") !== undefined) return "waiting"
  return "running"
}

export const isActionableWait = (item: Event) =>
  item.type === "permission.ask.requested" || item.type === "tool.approval.requested"

export const observableEventTypes = new Set([
  "execution.accepted",
  "execution.started",
  "model.input.prepared",
  "model.output.completed",
  "model.usage.reported",
  "model.attempt.completed",
  "model.attempt.failed",
  "tool.call.requested",
  "tool.result.received",
  "steering.delivered",
  "wait.created",
  "wait.woken",
  "wait.timed_out",
  "wait.cancelled",
  "child_run.spawned",
  "child_fan_out.created",
  "child_fan_out.member.terminal",
  "child_fan_out.terminal",
  "budget.exceeded",
  "execution.completed",
  "execution.failed",
  "execution.cancelled",
])

export const isExecutionNotFound = (failure: unknown) =>
  failure !== null && typeof failure === "object" && "_tag" in failure && failure._tag === "ExecutionNotFound"
