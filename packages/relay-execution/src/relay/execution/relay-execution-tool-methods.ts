import { awaitExecutionRunning } from "./relay-execution-wait"
import { error } from "./relay-event-payload"
import { Client, Content, Ids } from "@relayfx/sdk"
import { Clock, Effect } from "effect"
import type { ExecutionReference } from "@rika/product/execution-identifier"
import { BackendError } from "@rika/product/execution-service"
import * as IdentifierCodec from "./relay-execution-id-codec"
import * as Tree from "./relay-execution-tree"

export const toolMethods = (client: Client.Interface) => ({
  steer: Effect.fn("ExecutionBackend.steer")(function* (
    turnId: string,
    text: string,
    idempotencyIdentity: string,
    reference: ExecutionReference | undefined,
  ) {
    const id = IdentifierCodec.executionId({ turnId, reference })
    const createdAt = yield* Clock.currentTimeMillis
    yield* awaitExecutionRunning({ client, id }).pipe(
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () =>
          Effect.fail(Client.ClientError.make({ message: "Execution did not become available for steering" })),
      }),
      Effect.mapError(error),
    )
    const accepted = yield* client.executions
      .steer({
        execution_id: id,
        idempotency_key: idempotencyIdentity,
        kind: "steering",
        content: [Content.text(text)],
        created_at: createdAt,
      })
      .pipe(
        Effect.mapError((cause) =>
          cause !== null && typeof cause === "object" && "_tag" in cause && cause._tag === "SteeringIdempotencyConflict"
            ? BackendError.make({
                message: "Steering idempotency identity was already used with a different semantic payload",
              })
            : error(cause),
        ),
      )
    return { steeringMessageId: String(accepted.steering_message_id), sequence: accepted.sequence }
  }),
  listApprovals: Effect.fn("ExecutionBackend.listApprovals")(function* (
    turnId: string,
    reference: ExecutionReference | undefined,
  ) {
    return yield* Effect.gen(function* () {
      const ids = yield* Tree.executionTreeIds({
        client,
        root: IdentifierCodec.executionId({ turnId, reference }),
      })
      const approvals = yield* Effect.forEach(ids, (execution) =>
        client.tools.listPendingApprovals({ execution_id: execution }),
      )
      return approvals.flatMap((result, index) =>
        result.approvals.map((approval) => ({
          waitId: approval.wait_id,
          executionId: String(ids[index]),
          callId: approval.tool_call_id,
          toolName: approval.tool_name,
          input: approval.input,
          requestedAt: approval.requested_at,
        })),
      )
    }).pipe(Effect.mapError(error))
  }),
  resolveToolApproval: Effect.fn("ExecutionBackend.resolveToolApproval")(function* (
    waitId: string,
    approved: boolean,
    resolvedAt: number,
    comment: string | undefined,
  ) {
    yield* client.tools
      .resolveApproval({
        wait_id: Ids.WaitId.make(waitId),
        approved,
        resolved_at: resolvedAt,
        ...(comment === undefined ? {} : { comment }),
      })
      .pipe(Effect.mapError(error))
  }),
  resolvePermission: Effect.fn("ExecutionBackend.resolvePermission")(function* (
    waitId: string,
    answer: "Always" | "Approved" | "Denied",
    resolvedAt: number,
    reason: string | undefined,
  ) {
    yield* client.tools
      .resolvePermission({
        wait_id: Ids.WaitId.make(waitId),
        answer,
        resolved_at: resolvedAt,
        ...(reason === undefined ? {} : { reason }),
      })
      .pipe(Effect.mapError(error))
  }),
})
