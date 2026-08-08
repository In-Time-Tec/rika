import * as ExecutionProjection from "@rika/product/execution-projection"
import type { Projection } from "@rika/product/transcript-page"
import { RepositoryError } from "@rika/product/transcript-repository"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import type { TurnId } from "@rika/product/turn-record"
import { decode } from "../turn/turn-row-codec"

const UnitJson = Schema.fromJsonString(TranscriptUnit.Unit)
const error = (cause: unknown) =>
  Schema.is(RepositoryError)(cause) ? cause : RepositoryError.make({ message: String(cause) })

export const readTranscriptProjection = Effect.fn("TranscriptRepository.read")(function* (
  sql: SqlClient,
  turnId: TurnId,
): Effect.fn.Return<Projection | undefined, RepositoryError> {
  const rows = yield* sql`SELECT c.checkpoint_generation, c.revision, c.projection_version,
      c.state_json, c.projector_version, c.projector_cursor, c.projector_state, t.*
    FROM rika_transcript_checkpoints c
    JOIN rika_turns t ON t.id = c.turn_id
    WHERE c.turn_id = ${turnId}`.pipe(Effect.mapError(error))
  const row = rows[0] as Record<string, unknown> | undefined
  if (row === undefined) return undefined
  const turn = yield* decode(row).pipe(Effect.mapError(error))
  const unitRows = yield* sql`SELECT unit_key, unit_order_key, parent_id, unit_json
    FROM rika_transcript_units WHERE turn_id = ${turnId} ORDER BY unit_order_key ASC`.pipe(Effect.mapError(error))
  const units = yield* Effect.forEach(unitRows, (raw) =>
    Effect.gen(function* () {
      const unitRow = raw as Record<string, unknown>
      const unit = yield* Schema.decodeUnknownEffect(UnitJson)(unitRow.unit_json).pipe(Effect.mapError(error))
      if (
        unit.key !== unitRow.unit_key ||
        unit.turnId !== turnId ||
        TranscriptOrdering.encodeUnitOrder(unit.order) !== unitRow.unit_order_key ||
        (unit.parentId ?? null) !== unitRow.parent_id ||
        !TranscriptOrdering.hasIntrinsicOrder(unit)
      )
        return yield* RepositoryError.make({
          message: `Transcript unit ${unit.key} does not match its durable identity`,
        })
      return unit
    }),
  )
  const state = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ExecutionProjection.ProjectionState))(
    row.state_json,
  ).pipe(Effect.mapError(error))
  const projectorValues = [row.projector_version, row.projector_cursor, row.projector_state]
  if (projectorValues.some((value) => value !== null) && projectorValues.some((value) => value === null))
    return yield* RepositoryError.make({ message: `Transcript ${turnId} has a partial projector checkpoint` })
  const projectorCheckpoint =
    row.projector_version === null
      ? undefined
      : {
          version: row.projector_version as 1,
          cursor: String(row.projector_cursor),
          state: String(row.projector_state),
        }
  return {
    turn,
    units,
    checkpointGeneration: Number(row.checkpoint_generation),
    revision: Number(row.revision),
    state,
    ...(projectorCheckpoint === undefined ? {} : { projectorCheckpoint }),
    projectionVersion: Number(row.projection_version),
  }
})
