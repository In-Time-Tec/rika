import * as ExecutionStatus from "@rika/product/execution-status"
import { Ids } from "@relayfx/sdk"

export const childJoinWaitId = (childExecutionId: string) => Ids.WaitId.make(`wait:child:${childExecutionId}`)
export const unknownSubagentReason = (childExecutionId: string) =>
  `${childExecutionId} is not a subagent of this turn, so there is no report to collect.`

export interface ChildRun {
  readonly childExecutionId: string
  readonly status: ExecutionStatus.Status
}

export type JoinTarget =
  | { readonly _tag: "pending"; readonly childExecutionId: string }
  | { readonly _tag: "terminal"; readonly childExecutionId: string }
  | { readonly _tag: "unknown"; readonly childExecutionId: string }

export interface JoinPlanInput {
  readonly children: ReadonlyArray<ChildRun>
  readonly requested?: ReadonlyArray<string> | undefined
}

export const planJoin = ({ children, requested }: JoinPlanInput): ReadonlyArray<JoinTarget> => {
  const known = new Map(children.map((child) => [child.childExecutionId, child.status]))
  const selected = [...new Set(requested ?? [...known.keys()])]
  return selected.map((childExecutionId) => {
    const status = known.get(childExecutionId)
    if (status === undefined) return { _tag: "unknown", childExecutionId } as const
    return ExecutionStatus.isTerminalStatus(status)
      ? ({ _tag: "terminal", childExecutionId } as const)
      : ({ _tag: "pending", childExecutionId } as const)
  })
}
