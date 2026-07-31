import * as AgentTools from "@rika/coding-tools/agent-tool-contract"
import * as ExecutionStatus from "@rika/product/execution-status"
import { Ids, ToolRuntime as RelayToolRuntime } from "@relayfx/sdk"
import { Effect } from "effect"

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

export interface JoinOptions {
  readonly childRuns: (executionId: string) => Effect.Effect<ReadonlyArray<ChildRun>, string>
  readonly resolveChild: (childExecutionId: string) => Effect.Effect<AgentTools.Result, string>
}

export interface JoinInput extends JoinOptions {
  readonly executionId: string
  readonly requested?: ReadonlyArray<string> | undefined
}

const failed = (message: string) =>
  RelayToolRuntime.ToolExecutionFailed.make({ tool_name: AgentTools.awaitSubagentsToolName, message })

const collect = (options: JoinOptions, target: JoinTarget) =>
  target._tag === "unknown"
    ? Effect.succeed(
        AgentTools.noReport({
          childExecutionId: target.childExecutionId,
          reason: unknownSubagentReason(target.childExecutionId),
        }),
      )
    : options.resolveChild(target.childExecutionId).pipe(Effect.mapError(failed))

export const join = (input: JoinInput) =>
  Effect.gen(function* () {
    const children = yield* input.childRuns(input.executionId).pipe(Effect.mapError(failed))
    const plan = planJoin({ children, requested: input.requested })
    const pending = plan.find((target) => target._tag === "pending")
    if (pending !== undefined) {
      return yield* RelayToolRuntime.ToolExecutionWaitRequested.make({
        tool_name: AgentTools.awaitSubagentsToolName,
        wait_id: childJoinWaitId(pending.childExecutionId),
      })
    }
    const subagents = yield* Effect.forEach(plan, (target) => collect(input, target), { concurrency: "unbounded" })
    return { subagents }
  })

export const registeredTool = (options: JoinOptions): RelayToolRuntime.RegisteredTool =>
  RelayToolRuntime.tool(AgentTools.awaitSubagentsToolName, {
    description: AgentTools.awaitSubagentsDescription,
    input: AgentTools.AwaitSubagentsInput,
    output: AgentTools.AwaitSubagentsResult,
    needsApproval: false,
    run: (input, context) =>
      join({ ...options, executionId: String(context.executionId), requested: input.subagents ?? undefined }),
  })
