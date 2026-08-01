import type { ExecutionCheckpoint } from "@rika/product/transcript-page"
import { TurnResult } from "@rika/product/thread-result"
import * as TranscriptCorrelation from "@rika/transcript/child-parent-correlation"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Effect, Schema } from "effect"
import type { Interface } from "@rika/product/transcript-repository"
type CheckpointOptions = {
  readonly executionCheckpoints: ReadonlyArray<import("@rika/product/transcript-page").ExecutionCheckpoint>
  readonly projectionVersion: number
}
type DeltaCheckpointOptions = CheckpointOptions & { readonly expectedGeneration: number | undefined }
type UnitDelta = Parameters<Interface["commitDelta"]>[2]
type RefoldOptions = CheckpointOptions & {
  readonly expectedProjectionVersion: number
  readonly expectedGeneration: number
}

import { SqlClient } from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { Turn, TurnId } from "@rika/product/turn-record"
import { RepositoryError } from "@rika/product/transcript-repository"

import { support } from "./transcript-repository-support"
import { decodeTranscriptExecutionCheckpoint } from "./transcript-checkpoint-codec"

const { error, UnitJson, UsageCursorsJson } = support
type CheckpointError = RepositoryError | Schema.SchemaError | SqlError
type TurnValue = Turn
type ProjectionState = Parameters<Interface["commitDelta"]>[1]
interface CheckpointMethods {
  readonly loadExecutionCheckpoints: (
    turnId: TurnId,
  ) => Effect.Effect<ReadonlyArray<ExecutionCheckpoint>, RepositoryError>
  readonly storeUnit: (turn: TurnValue, unit: TranscriptUnit.Unit) => Effect.Effect<void, CheckpointError>
  readonly checkpointValues: (state: ProjectionState) => Effect.Effect<{ usageCursors: string | null }, CheckpointError>
  readonly storeExecutionCheckpoint: (
    turn: TurnValue,
    checkpoint: ExecutionCheckpoint,
  ) => Effect.Effect<void, CheckpointError>
  readonly commitCheckpoint: (
    turn: TurnValue,
    state: ProjectionState,
    options: DeltaCheckpointOptions,
  ) => Effect.Effect<boolean, CheckpointError>
  readonly replaceCheckpointForRefold: (
    turn: TurnValue,
    state: ProjectionState,
    options: RefoldOptions,
  ) => Effect.Effect<boolean, CheckpointError>
  readonly loadAttachmentUnits: (
    turn: TurnValue,
    delta: UnitDelta,
    checkpoints: ReadonlyArray<ExecutionCheckpoint>,
  ) => Effect.Effect<ReadonlyArray<TranscriptUnit.Unit>, CheckpointError>
  readonly validateDurableUnitRemoval: (turn: TurnValue, key: string) => Effect.Effect<void, CheckpointError>
}

export const makeTranscriptSqliteCheckpoints = (sql: SqlClient): CheckpointMethods => {
  const loadExecutionCheckpoints = Effect.fn("TranscriptRepository.loadExecutionCheckpoints")(function* (
    turnId: TurnId,
  ) {
    const rows = yield* sql`
    SELECT execution_key, execution_id, cursor, sequence, status, revision, model_phase, usable_completion_sequence,
      oldest_cursor, checkpoint_cursor, cost_usd, usage_cursors_json, pricing_version,
      parent_execution_key, parent_unit_key, parent_id, parent_order_key, is_root
    FROM rika_transcript_execution_checkpoints
    WHERE turn_id = ${turnId}
    ORDER BY execution_key COLLATE BINARY
  `.pipe(Effect.mapError(error))
    return yield* Effect.all(
      rows.map((value) => decodeTranscriptExecutionCheckpoint(value).pipe(Effect.mapError(error))),
    )
  })
  const storeUnit = Effect.fn("TranscriptRepository.storeUnit")(function* (turn: TurnValue, unit: TranscriptUnit.Unit) {
    if (!TranscriptOrdering.hasIntrinsicOrder(unit))
      return yield* RepositoryError.make({ message: `Transcript unit ${unit.key} has a non-intrinsic order` })
    const encoded = yield* Schema.encodeEffect(UnitJson)(unit)
    const orderKey = TranscriptOrdering.encodeUnitOrder(unit.order)
    const executionKey = TurnResult.isRecordedShell(turn) ? null : TranscriptCorrelation.executionKey(unit.turnId)
    const rows =
      yield* sql`INSERT INTO rika_transcript_units (turn_id, unit_key, execution_key, thread_id, unit_order_key, tool_id, parent_id, revision, unit_json, created_at, updated_at)
      VALUES (${turn.id}, ${unit.key}, ${executionKey}, ${turn.threadId}, ${orderKey}, ${unit.content._tag === "Block" && unit.content.block._tag === "ToolCall" ? unit.content.block.id : null}, ${unit.parentId ?? null}, ${unit.revision}, ${encoded}, ${turn.createdAt}, ${turn.updatedAt})
      ON CONFLICT(turn_id, unit_key) DO UPDATE SET thread_id = excluded.thread_id,
        unit_order_key = excluded.unit_order_key, revision = excluded.revision, unit_json = excluded.unit_json,
        created_at = excluded.created_at, updated_at = excluded.updated_at
      WHERE rika_transcript_units.unit_order_key = excluded.unit_order_key
        AND rika_transcript_units.execution_key IS excluded.execution_key
        AND rika_transcript_units.tool_id IS excluded.tool_id
        AND rika_transcript_units.parent_id IS excluded.parent_id
      RETURNING unit_key`
    if (rows.length === 0)
      return yield* RepositoryError.make({ message: `Transcript unit ${unit.key} changed its intrinsic identity` })
  }, Effect.mapError(error))
  const checkpointValues = Effect.fn("TranscriptRepository.checkpointValues")(function* (state: ProjectionState) {
    const usageCursors =
      state.usageCursors === undefined ? null : yield* Schema.encodeEffect(UsageCursorsJson)(state.usageCursors)
    return { usageCursors }
  })
  const storeExecutionCheckpoint = Effect.fn("TranscriptRepository.storeExecutionCheckpoint")(function* (
    turn: TurnValue,
    checkpoint: ExecutionCheckpoint,
  ) {
    const values = yield* checkpointValues(checkpoint.state)
    const attachment = checkpoint.attachment
    const rows = yield* sql`INSERT INTO rika_transcript_execution_checkpoints (
      turn_id, execution_key, execution_id, cursor, sequence, status, revision, model_phase, usable_completion_sequence,
      oldest_cursor, checkpoint_cursor, cost_usd, usage_cursors_json, pricing_version,
      parent_execution_key, parent_unit_key, parent_id, parent_order_key, is_root
    ) VALUES (
      ${turn.id}, ${checkpoint.executionKey}, ${checkpoint.executionId}, ${checkpoint.cursor}, ${checkpoint.sequence},
      ${checkpoint.status ?? null}, ${checkpoint.state.revision}, ${checkpoint.state.modelPhase},
      ${checkpoint.state.usableCompletionSequence ?? null},
      ${checkpoint.state.oldestCursor ?? null}, ${checkpoint.state.checkpointCursor ?? null},
      ${checkpoint.state.costUsd ?? null}, ${values.usageCursors}, ${checkpoint.state.pricingVersion ?? null},
      ${attachment?.parentExecutionKey ?? null}, ${attachment?.parentUnitKey ?? null},
      ${attachment?.parentId ?? null}, ${attachment?.parentOrderKey ?? null},
      ${attachment === undefined ? 1 : 0}
    ) ON CONFLICT(turn_id, execution_key) DO UPDATE SET
      cursor = excluded.cursor, sequence = excluded.sequence, status = excluded.status,
      revision = excluded.revision, model_phase = excluded.model_phase,
      usable_completion_sequence = excluded.usable_completion_sequence,
      oldest_cursor = excluded.oldest_cursor, checkpoint_cursor = excluded.checkpoint_cursor,
      cost_usd = excluded.cost_usd, usage_cursors_json = excluded.usage_cursors_json,
      pricing_version = excluded.pricing_version
    WHERE rika_transcript_execution_checkpoints.execution_id = excluded.execution_id
      AND rika_transcript_execution_checkpoints.is_root = excluded.is_root
      AND rika_transcript_execution_checkpoints.parent_execution_key IS excluded.parent_execution_key
      AND rika_transcript_execution_checkpoints.parent_unit_key IS excluded.parent_unit_key
      AND rika_transcript_execution_checkpoints.parent_id IS excluded.parent_id
      AND rika_transcript_execution_checkpoints.parent_order_key IS excluded.parent_order_key
    RETURNING execution_key`
    if (rows.length === 0)
      return yield* RepositoryError.make({
        message: `Execution checkpoint ${checkpoint.executionKey} changed its intrinsic identity`,
      })
  })
  const commitCheckpoint = Effect.fn("TranscriptRepository.commitCheckpoint")(function* (
    turn: TurnValue,
    state: ProjectionState,
    options: DeltaCheckpointOptions,
  ) {
    const values = yield* checkpointValues(state)
    const rows =
      options.expectedGeneration === undefined
        ? yield* sql`INSERT INTO rika_transcript_checkpoints (
          turn_id, thread_id, checkpoint_generation, model_phase, revision, usable_completion_sequence,
          oldest_cursor, checkpoint_cursor, cost_usd, usage_cursors_json, pricing_version, projection_version, updated_at
        ) VALUES (
          ${turn.id}, ${turn.threadId}, 0, ${state.modelPhase}, ${state.revision},
          ${state.usableCompletionSequence ?? null},
          ${state.oldestCursor ?? null}, ${state.checkpointCursor ?? null}, ${state.costUsd ?? null},
          ${values.usageCursors}, ${state.pricingVersion ?? null}, ${options.projectionVersion}, ${turn.updatedAt}
        ) ON CONFLICT(turn_id) DO NOTHING
        RETURNING turn_id`.pipe(Effect.mapError(error))
        : yield* sql`UPDATE rika_transcript_checkpoints SET
          thread_id = ${turn.threadId}, checkpoint_generation = checkpoint_generation + 1,
          model_phase = ${state.modelPhase}, revision = ${state.revision},
          usable_completion_sequence = ${state.usableCompletionSequence ?? null},
          oldest_cursor = ${state.oldestCursor ?? null}, checkpoint_cursor = ${state.checkpointCursor ?? null},
          cost_usd = ${state.costUsd ?? null}, usage_cursors_json = ${values.usageCursors},
          pricing_version = ${state.pricingVersion ?? null}, updated_at = ${turn.updatedAt}
        WHERE turn_id = ${turn.id} AND projection_version = ${options.projectionVersion}
          AND checkpoint_generation = ${options.expectedGeneration} AND revision <= ${state.revision}
        RETURNING turn_id`.pipe(Effect.mapError(error))
    return rows.length > 0
  })
  const replaceCheckpointForRefold = Effect.fn("TranscriptRepository.replaceCheckpointForRefold")(function* (
    turn: TurnValue,
    state: ProjectionState,
    options: RefoldOptions,
  ) {
    const values = yield* checkpointValues(state)
    const rows = yield* sql`UPDATE rika_transcript_checkpoints SET
      thread_id = ${turn.threadId}, checkpoint_generation = checkpoint_generation + 1,
      model_phase = ${state.modelPhase}, revision = ${state.revision},
      usable_completion_sequence = ${state.usableCompletionSequence ?? null},
      oldest_cursor = ${state.oldestCursor ?? null}, checkpoint_cursor = ${state.checkpointCursor ?? null},
      cost_usd = ${state.costUsd ?? null}, usage_cursors_json = ${values.usageCursors},
      pricing_version = ${state.pricingVersion ?? null}, projection_version = ${options.projectionVersion},
      updated_at = ${turn.updatedAt}
    WHERE turn_id = ${turn.id} AND projection_version = ${options.expectedProjectionVersion}
      AND checkpoint_generation = ${options.expectedGeneration}
      AND projection_version < ${options.projectionVersion}
    RETURNING turn_id`.pipe(Effect.mapError(error))
    return rows.length > 0
  })
  const loadAttachmentUnits = Effect.fn("TranscriptRepository.loadAttachmentUnits")(function* (
    turn: TurnValue,
    delta: UnitDelta,
    checkpoints: ReadonlyArray<ExecutionCheckpoint>,
  ) {
    const upsertKeys = new Set(delta.upsert.map((unit) => unit.key))
    const missingParentKeys = [
      ...new Set(
        checkpoints.flatMap((checkpoint) => {
          const attachment = checkpoint.attachment
          if (attachment === undefined || upsertKeys.has(attachment.parentUnitKey)) return []
          return [attachment.parentUnitKey]
        }),
      ),
    ]
    if (missingParentKeys.length === 0) return delta.upsert
    const loaded = yield* Effect.all(
      missingParentKeys.map((key) =>
        Effect.gen(function* () {
          const rows = yield* sql`SELECT unit_json FROM rika_transcript_units
          WHERE turn_id = ${turn.id} AND unit_key = ${key}`
          if (rows.length !== 1)
            return yield* RepositoryError.make({
              message: `Transcript ${turn.id} has no attachment unit for ${key}`,
            })
          const parentJson = yield* Schema.decodeUnknownEffect(Schema.Struct({ unit_json: Schema.String }))(rows[0])
          return yield* Schema.decodeUnknownEffect(UnitJson)(parentJson.unit_json)
        }).pipe(Effect.mapError(error)),
      ),
    )
    return [...delta.upsert, ...loaded]
  })
  const validateDurableUnitRemoval = Effect.fn("TranscriptRepository.validateDurableUnitRemoval")(function* (
    turn: TurnValue,
    key: string,
  ) {
    const rows = yield* sql`SELECT execution_key FROM rika_transcript_execution_checkpoints
    WHERE turn_id = ${turn.id} AND parent_unit_key = ${key}
    LIMIT 1`
    if (rows.length > 0)
      return yield* RepositoryError.make({ message: `Transcript unit ${key} has an attached execution` })
  })
  return {
    loadExecutionCheckpoints,
    storeUnit,
    checkpointValues,
    storeExecutionCheckpoint,
    commitCheckpoint,
    replaceCheckpointForRefold,
    loadAttachmentUnits,
    validateDurableUnitRemoval,
  }
}
