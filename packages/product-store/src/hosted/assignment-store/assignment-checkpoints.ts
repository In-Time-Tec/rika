import { Effect, Schema } from "effect"
import { and, eq, sql as expression } from "drizzle-orm"
import type { WorkspaceCheckpointManifest } from "@rika/product/executor-assignment"
import type { AssignmentsService } from "@rika/product/executor-assignments"
import { JsonObject } from "@rika/product/hosted-model"
import { rikaHostedCheckpoints, rikaHostedExecutorAssignments } from "../../database/schema/product"
import { checkpointRow, decodeCheckpoint } from "./assignment-row"
import type { AssignmentOperations } from "./assignment-operations"

const metadataEquivalent = Schema.toEquivalence(JsonObject)

export const checkpointOperations = (operations: AssignmentOperations) => {
  const { checkAccess, db, failure, locked, query, transaction } = operations
  const checkpointById = (executor: typeof db, checkpointId: string) =>
    query(executor.select().from(rikaHostedCheckpoints).where(eq(rikaHostedCheckpoints.id, checkpointId))).pipe(
      Effect.map((rows) => rows.map(checkpointRow)),
    )

  const checkpointMatches = (
    checkpoint: WorkspaceCheckpointManifest,
    input: Parameters<AssignmentsService["commitCheckpoint"]>[0],
  ) =>
    checkpoint.assignmentId === input.access.assignmentId &&
    checkpoint.assignmentGeneration === input.access.assignmentGeneration &&
    checkpoint.leaseEpoch === input.access.leaseEpoch &&
    checkpoint.objectKey === input.objectKey &&
    checkpoint.contentDigest === input.contentDigest &&
    checkpoint.sizeBytes === input.sizeBytes &&
    checkpoint.format === input.format &&
    checkpoint.cursor.sequence === input.cursor.sequence &&
    checkpoint.cursor.value === input.cursor.value &&
    metadataEquivalent(checkpoint.metadata, input.metadata)

  const commitCheckpoint: AssignmentsService["commitCheckpoint"] = Effect.fn("Assignments.commitCheckpoint")(
    function* (input) {
      return yield* transaction((tx) =>
        Effect.gen(function* () {
          const row = yield* locked(tx, input.access.assignmentId, "update")
          yield* checkAccess(row, input.access, true)
          if (input.cursor.sequence !== row.cursorSequence || input.cursor.value !== row.cursorValue)
            return yield* failure("conflict", "Checkpoint cursor is not the acknowledged executor cursor")
          const existingRow = (yield* checkpointById(tx, input.id))[0]
          if (existingRow !== undefined) {
            const existing = yield* decodeCheckpoint(existingRow)
            return checkpointMatches(existing, input)
              ? existing
              : yield* failure("conflict", "Checkpoint identity has different content")
          }
          if (row.executorInstanceId === null || row.leaseEpoch === null)
            return yield* failure("stale-fence", "Executor assignment fence is stale")
          const inserted = yield* query(
            tx
              .insert(rikaHostedCheckpoints)
              .values({
                id: input.id,
                ownerId: row.ownerId,
                threadId: row.threadId,
                assignmentId: row.id,
                executorInstanceId: row.executorInstanceId,
                assignmentGeneration: Number(row.generation),
                leaseEpoch: Number(row.leaseEpoch),
                objectKey: input.objectKey,
                contentDigest: input.contentDigest,
                sizeBytes: input.sizeBytes,
                format: input.format,
                cursorSequence: Number(input.cursor.sequence),
                cursorValue: input.cursor.value,
                metadata: input.metadata,
              })
              .onConflictDoNothing({ target: rikaHostedCheckpoints.id })
              .returning({ id: rikaHostedCheckpoints.id }),
          )
          if (inserted[0] === undefined) return yield* failure("conflict", "Checkpoint identity has different content")
          const update = yield* query(
            tx
              .update(rikaHostedExecutorAssignments)
              .set({
                revision: expression`${rikaHostedExecutorAssignments.revision} + 1`,
                latestCheckpointId: input.id,
                updatedAt: expression`transaction_timestamp()`,
              })
              .where(
                and(
                  eq(rikaHostedExecutorAssignments.id, row.id),
                  eq(rikaHostedExecutorAssignments.generation, Number(row.generation)),
                  eq(rikaHostedExecutorAssignments.revision, Number(row.revision)),
                ),
              )
              .returning({ id: rikaHostedExecutorAssignments.id }),
          )
          if (update[0] === undefined) return yield* failure("conflict", "Executor assignment changed concurrently")
          const committed = (yield* checkpointById(tx, input.id))[0]
          if (committed === undefined) return yield* failure("database", "Committed checkpoint does not exist")
          return yield* decodeCheckpoint(committed)
        }),
      )
    },
  )

  const latestCheckpoint: AssignmentsService["latestCheckpoint"] = Effect.fn("Assignments.latestCheckpoint")(
    function* (assignmentId) {
      const rows = yield* query(
        db
          .select({ checkpoint: rikaHostedCheckpoints })
          .from(rikaHostedExecutorAssignments)
          .innerJoin(
            rikaHostedCheckpoints,
            eq(rikaHostedCheckpoints.id, rikaHostedExecutorAssignments.latestCheckpointId),
          )
          .where(eq(rikaHostedExecutorAssignments.id, assignmentId)),
      )
      return rows[0] === undefined ? undefined : yield* decodeCheckpoint(checkpointRow(rows[0].checkpoint))
    },
  )

  return { commitCheckpoint, latestCheckpoint }
}
