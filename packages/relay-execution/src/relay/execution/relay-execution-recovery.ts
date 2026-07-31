import { Client, Ids, type Execution } from "@relayfx/sdk"
import { Clock, Duration, Effect, Option, Schedule } from "effect"
import * as AgentAwait from "@rika/coding-tools/agent-tool-contract"
import * as AgentOutcomes from "@rika/coding-tools/agent-tool-contract"
import * as ExecutionStatus from "@rika/product/execution-status"

export const childJoinWaitMode = "child"
export const terminalExecutionStatus = ExecutionStatus.isTerminalStatus
export const defaultRecoveryChildSettlementGrace = Duration.seconds(30)
export const unsafeRecoveryFailure = "Parent execution stopped before its first durable chat checkpoint"
export const outlivedParentReason = "Parent execution ended before this subagent's report was collected"
export const recoveryRetrySchedule = Schedule.exponential("100 millis").pipe(
  Schedule.jittered,
  Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, Duration.seconds(5)))),
)

export interface SubagentWorkInspection {
  readonly child_runs: ReadonlyArray<{ readonly status: ExecutionStatus.Status }>
  readonly waiting_on: ReadonlyArray<{ readonly mode: string }>
}

export const hasLiveSubagentWork = (inspection: SubagentWorkInspection) =>
  inspection.child_runs.some((child) => !terminalExecutionStatus(child.status)) ||
  inspection.waiting_on.some((wait) => wait.mode === childJoinWaitMode)

const retryRecoveryPersistence = <A, E, R>(effect: Effect.Effect<A, E, R>, execution: string) =>
  effect.pipe(
    Effect.tapError(() =>
      Effect.logWarning("execution.recovery.retrying").pipe(Effect.annotateLogs({ "rika.execution.id": execution })),
    ),
  )

export const reconcileUnsafeRecovery = (input: {
  readonly client: Client.Interface
  readonly execution: string
  readonly childSettlementGrace: Duration.Duration
}) =>
  Effect.gen(function* () {
    const id = Ids.ExecutionId.make(input.execution)
    const inspect = retryRecoveryPersistence(input.client.executions.inspect(id), input.execution).pipe(
      Effect.retry({ schedule: recoveryRetrySchedule }),
    )
    const settled = yield* inspect.pipe(
      Effect.repeat({
        while: (inspection) => inspection.child_runs.some((child) => !terminalExecutionStatus(child.status)),
        schedule: Schedule.spaced("100 millis"),
      }),
      Effect.timeoutOption(input.childSettlementGrace),
    )
    const reconciledAt = yield* Clock.currentTimeMillis
    yield* retryRecoveryPersistence(
      input.client.executions.cancel({ execution_id: id, cancelled_at: reconciledAt, reason: unsafeRecoveryFailure }),
      input.execution,
    ).pipe(Effect.retry({ schedule: recoveryRetrySchedule }))
    const inspection = yield* inspect
    yield* Effect.logWarning("execution.recovery.failed_safe").pipe(
      Effect.annotateLogs({
        "rika.execution.id": input.execution,
        "rika.recovery.child.count": inspection.child_runs.length,
        "rika.recovery.children.settled": Option.isSome(settled),
        "rika.recovery.pending_tool.count": inspection.pending_tool_calls.length,
      }),
    )
  })

const terminalStatuses: Readonly<Record<string, "completed" | "failed" | "cancelled">> = {
  "execution.completed": "completed",
  "execution.failed": "failed",
  "execution.cancelled": "cancelled",
}

const durableOutput = (event: Execution.ExecutionEvent | undefined): ReadonlyArray<unknown> | undefined => {
  if (event === undefined) return undefined
  if (event.content?.some((part) => part.type === "text" && part.text.trim().length > 0) === true) return event.content
  const text = event.data?.text
  return typeof text === "string" && text.trim().length > 0 ? [{ type: "text", text }] : undefined
}

const scrubbedMessage = (data: Readonly<Record<string, unknown>> | undefined) => {
  const message = data?.message
  return typeof message === "string" && message.length > 0 && message !== "[object Object]" ? message : undefined
}

const overflowDetail = (data: Readonly<Record<string, unknown>> | undefined) => {
  const details =
    typeof data?.details === "object" && data.details !== null
      ? (data.details as Readonly<Record<string, unknown>>)
      : undefined
  return details?.failure_classification === "context-overflow"
    ? "Automatic compaction could not reduce the thread enough for this model."
    : undefined
}

const childFailureText = (terminal: Execution.ExecutionEvent | undefined) => {
  if (terminal?.type !== "execution.failed" && terminal?.type !== "execution.cancelled") return undefined
  const message =
    scrubbedMessage(terminal.data) ?? (terminal.type === "execution.failed" ? overflowDetail(terminal.data) : undefined)
  const outcome =
    terminal.type === "execution.cancelled" ? "Subagent execution was cancelled" : "Subagent execution failed"
  return message === undefined ? outcome : `${outcome}: ${message}`
}

const unreconciledReason = (status: string) =>
  `The subagent's execution finished as ${status}, but its final event never reached Rika, so no report was recovered.`
const silentChildReason = "The subagent finished its run without writing a final report."

export interface ChildResultInput {
  readonly childExecutionId: string
  readonly events: ReadonlyArray<Execution.ExecutionEvent>
  readonly reconciled?: "completed" | "failed" | "cancelled"
}

export const resolveChildResult = ({ childExecutionId, events, reconciled }: ChildResultInput): AgentAwait.Result => {
  const terminal = events.findLast((item) => terminalStatuses[item.type] !== undefined)
  const resumed =
    events.findLast((item) => item.type === "model.call.started" || item.type === "tool.call.requested")?.sequence ?? -1
  const report = durableOutput(
    events.findLast(
      (item) =>
        (item.type === "model.output.completed" || item.type === "model.cycle.completed") &&
        item.sequence > resumed &&
        durableOutput(item) !== undefined,
    ),
  )
  const output = report ?? durableOutput(terminal)
  const failure = childFailureText(terminal)
  const status = (terminal === undefined ? undefined : terminalStatuses[terminal.type]) ?? reconciled ?? "failed"
  if (status === "cancelled")
    return AgentOutcomes.AgentContract.cancelled({
      childExecutionId,
      reason: failure ?? unreconciledReason(status),
      output: output === undefined || output.length === 0 ? [] : (output as readonly [unknown, ...unknown[]]),
    })
  if (output === undefined || output.length === 0) {
    if (status === "completed")
      return AgentOutcomes.AgentContract.noReport({ childExecutionId, reason: silentChildReason, status })
    return AgentOutcomes.AgentContract.noReport({ childExecutionId, reason: failure ?? unreconciledReason(status) })
  }
  if (status === "completed")
    return AgentOutcomes.AgentContract.report({ childExecutionId, output: output as readonly [unknown, ...unknown[]] })
  return AgentOutcomes.AgentContract.failed({
    childExecutionId,
    reason: failure ?? unreconciledReason(status),
    output: output as readonly [unknown, ...unknown[]],
  })
}
