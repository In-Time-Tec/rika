import type * as PgDrizzle from "drizzle-orm/effect-postgres"
import { and, asc, eq, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import {
  ToolOperationLifecycleFrame,
  type ToolOperationLifecycleFrame as ToolOperationLifecycleFrameValue,
} from "@rika/product/tool-operation-lifecycle"
import { rikaHostedExecutorOperationFrames, rikaHostedExecutorOperations } from "../../database/schema/product"
import type { HostedExecutionOperationsService, OperationIdentity } from "./operation-contract"
import { failure, operationKey, operationRows, query } from "./operation-row"

const attributionMatches = (
  operation: Pick<
    OperationIdentity,
    "workspaceId" | "sessionId" | "threadId" | "turnId" | "runId" | "rootRunId" | "toolCallId"
  >,
  frame: ToolOperationLifecycleFrameValue,
) => {
  const attribution = frame.attribution
  return (
    operation.workspaceId === attribution.workspaceId &&
    operation.sessionId === attribution.sessionId &&
    operation.threadId === attribution.threadId &&
    operation.turnId === attribution.turnId &&
    operation.runId === attribution.runId &&
    operation.rootRunId === attribution.rootRunId &&
    operation.toolCallId === attribution.toolCallId
  )
}

const frameFollows = (
  known: ReadonlyArray<ToolOperationLifecycleFrameValue>,
  frame: ToolOperationLifecycleFrameValue,
) => {
  if (frame.cursor !== known.length + 1 || known.some((value) => value._tag === "Terminal")) return false
  if (frame.cursor === 1) return frame._tag === "Accepted"
  if (frame.cursor === 2) return frame._tag === "Started"
  if (frame._tag !== "Output" && frame._tag !== "Terminal") return false
  return frame._tag !== "Output" || known.filter((value) => value._tag === "Output").length < 16
}

export const operationsStore = (db: PgDrizzle.EffectPgDatabase) => {
  const readFrames: HostedExecutionOperationsService["readFrames"] = (input) =>
    query(
      db
        .select({ frame: rikaHostedExecutorOperationFrames.frame })
        .from(rikaHostedExecutorOperationFrames)
        .where(
          and(
            eq(rikaHostedExecutorOperationFrames.assignmentId, input.assignmentId),
            eq(rikaHostedExecutorOperationFrames.operationKey, input.operationKey),
            eq(rikaHostedExecutorOperationFrames.attempt, input.attempt),
          ),
        )
        .orderBy(asc(rikaHostedExecutorOperationFrames.cursor)),
    ).pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          Schema.decodeUnknownEffect(ToolOperationLifecycleFrame)(row.frame).pipe(Effect.mapError(failure)),
        ),
      ),
    )
  const appendFrame: HostedExecutionOperationsService["appendFrame"] = (assignmentId, frame) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const input = {
            assignmentId,
            operationKey: frame.attribution.operationKey,
            attempt: frame.attribution.attempt,
          }
          const operations = yield* query(operationRows.select(tx, input, "update"))
          const operation = operations[0]
          if (operation === undefined) return "invalid-sequence"
          if (!attributionMatches(operation, frame)) return "invalid-sequence"
          const rows = yield* query(
            tx
              .select({ frame: rikaHostedExecutorOperationFrames.frame })
              .from(rikaHostedExecutorOperationFrames)
              .where(
                and(
                  eq(rikaHostedExecutorOperationFrames.assignmentId, assignmentId),
                  eq(rikaHostedExecutorOperationFrames.operationKey, input.operationKey),
                  eq(rikaHostedExecutorOperationFrames.attempt, input.attempt),
                ),
              )
              .orderBy(asc(rikaHostedExecutorOperationFrames.cursor)),
          )
          const known = yield* Effect.forEach(rows, (row) =>
            Schema.decodeUnknownEffect(ToolOperationLifecycleFrame)(row.frame).pipe(Effect.mapError(failure)),
          )
          const existing = known.find((value) => value.cursor === frame.cursor)
          if (existing !== undefined)
            return Schema.toEquivalence(ToolOperationLifecycleFrame)(existing, frame) ? "duplicate" : "invalid-sequence"
          if (operation.state === "completed" || operation.state === "unknown") return "already-terminal"
          if (operation.state !== "dispatched" || !frameFollows(known, frame)) return "invalid-sequence"
          yield* query(
            tx.insert(rikaHostedExecutorOperationFrames).values({
              assignmentId,
              operationKey: input.operationKey,
              attempt: input.attempt,
              cursor: frame.cursor,
              kind: frame._tag,
              frame,
            }),
          )
          if (frame._tag === "Started")
            yield* query(
              tx
                .update(rikaHostedExecutorOperations)
                .set({
                  startedAt: sql`coalesce(${rikaHostedExecutorOperations.startedAt}, clock_timestamp())`,
                  updatedAt: sql`clock_timestamp()`,
                })
                .where(and(operationKey(input), eq(rikaHostedExecutorOperations.state, "dispatched"))),
            )
          return "appended"
        }),
      )
      .pipe(Effect.mapError(failure))
  const terminalFrame: HostedExecutionOperationsService["terminalFrame"] = (input) =>
    query(
      db
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
    ).pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.void.pipe(
              Effect.as<Extract<ToolOperationLifecycleFrameValue, { readonly _tag: "Terminal" }> | undefined>(
                undefined,
              ),
            )
          : Schema.decodeUnknownEffect(ToolOperationLifecycleFrame)(rows[0].frame).pipe(
              Effect.mapError(failure),
              Effect.flatMap((frame) =>
                frame._tag === "Terminal"
                  ? Effect.succeed(frame)
                  : Effect.fail(failure("Terminal frame kind is invalid")),
              ),
            ),
      ),
    )
  const terminalRecoveryScan: HostedExecutionOperationsService["terminalRecoveryScan"] = query(
    db
      .select({
        assignmentId: rikaHostedExecutorOperations.assignmentId,
        operationKey: rikaHostedExecutorOperations.operationKey,
        attempt: rikaHostedExecutorOperations.attempt,
        frame: rikaHostedExecutorOperationFrames.frame,
      })
      .from(rikaHostedExecutorOperations)
      .innerJoin(
        rikaHostedExecutorOperationFrames,
        and(
          eq(rikaHostedExecutorOperationFrames.assignmentId, rikaHostedExecutorOperations.assignmentId),
          eq(rikaHostedExecutorOperationFrames.operationKey, rikaHostedExecutorOperations.operationKey),
          eq(rikaHostedExecutorOperationFrames.attempt, rikaHostedExecutorOperations.attempt),
          eq(rikaHostedExecutorOperationFrames.kind, "Terminal"),
        ),
      )
      .where(eq(rikaHostedExecutorOperations.state, "dispatched"))
      .orderBy(asc(rikaHostedExecutorOperations.updatedAt), asc(rikaHostedExecutorOperations.operationKey))
      .limit(32),
  ).pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(rows, (row) =>
        Schema.decodeUnknownEffect(ToolOperationLifecycleFrame)(row.frame).pipe(
          Effect.mapError(failure),
          Effect.flatMap((frame) =>
            frame._tag === "Terminal"
              ? Effect.succeed({ ...row, frame })
              : Effect.fail(failure("Terminal frame kind is invalid")),
          ),
        ),
      ),
    ),
  )
  const replayQueue: HostedExecutionOperationsService["replayQueue"] = (assignmentId) =>
    query(
      db
        .select({
          operationKey: rikaHostedExecutorOperations.operationKey,
          attempt: rikaHostedExecutorOperations.attempt,
          afterCursor: sql<string>`coalesce(max(${rikaHostedExecutorOperationFrames.cursor}), 0)::text`,
        })
        .from(rikaHostedExecutorOperations)
        .leftJoin(
          rikaHostedExecutorOperationFrames,
          and(
            eq(rikaHostedExecutorOperationFrames.assignmentId, rikaHostedExecutorOperations.assignmentId),
            eq(rikaHostedExecutorOperationFrames.operationKey, rikaHostedExecutorOperations.operationKey),
            eq(rikaHostedExecutorOperationFrames.attempt, rikaHostedExecutorOperations.attempt),
          ),
        )
        .where(
          and(
            eq(rikaHostedExecutorOperations.assignmentId, assignmentId),
            eq(rikaHostedExecutorOperations.state, "dispatched"),
          ),
        )
        .groupBy(rikaHostedExecutorOperations.operationKey, rikaHostedExecutorOperations.attempt)
        .orderBy(rikaHostedExecutorOperations.operationKey, rikaHostedExecutorOperations.attempt),
    ).pipe(Effect.map((rows) => rows.map((row) => ({ ...row, afterCursor: Number(row.afterCursor) }))))
  return { readFrames, appendFrame, terminalFrame, terminalRecoveryScan, replayQueue }
}
