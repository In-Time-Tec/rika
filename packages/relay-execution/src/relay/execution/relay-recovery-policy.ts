import { Duration, Effect, Schedule } from "effect"
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
