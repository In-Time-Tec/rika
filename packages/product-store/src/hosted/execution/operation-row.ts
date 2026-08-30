import { and, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { CellResponse } from "@rika/remote-execution/protocol"
import { rikaHostedExecutorOperations } from "../../database/schema/product"
import type * as PgDrizzle from "drizzle-orm/effect-postgres"
import {
  HostedExecutionOperationsError,
  type FinalizeOperationResult,
  type OperationIdentity,
  type OperationRecord,
} from "./operation-contract"

export const failure = (cause: unknown) =>
  HostedExecutionOperationsError.make({ message: `Execution persistence failed: ${String(cause)}` })
export const query = <A extends object, E, R>(effect: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  effect.pipe(Effect.mapError(failure))
export const timestamp = (value: Date) => value.toISOString()
export const operationKey = (input: Pick<OperationIdentity, "assignmentId" | "operationKey" | "attempt">) =>
  and(
    eq(rikaHostedExecutorOperations.assignmentId, input.assignmentId),
    eq(rikaHostedExecutorOperations.operationKey, input.operationKey),
    eq(rikaHostedExecutorOperations.attempt, input.attempt),
  )
export const finalizeFailure = (
  tag: Exclude<FinalizeOperationResult["_tag"], "finalized" | "already-terminal">,
): FinalizeOperationResult => ({ _tag: tag })

const selectOperationUncurried = (
  executor: PgDrizzle.EffectPgDatabase,
  input: Pick<OperationIdentity, "assignmentId" | "operationKey" | "attempt">,
  lock?: "update",
) => {
  const statement = executor.select().from(rikaHostedExecutorOperations).where(operationKey(input))
  return lock === "update" ? statement.for("update") : statement
}
export const operationRows = { select: selectOperationUncurried }

export const decodeOperation = (
  row: typeof rikaHostedExecutorOperations.$inferSelect,
): Effect.Effect<OperationRecord, HostedExecutionOperationsError> =>
  Effect.gen(function* () {
    const response = row.response === null ? null : yield* Schema.decodeUnknownEffect(CellResponse)(row.response)
    return {
      assignmentId: row.assignmentId,
      ownerId: row.ownerId,
      operationKey: row.operationKey,
      requestDigest: row.requestDigest,
      workspaceId: row.workspaceId,
      sessionId: row.sessionId,
      threadId: row.threadId,
      turnId: row.turnId,
      runId: row.runId,
      rootRunId: row.rootRunId,
      toolCallId: row.toolCallId,
      code: row.code,
      attempt: row.attempt,
      replayPolicy: row.replayPolicy,
      admittedAt: row.admittedAt,
      deadlineAt: timestamp(row.deadlineAt),
      state: row.state,
      started: row.startedAt !== null,
      dispatchedGeneration: row.dispatchedGeneration,
      dispatchedLeaseEpoch: row.dispatchedLeaseEpoch,
      dispatchedExecutorInstanceId: row.dispatchedExecutorInstanceId,
      dispatchedProcessIncarnation: row.dispatchedProcessIncarnation,
      response,
      terminalOutcome:
        row.terminalOutcome === null
          ? null
          : yield* Schema.decodeUnknownEffect(Schema.Literals(["completed", "failed", "cancelled", "unknown"]))(
              row.terminalOutcome,
            ),
    }
  }).pipe(Effect.mapError(failure))
