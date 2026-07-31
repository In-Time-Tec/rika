import * as AgentDefinitions from "@rika/coding-tools/agent-tool-contract"
import * as AgentSelection from "@rika/coding-tools/agent-tool-contract"
import * as AgentAwait from "@rika/coding-tools/agent-tool-contract"
import * as AgentOutcomes from "@rika/coding-tools/agent-tool-contract"
import { Client, Ids, ToolRuntime as RelayToolRuntime } from "@relayfx/sdk"
import { resolveChildResult } from "./relay-execution-recovery"
import { awaitExecutionAvailable } from "./relay-execution-wait"
import { Effect, Stream } from "effect"
import {
  childJoinWaitId,
  unknownSubagentReason,
  planJoin,
  type ChildRun,
  type JoinTarget,
} from "./relay-child-join-plan"

interface JoinOptions {
  readonly childRuns: (executionId: string) => Effect.Effect<ReadonlyArray<ChildRun>, string>
  readonly resolveChild: (childExecutionId: string) => Effect.Effect<AgentAwait.Result, string>
}

interface JoinInput extends JoinOptions {
  readonly executionId: string
  readonly requested?: ReadonlyArray<string> | undefined
}

const failed = (message: string) =>
  RelayToolRuntime.ToolExecutionFailed.make({ tool_name: AgentSelection.AgentContract.awaitSubagentsToolName, message })

const collect = (options: JoinOptions, target: JoinTarget) =>
  target._tag === "unknown"
    ? Effect.succeed(
        AgentOutcomes.AgentContract.noReport({
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
        tool_name: AgentSelection.AgentContract.awaitSubagentsToolName,
        wait_id: childJoinWaitId(pending.childExecutionId),
      })
    }
    const subagents = yield* Effect.forEach(plan, (target) => collect(input, target), { concurrency: "unbounded" })
    return { subagents }
  })

export const awaitChildResult = (input: { readonly client: Client.Interface; readonly childId: string }) => {
  const childExecutionId = Ids.ExecutionId.make(input.childId)
  return awaitExecutionAvailable({ client: input.client, id: childExecutionId }).pipe(
    Effect.flatMap(() =>
      Effect.gen(function* () {
        const inspection = yield* input.client.executions.inspect(childExecutionId)
        if (["completed", "failed", "cancelled"].includes(inspection.status)) {
          const page = yield* input.client.executions.pageEvents({
            execution_id: childExecutionId,
            direction: "backward",
            limit: 256,
          })
          return resolveChildResult({
            childExecutionId: input.childId,
            events: page.events,
            reconciled: inspection.status as "completed" | "failed" | "cancelled",
          })
        }
        const items = yield* Stream.runCollect(
          input.client.executions.follow({
            execution_id: childExecutionId,
            ...(inspection.last_event_cursor === undefined ? {} : { after_cursor: inspection.last_event_cursor }),
          }),
        )
        const stopped = [...items].find(
          (item): item is Extract<typeof item, { readonly _tag: "stopped" }> => item._tag === "stopped",
        )
        const reconciled = stopped?.reason._tag === "terminal" ? stopped.reason.status : undefined
        return resolveChildResult({
          childExecutionId: input.childId,
          events: [...items].flatMap((item) => (item._tag === "event" ? [item.event] : [])),
          ...(reconciled === "completed" || reconciled === "failed" || reconciled === "cancelled"
            ? { reconciled }
            : {}),
        })
      }),
    ),
  )
}

export const registeredTool = (options: JoinOptions): RelayToolRuntime.RegisteredTool =>
  RelayToolRuntime.tool(AgentSelection.AgentContract.awaitSubagentsToolName, {
    description: AgentSelection.AgentContract.awaitSubagentsDescription,
    input: AgentDefinitions.AgentContract.AwaitSubagentsInput,
    output: AgentAwait.AgentContract.AwaitSubagentsResult,
    needsApproval: false,
    run: (input, context) =>
      join({ ...options, executionId: String(context.executionId), requested: input.subagents ?? undefined }),
  })
