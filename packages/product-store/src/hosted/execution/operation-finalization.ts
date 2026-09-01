import type * as PgDrizzle from "drizzle-orm/effect-postgres"
import { and, eq, isNotNull, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import {
  ToolOperationLifecycleFrame,
  ToolOperationResponse,
  ToolOperationTerminalOutcome,
  type ToolOperationLifecycleFrame as ToolOperationLifecycleFrameValue,
} from "@rika/product/tool-operation-lifecycle"
import {
  rikaHostedExecutorAssignments,
  rikaHostedExecutorOperationFrames,
  rikaHostedExecutorOperations,
  rikaHostedThreadProtocolCommands,
} from "../../database/schema/product"
import type {
  DispatchFence,
  FinalizedOperation,
  FinalizeOperationInput,
  HostedExecutionOperationsService,
} from "./operation-contract"
import { decodeOperation, failure, finalizeFailure, operationKey, operationRows, query } from "./operation-row"

type CompletionFence = Omit<DispatchFence, "providerInstanceId">
const every = (...conditions: ReadonlyArray<boolean>) => conditions.every(Boolean)
const fenceMatches = (expected: CompletionFence, actual: CompletionFence) =>
  expected.assignmentGeneration === actual.assignmentGeneration &&
  expected.leaseEpoch === actual.leaseEpoch &&
  expected.executorInstanceId === actual.executorInstanceId &&
  expected.processIncarnation === actual.processIncarnation
const completionFenceMatches = (expected: CompletionFence | undefined, actual: CompletionFence) =>
  expected !== undefined &&
  expected.assignmentGeneration === actual.assignmentGeneration &&
  expected.executorInstanceId === actual.executorInstanceId &&
  expected.processIncarnation === actual.processIncarnation

type OperationRow = typeof rikaHostedExecutorOperations.$inferSelect

const dispatchedFence = (row: OperationRow): CompletionFence | undefined => {
  if (
    row.dispatchedGeneration === null ||
    row.dispatchedLeaseEpoch === null ||
    row.dispatchedExecutorInstanceId === null ||
    row.dispatchedProcessIncarnation === null
  )
    return undefined
  return {
    assignmentGeneration: row.dispatchedGeneration,
    leaseEpoch: row.dispatchedLeaseEpoch,
    executorInstanceId: row.dispatchedExecutorInstanceId,
    processIncarnation: row.dispatchedProcessIncarnation,
  }
}

const existingResult = (row: OperationRow, input: FinalizeOperationInput) =>
  Effect.gen(function* () {
    if (row.response === null || row.terminalOutcome === null) return yield* failure("Terminal operation is incomplete")
    const previous = yield* Schema.decodeUnknownEffect(ToolOperationResponse)(row.response).pipe(
      Effect.mapError(failure),
    )
    if (
      every(
        !Schema.toEquivalence(ToolOperationResponse)(previous, input.response),
        input.state !== "unknown",
        row.state !== "unknown",
      )
    )
      return finalizeFailure("response-conflict")
    const outcome = yield* Schema.decodeUnknownEffect(ToolOperationTerminalOutcome)(row.terminalOutcome).pipe(
      Effect.mapError(failure),
    )
    return { _tag: "already-terminal", response: previous, outcome } as const
  })

type TerminalFrame = Extract<ToolOperationLifecycleFrameValue, { readonly _tag: "Terminal" }>

const resolveFinalization = (
  terminal: TerminalFrame | undefined,
  input: FinalizeOperationInput,
  fence: CompletionFence,
) => {
  if (
    every(
      terminal !== undefined,
      input.state === "completed",
      terminal !== undefined && !Schema.toEquivalence(ToolOperationResponse)(terminal.response, input.response),
    )
  )
    return finalizeFailure("response-conflict")
  const response = terminal?.response ?? input.response
  const outcome = terminal?.outcome ?? "unknown"
  let state: "completed" | "unknown" = input.state
  if (terminal !== undefined) state = terminal.outcome === "unknown" ? "unknown" : "completed"
  if (state === "completed" && terminal === undefined && !completionFenceMatches(input.completionFence, fence))
    return finalizeFailure("completion-fence-mismatch")
  const expected = input.expectedFence ?? fence
  if (!fenceMatches(expected, fence)) return finalizeFailure("expected-fence-mismatch")
  return { _tag: "resolved", response, outcome, state, expected } as const
}

export const operationsStore = (db: PgDrizzle.EffectPgDatabase) => {
  const complete: HostedExecutionOperationsService["complete"] = (input, fence, response, outcome) =>
    query(
      db
        .update(rikaHostedExecutorOperations)
        .set({
          state: outcome === "unknown" ? "unknown" : "completed",
          response,
          terminalOutcome: outcome,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            operationKey(input),
            eq(rikaHostedExecutorOperations.state, "dispatched"),
            eq(rikaHostedExecutorOperations.dispatchedGeneration, fence.assignmentGeneration),
            eq(rikaHostedExecutorOperations.dispatchedLeaseEpoch, fence.leaseEpoch),
            eq(rikaHostedExecutorOperations.dispatchedExecutorInstanceId, fence.executorInstanceId),
            eq(rikaHostedExecutorOperations.dispatchedProcessIncarnation, fence.processIncarnation),
          ),
        )
        .returning({ key: rikaHostedExecutorOperations.operationKey }),
    ).pipe(Effect.map((rows) => rows[0] !== undefined))
  const finalizeOperation: HostedExecutionOperationsService["finalizeOperation"] = (input) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const rows = yield* query(operationRows.select(tx, input, "update"))
          const row = rows[0]
          if (row === undefined) return finalizeFailure("missing")
          if (row.state === "completed" || row.state === "unknown") return yield* existingResult(row, input)
          if (row.state !== "dispatched") return finalizeFailure("not-dispatched")
          const fence = dispatchedFence(row)
          if (fence === undefined) return finalizeFailure("incomplete-fence")
          const receipts = yield* query(
            tx
              .select({ frame: rikaHostedExecutorOperationFrames.frame })
              .from(rikaHostedExecutorOperationFrames)
              .where(
                and(
                  eq(rikaHostedExecutorOperationFrames.assignmentId, input.assignmentId),
                  eq(rikaHostedExecutorOperationFrames.operationKey, input.operationKey),
                  eq(rikaHostedExecutorOperationFrames.attempt, input.attempt),
                  eq(rikaHostedExecutorOperationFrames.kind, "Terminal"),
                ),
              )
              .limit(1),
          )
          const terminal =
            receipts[0] === undefined
              ? undefined
              : yield* Schema.decodeUnknownEffect(ToolOperationLifecycleFrame)(receipts[0].frame).pipe(
                  Effect.mapError(failure),
                  Effect.flatMap((frame) =>
                    frame._tag === "Terminal"
                      ? Effect.succeed(frame)
                      : Effect.fail(failure("Terminal frame kind is invalid")),
                  ),
                )
          const resolved = resolveFinalization(terminal, input, fence)
          if (resolved._tag !== "resolved") return resolved
          const { expected, outcome, response, state } = resolved
          const updated = yield* query(
            tx
              .update(rikaHostedExecutorOperations)
              .set({ state, response, terminalOutcome: outcome, updatedAt: sql`clock_timestamp()` })
              .where(
                and(
                  operationKey(input),
                  eq(rikaHostedExecutorOperations.state, "dispatched"),
                  eq(rikaHostedExecutorOperations.dispatchedGeneration, expected.assignmentGeneration),
                  eq(rikaHostedExecutorOperations.dispatchedLeaseEpoch, expected.leaseEpoch),
                  eq(rikaHostedExecutorOperations.dispatchedExecutorInstanceId, expected.executorInstanceId),
                  eq(rikaHostedExecutorOperations.dispatchedProcessIncarnation, expected.processIncarnation),
                ),
              )
              .returning({ key: rikaHostedExecutorOperations.operationKey }),
          )
          if (updated[0] === undefined) return finalizeFailure("expected-fence-mismatch")
          const commands = yield* query(
            tx
              .select({ sequence: rikaHostedThreadProtocolCommands.threadVersion })
              .from(rikaHostedThreadProtocolCommands)
              .where(
                and(
                  eq(rikaHostedThreadProtocolCommands.threadId, row.threadId),
                  eq(rikaHostedThreadProtocolCommands.turnId, row.turnId),
                ),
              )
              .limit(1),
          )
          if (commands[0] === undefined) return yield* failure("Runner command is unavailable")
          const result: FinalizedOperation = {
            _tag: "finalized",
            response,
            outcome,
            commandSequence: commands[0].sequence,
            fence,
          }
          return result
        }),
      )
      .pipe(
        Effect.mapError(failure),
        Effect.tap((result) =>
          result._tag === "finalized" && input.onFinalize !== undefined
            ? input.onFinalize(result).pipe(Effect.mapError(failure))
            : Effect.void,
        ),
      )
  const terminalizeAccepted: HostedExecutionOperationsService["terminalizeAccepted"] = (
    input,
    response,
    outcome,
    onTerminalize,
  ) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const rows = yield* query(operationRows.select(tx, input, "update"))
          const row = rows[0]
          if (row === undefined || row.state !== "accepted") return undefined
          const updated = yield* query(
            tx
              .update(rikaHostedExecutorOperations)
              .set({ state: "completed", response, terminalOutcome: outcome, updatedAt: sql`clock_timestamp()` })
              .where(and(operationKey(input), eq(rikaHostedExecutorOperations.state, "accepted")))
              .returning({ key: rikaHostedExecutorOperations.operationKey }),
          )
          if (updated[0] === undefined) return undefined
          const commands = yield* query(
            tx
              .select({ sequence: rikaHostedThreadProtocolCommands.threadVersion })
              .from(rikaHostedThreadProtocolCommands)
              .where(
                and(
                  eq(rikaHostedThreadProtocolCommands.threadId, row.threadId),
                  eq(rikaHostedThreadProtocolCommands.turnId, row.turnId),
                ),
              )
              .limit(1),
          )
          const assignments = yield* query(
            tx
              .select({
                generation: rikaHostedExecutorAssignments.generation,
                leaseEpoch: rikaHostedExecutorAssignments.leaseEpoch,
              })
              .from(rikaHostedExecutorAssignments)
              .where(
                and(
                  eq(rikaHostedExecutorAssignments.id, input.assignmentId),
                  isNotNull(rikaHostedExecutorAssignments.leaseEpoch),
                ),
              )
              .for("share"),
          )
          if (commands[0] === undefined || assignments[0]?.leaseEpoch === null || assignments[0] === undefined)
            return yield* failure("Runner deadline authority is unavailable")
          const result = {
            operation: yield* decodeOperation({ ...row, state: "completed", response, terminalOutcome: outcome }),
            commandSequence: commands[0].sequence,
            assignmentGeneration: assignments[0].generation,
            leaseEpoch: assignments[0].leaseEpoch,
          }
          if (onTerminalize !== undefined) yield* onTerminalize(result)
          return result
        }),
      )
      .pipe(Effect.mapError(failure))
  return { complete, finalizeOperation, terminalizeAccepted }
}
