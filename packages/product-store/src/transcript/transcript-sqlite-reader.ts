import type { ExecutionCheckpoint } from "@rika/product/transcript-page"
import type { Projection } from "@rika/product/transcript-page"
import { TurnResult } from "@rika/product/thread-result"
import * as TranscriptCorrelation from "@rika/transcript/child-parent-correlation"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptProjectionModel from "@rika/transcript/transcript-projection-model"
import { Effect, Schema } from "effect"
import type { SqlClient as SqlClientType } from "effect/unstable/sql/SqlClient"
import { TurnId } from "@rika/product/turn-record"

import { invalidatedProjectionVersion, RepositoryError } from "@rika/product/transcript-repository"
import { decode } from "../turn/turn-row-codec"
import { TranscriptCheckpointRow } from "./transcript-checkpoint-codec"
import { TranscriptStoredUnitRow } from "./transcript-unit-row-codec"
import { support } from "./transcript-repository-support"

const {
  error,
  validateUnits,
  validateRecordedShellProjection,
  withUnits,
  validateProjectionVersion,
  validateStateScalars,
  validateCheckpoint,
  validateAttachmentSet,
  UnitJson,
  UsageCursorsJson,
} = support

export const readTranscriptProjection = (
  sql: SqlClientType,
  turnId: TurnId,
  loadExecutionCheckpoints: (turnId: TurnId) => Effect.Effect<ReadonlyArray<ExecutionCheckpoint>, RepositoryError>,
) =>
  Effect.gen(function* () {
    const checkpointRows = yield* sql`
      SELECT c.checkpoint_generation, c.model_phase, c.revision, c.usable_completion_sequence,
        c.oldest_cursor, c.checkpoint_cursor, c.cost_usd, c.usage_cursors_json,
        c.pricing_version, c.projection_version, t.*
      FROM rika_transcript_checkpoints c
      JOIN rika_turns t ON t.id = c.turn_id
      WHERE c.turn_id = ${turnId}
    `.pipe(Effect.mapError(error))
    if (checkpointRows[0] === undefined) return undefined
    const row = yield* Schema.decodeUnknownEffect(TranscriptCheckpointRow)(checkpointRows[0]).pipe(
      Effect.mapError(error),
    )
    const turn = yield* decode(checkpointRows[0]).pipe(Effect.mapError(error))
    const unitRows = yield* sql`
      SELECT unit_key, execution_key, turn_id, parent_id, tool_id, unit_json, unit_order_key
      FROM rika_transcript_units
      WHERE turn_id = ${turnId}
      ORDER BY unit_order_key ASC
    `.pipe(Effect.mapError(error))
    const units = yield* Effect.all(
      unitRows.map((value) =>
        Schema.decodeUnknownEffect(TranscriptStoredUnitRow)(value).pipe(
          Effect.flatMap((unitRow) =>
            Schema.decodeUnknownEffect(UnitJson)(unitRow.unit_json).pipe(
              Effect.filterOrFail(
                (unit) => {
                  const toolId =
                    unit.content._tag === "Block" && unit.content.block._tag === "ToolCall"
                      ? unit.content.block.id
                      : null
                  return (
                    unit.key === unitRow.unit_key &&
                    (TurnResult.isRecordedShell(turn) ? null : TranscriptCorrelation.executionKey(unit.turnId)) ===
                      unitRow.execution_key &&
                    TranscriptOrdering.hasIntrinsicOrder(unit) &&
                    TranscriptOrdering.encodeUnitOrder(unit.order) === unitRow.unit_order_key &&
                    (unit.parentId ?? null) === unitRow.parent_id &&
                    toolId === unitRow.tool_id
                  )
                },
                () => RepositoryError.make({ message: "Transcript unit identity does not match its durable key" }),
              ),
            ),
          ),
          Effect.mapError(error),
        ),
      ),
    )
    yield* validateUnits(units)
    const executionCheckpoints = yield* loadExecutionCheckpoints(turnId)
    const usageCursors =
      row.usage_cursors_json === null
        ? undefined
        : yield* Schema.decodeUnknownEffect(UsageCursorsJson)(row.usage_cursors_json).pipe(Effect.mapError(error))
    const state: TranscriptProjectionModel.ProjectionState = {
      revision: row.revision,
      modelPhase: row.model_phase,
      ...(row.usable_completion_sequence === null ? {} : { usableCompletionSequence: row.usable_completion_sequence }),
      ...(row.oldest_cursor === null ? {} : { oldestCursor: row.oldest_cursor }),
      ...(row.checkpoint_cursor === null ? {} : { checkpointCursor: row.checkpoint_cursor }),
      ...(row.cost_usd === null ? {} : { costUsd: row.cost_usd }),
      ...(usageCursors === undefined ? {} : { usageCursors }),
      ...(row.pricing_version === null ? {} : { pricingVersion: row.pricing_version }),
    }
    yield* validateProjectionVersion(turn.id, row.projection_version)
    yield* validateStateScalars(turn.id, "root projection", state)
    const invalidatedEmpty =
      row.projection_version === invalidatedProjectionVersion && units.length === 0 && executionCheckpoints.length === 0
    if (TurnResult.isRecordedShell(turn)) {
      if (executionCheckpoints.length !== 0)
        return yield* RepositoryError.make({ message: `Recorded shell turn ${turn.id} has execution checkpoints` })
      yield* validateRecordedShellProjection(turn, withUnits(state, units), row.projection_version)
    } else if (!invalidatedEmpty) {
      yield* validateCheckpoint(turn, state, { executionCheckpoints, projectionVersion: row.projection_version }, true)
      yield* validateAttachmentSet(turn, units, executionCheckpoints)
    }
    return {
      turn,
      units,
      checkpointGeneration: row.checkpoint_generation,
      revision: state.revision,
      modelPhase: state.modelPhase,
      usableCompletionSequence: state.usableCompletionSequence,
      oldestCursor: state.oldestCursor,
      checkpointCursor: state.checkpointCursor,
      costUsd: state.costUsd,
      usageCursors: state.usageCursors,
      pricingVersion: state.pricingVersion,
      executionCheckpoints,
      projectionVersion: row.projection_version,
    } satisfies Projection
  })
