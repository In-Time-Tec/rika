import type { RunEvent } from "@batonfx/runtime"
import type { Event } from "@rika/product/execution-event"

export const titleInvocationId = "rika.thread-title"

const epoch = (value: string): number => Date.parse(value)

const eventTime = (event: RunEvent.RunEvent): number => {
  switch (event._tag) {
    case "ModelCallStarted":
    case "ModelAttemptStarted":
    case "CompactionStarted":
      return event.startedAt
    case "ModelAttemptFirstOutput":
    case "ModelRetryScheduled":
    case "ModelFallbackScheduled":
      return event.at
    case "ModelAttemptCompleted":
      return event.usageAt
    case "ModelAttemptFailed":
    case "ModelCallFailed":
    case "CompactionFailed":
      return event.failedAt
    case "ModelCallCompleted":
      return event.completedAt
    case "CompactionSkipped":
      return event.skippedAt
    case "CompactionApplied":
      return event.appliedAt
    default:
      return epoch(event.occurredAt)
  }
}

const projected = (
  event: RunEvent.RunEvent,
  index: number,
  type: string,
  extra: Partial<Pick<Event, "text" | "content" | "data">> = {},
  cursor = `${event.eventId}:${event.sequence}`,
): Event => ({
  executionId: event.runId,
  ...(event.parentRunId === undefined ? {} : { childExecutionId: event.runId }),
  cursor,
  sequence: event.sequence * 16 + index,
  type,
  createdAt: eventTime(event),
  timestampSource: "baton",
  ...extra,
})

const attemptIdentity = (event: {
  readonly modelCallId: string
  readonly modelAttemptId: string
  readonly attempt: number
}) => ({
  model_call_id: event.modelCallId,
  model_attempt_id: event.modelAttemptId,
  attempt: event.attempt,
})

const completedUsage = (event: Extract<RunEvent.RunEvent, { readonly _tag: "ModelAttemptCompleted" }>) => ({
  ...attemptIdentity(event),
  ...(event.usage.inputTokens.total === undefined ? {} : { input_tokens: event.usage.inputTokens.total }),
  ...(event.usage.inputTokens.uncached === undefined
    ? {}
    : { input_tokens_uncached: event.usage.inputTokens.uncached }),
  ...(event.usage.inputTokens.cacheRead === undefined
    ? {}
    : { input_tokens_cache_read: event.usage.inputTokens.cacheRead }),
  ...(event.usage.inputTokens.cacheWrite === undefined
    ? {}
    : { input_tokens_cache_write: event.usage.inputTokens.cacheWrite }),
  ...(event.usage.outputTokens.total === undefined ? {} : { output_tokens: event.usage.outputTokens.total }),
  ...(event.usage.outputTokens.text === undefined ? {} : { output_tokens_text: event.usage.outputTokens.text }),
  ...(event.usage.outputTokens.reasoning === undefined
    ? {}
    : { output_tokens_reasoning: event.usage.outputTokens.reasoning }),
  finish_reason: event.finishReason,
  ...(event.responseModel === undefined ? {} : { model: event.responseModel }),
  ...(event.requestId === undefined ? {} : { request_id: event.requestId }),
  ...(event.serviceTier === undefined ? {} : { service_tier: event.serviceTier }),
})

const failedUsage = (event: Extract<RunEvent.RunEvent, { readonly _tag: "ModelAttemptFailed" }>) => ({
  ...attemptIdentity(event),
  ...(event.providerUsage?.inputTokens === undefined ? {} : { input_tokens: event.providerUsage.inputTokens }),
  ...(event.providerUsage?.outputTokens === undefined ? {} : { output_tokens: event.providerUsage.outputTokens }),
  ...(event.providerUsage?.totalTokens === undefined ? {} : { total_tokens: event.providerUsage.totalTokens }),
  category: event.category,
  classification: event.classification,
  disposition: event.disposition,
  ...(event.provider === undefined ? {} : { provider: event.provider }),
  ...(event.model === undefined ? {} : { model: event.model }),
  ...(event.registrationKey === undefined ? {} : { registration_key: event.registrationKey }),
  ...(event.candidate === undefined ? {} : { candidate: event.candidate }),
})

const projectModelPart = (
  event: Extract<RunEvent.RunEvent, { readonly _tag: "ModelPart" }>,
  cursor?: string,
): ReadonlyArray<Event> => {
  const identity = attemptIdentity(event)
  switch (event.part.type) {
    case "text-delta":
      return [projected(event, 0, "model.output.delta", { text: event.part.delta, data: identity }, cursor)]
    case "reasoning-delta":
      return [projected(event, 0, "model.reasoning.delta", { text: event.part.delta, data: identity }, cursor)]
    case "text-end":
      return [projected(event, 0, "model.output.completed", { data: identity }, cursor)]
    case "reasoning-end":
      return [projected(event, 0, "model.reasoning.completed", { data: identity }, cursor)]
    case "tool-params-delta":
      return [
        projected(
          event,
          0,
          "model.toolcall.delta",
          { data: { ...identity, tool_call_id: event.part.id, delta: event.part.delta } },
          cursor,
        ),
      ]
    case "text-start":
    case "reasoning-start":
    case "tool-params-start":
    case "tool-params-end":
    case "tool-approval-request":
    case "file":
    case "source":
    case "response-metadata":
    case "finish":
    case "error":
    case "tool-call":
    case "tool-result":
      return []
  }
}

const isTitleEvent = (event: RunEvent.RunEvent, invocationId?: string): boolean =>
  invocationId === titleInvocationId || (event._tag === "ChildLinked" && event.invocationId === titleInvocationId)

export interface ProjectionInput {
  readonly source: RunEvent.RunEvent
  readonly cursor?: string | undefined
  readonly invocationId?: string | undefined
  readonly parentRunId?: string | undefined
}

export const projectEvent = ({ source, cursor, invocationId, parentRunId }: ProjectionInput): ReadonlyArray<Event> => {
  const event =
    parentRunId === undefined || source.parentRunId !== undefined
      ? source
      : ({ ...source, parentRunId } as RunEvent.RunEvent)
  if (isTitleEvent(event, invocationId)) {
    if (event._tag === "RunCompleted")
      return "text" in event.result
        ? [
            projected(
              event,
              0,
              "thread.title.generated",
              { data: { title: event.result.text, invocation_id: titleInvocationId } },
              cursor,
            ),
          ]
        : []
    if (
      event._tag !== "ModelCallStarted" &&
      event._tag !== "ModelAttemptStarted" &&
      event._tag !== "ModelAttemptFirstOutput" &&
      event._tag !== "ModelAttemptCompleted" &&
      event._tag !== "ModelAttemptFailed" &&
      event._tag !== "ModelRetryScheduled" &&
      event._tag !== "ModelFallbackScheduled" &&
      event._tag !== "ModelCallCompleted" &&
      event._tag !== "ModelCallFailed"
    )
      return []
  }
  switch (event._tag) {
    case "RunAccepted":
      return [projected(event, 0, "execution.accepted", {}, cursor)]
    case "RunAttemptStarted":
      return [projected(event, 0, "execution.started", { data: { attempt: event.attempt } }, cursor)]
    case "TurnStarted":
      return [projected(event, 0, "model.input.prepared", { data: { turn: event.turn } }, cursor)]
    case "ModelPart":
      return projectModelPart(event, cursor)
    case "ToolExecutionStarted":
      return [
        projected(
          event,
          0,
          "tool.call.requested",
          { data: { tool_call_id: event.call.id, tool_name: event.call.name, input: event.call.params } },
          cursor,
        ),
      ]
    case "ToolProgress":
      return [
        projected(
          event,
          0,
          "tool.progress",
          {
            ...(event.message === undefined ? {} : { text: event.message }),
            data: { tool_call_id: event.toolCallId, ...event.data },
          },
          cursor,
        ),
      ]
    case "ToolExecutionCompleted":
      return [
        projected(
          event,
          0,
          "tool.result.received",
          {
            data: {
              tool_call_id: event.call.id,
              tool_name: event.call.name,
              output: event.result.result,
              is_failure: event.result.isFailure,
            },
          },
          cursor,
        ),
      ]
    case "SteeringDrained":
      return [
        projected(event, 0, "steering.delivered", { data: { queue: event.queue, message_count: event.count } }, cursor),
      ]
    case "ModelCallStarted":
      return [
        projected(
          event,
          0,
          "model.call.started",
          { data: { model_call_id: event.modelCallId, purpose: event.purpose } },
          cursor,
        ),
      ]
    case "ModelAttemptStarted":
      return [projected(event, 0, "model.attempt.started", { data: attemptIdentity(event) }, cursor)]
    case "ModelAttemptFirstOutput":
      return [
        projected(
          event,
          0,
          "model.attempt.first_output",
          { data: { ...attemptIdentity(event), kind: event.kind } },
          cursor,
        ),
      ]
    case "ModelAttemptCompleted":
      return [projected(event, 0, "model.attempt.completed", { data: completedUsage(event) }, cursor)]
    case "ModelAttemptFailed":
      return [projected(event, 0, "model.attempt.failed", { data: failedUsage(event) }, cursor)]
    case "ModelRetryScheduled":
      return [
        projected(
          event,
          0,
          "model.retry.scheduled",
          {
            data: {
              model_call_id: event.modelCallId,
              attempt: event.attempt,
              reason: event.reason,
              category: event.category,
              delay_millis: event.delayMillis,
            },
          },
          cursor,
        ),
      ]
    case "ModelFallbackScheduled":
      return [
        projected(
          event,
          0,
          "model.fallback.scheduled",
          {
            data: {
              model_call_id: event.modelCallId,
              attempt: event.attempt,
              category: event.category,
              from_candidate: event.fromCandidate,
              from_provider: event.fromProvider,
              from_model: event.fromModel,
              ...(event.fromRegistrationKey === undefined ? {} : { from_registration_key: event.fromRegistrationKey }),
              to_candidate: event.toCandidate,
              to_provider: event.toProvider,
              to_model: event.toModel,
              ...(event.toRegistrationKey === undefined ? {} : { to_registration_key: event.toRegistrationKey }),
            },
          },
          cursor,
        ),
      ]
    case "ModelCallCompleted":
      return [
        projected(
          event,
          0,
          "model.call.completed",
          { data: { model_call_id: event.modelCallId, purpose: event.purpose, attempts: event.attempts } },
          cursor,
        ),
      ]
    case "ModelCallFailed":
      return [
        projected(
          event,
          0,
          "model.call.failed",
          {
            data: {
              model_call_id: event.modelCallId,
              purpose: event.purpose,
              attempts: event.attempts,
              category: event.category,
              classification: event.classification,
            },
          },
          cursor,
        ),
      ]
    case "CompactionStarted":
      return [
        projected(
          event,
          0,
          "agent.compaction.started",
          { data: { compaction_id: event.compactionId, turn: event.turn, trigger: event.trigger } },
          cursor,
        ),
      ]
    case "CompactionSkipped":
      return [
        projected(
          event,
          0,
          "agent.compaction.completed",
          { data: { compaction_id: event.compactionId, turn: event.turn, kind: "unchanged" } },
          cursor,
        ),
      ]
    case "CompactionApplied":
      return [
        projected(
          event,
          0,
          "agent.compaction.completed",
          {
            data: {
              compaction_id: event.compactionId,
              turn: event.turn,
              kind: event.kind,
              checkpoint: event.checkpointId,
            },
          },
          cursor,
        ),
      ]
    case "CompactionFailed":
      return [
        projected(
          event,
          0,
          "agent.compaction.failed",
          { data: { compaction_id: event.compactionId, turn: event.turn } },
          cursor,
        ),
      ]
    case "RunWaiting":
      return [
        projected(event, 0, "wait.created", { data: { wait_id: event.wait.waitId, mode: event.wait.reason } }, cursor),
      ]
    case "RunResumed":
      return [
        projected(
          event,
          0,
          "wait.woken",
          { data: { wait_id: event.waitId, resolution: event.resolution._tag } },
          cursor,
        ),
      ]
    case "ChildLinked":
      return [
        projected(
          event,
          0,
          "child_run.spawned",
          { data: { child_execution_id: event.childRunId, invocation_id: event.invocationId } },
          cursor,
        ),
      ]
    case "ChildSettled":
      return [
        projected(
          event,
          0,
          "child_run.settled",
          { data: { child_execution_id: event.childRunId, terminal_event_id: event.terminalEventId } },
          cursor,
        ),
      ]
    case "FanOutAdmitted":
      return [
        projected(
          event,
          0,
          "fan_out.admitted",
          {
            data: {
              fan_out_id: event.fanOutId,
              member_count: event.memberCount,
              concurrency: event.concurrency,
              join: event.join._tag,
              remainder: event.remainder,
            },
          },
          cursor,
        ),
      ]
    case "FanOutJoined":
      return [
        projected(
          event,
          0,
          "fan_out.joined",
          {
            data: {
              fan_out_id: event.fanOutId,
              status: event.status,
              succeeded: event.succeeded,
              failed: event.failed,
              cancelled: event.cancelled,
              abandoned: event.abandoned,
              remainder: event.remainder,
            },
          },
          cursor,
        ),
      ]
    case "RunCompleted":
      return "text" in event.result
        ? [
            projected(
              event,
              0,
              "model.output.completed",
              { text: event.result.text, content: [{ type: "text", text: event.result.text }] },
              cursor,
            ),
            projected(event, 1, "execution.completed", {}, cursor),
          ]
        : [projected(event, 0, "execution.completed", {}, cursor)]
    case "RunFailed":
      return [
        projected(
          event,
          0,
          "execution.failed",
          { text: event.error.message, data: { message: event.error.message, details: event.error } },
          cursor,
        ),
      ]
    case "RunCancellationRequested":
      return [
        projected(
          event,
          0,
          "execution.cancellation.requested",
          { data: event.reason === undefined ? {} : { reason: event.reason } },
          cursor,
        ),
      ]
    case "RunCancelled":
      return [
        projected(
          event,
          0,
          "execution.cancelled",
          { data: event.reason === undefined ? {} : { reason: event.reason } },
          cursor,
        ),
      ]
    case "ProgramLog":
      return [
        projected(
          event,
          0,
          "program.log",
          {
            text: event.message,
            data: { operation: event.operation, level: event.level, ...event.data },
          },
          cursor,
        ),
      ]
    case "OperationUnknown":
      return [
        projected(event, 0, "execution.resolution.required", { data: { operation_id: event.operationId } }, cursor),
      ]
    case "TurnCompleted":
    case "StructuredOutput":
    case "HandoffRequested":
    case "HandoffCompleted":
    case "HandoffRejected":
    case "ApprovalRequested":
      return []
  }
}
