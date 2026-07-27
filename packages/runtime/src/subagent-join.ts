import { AgentTools, ExecutionStatus } from "@rika/tools"
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

export const planJoin = (
  children: ReadonlyArray<ChildRun>,
  requested: ReadonlyArray<string> | undefined,
): ReadonlyArray<JoinTarget> => {
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

export const join = (options: JoinOptions, executionId: string, requested: ReadonlyArray<string> | undefined) =>
  Effect.gen(function* () {
    const children = yield* options.childRuns(executionId).pipe(Effect.mapError(failed))
    const plan = planJoin(children, requested)
    const pending = plan.find((target) => target._tag === "pending")
    if (pending !== undefined) {
      return yield* RelayToolRuntime.ToolExecutionWaitRequested.make({
        tool_name: AgentTools.awaitSubagentsToolName,
        wait_id: childJoinWaitId(pending.childExecutionId),
      })
    }
    const subagents = yield* Effect.forEach(plan, (target) => collect(options, target), {
      concurrency: "unbounded",
    })
    return { subagents }
  })

export const registeredTool = (options: JoinOptions): RelayToolRuntime.RegisteredTool =>
  RelayToolRuntime.tool(AgentTools.awaitSubagentsToolName, {
    description: AgentTools.awaitSubagentsDescription,
    input: AgentTools.AwaitSubagentsInput,
    output: AgentTools.AwaitSubagentsResult,
    needsApproval: false,
    run: (input, context) => join(options, String(context.executionId), input.subagents ?? undefined),
  })
