import { Client, Ids } from "@relayfx/sdk"
import { Effect } from "effect"

export const listApprovals = (input: {
  readonly client: Client.Interface
  readonly executions: ReadonlyArray<Ids.ExecutionId>
}) =>
  Effect.forEach(input.executions, (execution) =>
    input.client.tools.listPendingApprovals({ execution_id: execution }),
  ).pipe(
    Effect.map((results) =>
      results.flatMap((result, index) =>
        result.approvals.map((approval) => ({
          waitId: approval.wait_id,
          executionId: String(input.executions[index]),
          callId: approval.tool_call_id,
          toolName: approval.tool_name,
          input: approval.input,
          requestedAt: approval.requested_at,
        })),
      ),
    ),
  )

export const resolveToolApproval = (input: {
  readonly client: Client.Interface
  readonly waitId: string
  readonly approved: boolean
  readonly resolvedAt: number
  readonly comment?: string
}) =>
  input.client.tools
    .resolveApproval({
      wait_id: Ids.WaitId.make(input.waitId),
      approved: input.approved,
      resolved_at: input.resolvedAt,
      ...(input.comment === undefined ? {} : { comment: input.comment }),
    })
    .pipe(Effect.asVoid)

export const resolvePermission = (input: {
  readonly client: Client.Interface
  readonly waitId: string
  readonly answer: "Always" | "Approved" | "Denied"
  readonly resolvedAt: number
  readonly reason?: string
}) =>
  input.client.tools
    .resolvePermission({
      wait_id: Ids.WaitId.make(input.waitId),
      answer: input.answer,
      resolved_at: input.resolvedAt,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    })
    .pipe(Effect.asVoid)
