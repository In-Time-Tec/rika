import { Content } from "@relayfx/sdk"
import type { ChildOrchestration, Execution, Workflow } from "@relayfx/sdk"
import { Effect, Schema } from "effect"
import type { Event } from "@rika/product/execution-event"
import type { PromptPart } from "@rika/product/execution-request"
import { Status } from "@rika/product/execution-status"
import { ExecutionId } from "@rika/product/execution-identifier"
import { BackendError } from "@rika/product/execution-service"
import * as DataBlobStore from "../../data-blob-store"
import {
  attachedWorkflow,
  childIdFromExecutionId,
  standaloneWorkflow,
  threadIdFromMetadata,
} from "./relay-execution-identifier"
import { workflowDefinitionName } from "../relay-workflow-compiler"

export const childExecutionIdFromEvent = (item: Execution.ExecutionEvent) => {
  const value = item.child_execution_id ?? item.data?.child_execution_id
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export const error = (cause: unknown): BackendError =>
  Schema.is(BackendError)(cause) ? cause : BackendError.make({ message: String(cause) })

export const executionInput = (input: {
  readonly prompt: string
  readonly promptParts?: ReadonlyArray<PromptPart>
}) => {
  if (input.promptParts === undefined) return [Content.text(input.prompt)]
  const parts: Array<ReturnType<typeof Content.text> | ReturnType<typeof DataBlobStore.reference>> = []
  let pendingText: string | undefined
  const flushText = () => {
    if (pendingText === undefined) return
    parts.push(Content.text(pendingText))
    pendingText = undefined
  }
  for (const part of input.promptParts) {
    if (part.type === "text") {
      pendingText = (pendingText ?? "") + part.text
      continue
    }
    flushText()
    parts.push(DataBlobStore.reference(part.mediaType, part.data, part.filename))
  }
  flushText()
  return parts
}

export const mapFanOut = (value: ChildOrchestration.FanOutState) => {
  const parentTurnId = ExecutionId.executionKey(String(value.parent_execution_id))
  return {
    fanOutId: String(value.fan_out_id),
    parentTurnId,
    state: value.state,
    maxConcurrency: value.max_concurrency,
    join: value.join._tag,
    members: value.members.map((member) => ({
      childId: childIdFromExecutionId({ parentTurnId, value: member.child_execution_id }),
      ordinal: member.ordinal,
      state: member.state,
      ...(member.output === undefined
        ? {}
        : {
            output: Array.isArray(member.output)
              ? member.output.map((part) => (part.type === "text" ? part.text : JSON.stringify(part))).join("")
              : member.output,
          }),
      ...(member.error === undefined ? {} : { error: member.error }),
    })),
  }
}

export const workflow = (value: Workflow.RunRecord) => {
  const execution = String(value.execution_id)
  const attached = attachedWorkflow(execution)
  const standalone = standaloneWorkflow(execution)
  return {
    runId: attached?.runId ?? standalone?.runId ?? execution.replace(/^workflow:/, ""),
    ...(attached === undefined ? {} : { ownerTurnId: attached.ownerTurnId }),
    workflow: workflowDefinitionName(String(value.pin.workflow_definition_id)),
    revision: value.pin.workflow_definition_revision,
    digest: value.pin.workflow_definition_digest,
    status: value.status,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  }
}

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

export const traceWithoutResult = <A, E, R>(input: {
  readonly name: string
  readonly effect: Effect.Effect<A, E, R>
}): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    let result!: A
    return input.effect.pipe(
      Effect.tap((value) =>
        Effect.sync(() => {
          result = value
        }),
      ),
      Effect.asVoid,
      Effect.withSpan(input.name),
      Effect.andThen(Effect.sync(() => result)),
    )
  })

export const threadId = threadIdFromMetadata
