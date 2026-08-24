import * as ExecutionProjection from "@rika/product/execution-projection"
import type { Projection } from "@rika/product/transcript-page"
import { RepositoryError } from "@rika/product/transcript-repository"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import type { TurnId } from "@rika/product/turn-record"
import { decode } from "../turn/postgres/row-codec"

const UnitJson = Schema.fromJsonString(TranscriptUnit.Unit)
const TurnRow = Schema.Struct({
  id: Schema.String,
  thread_id: Schema.String,
  turn_kind: Schema.String,
  prompt: Schema.String,
  status: Schema.String,
  execution_route_json: Schema.NullOr(Schema.String),
  execution_link_json: Schema.optionalKey(Schema.NullOr(Schema.String)),
  prompt_parts_json: Schema.optionalKey(Schema.NullOr(Schema.String)),
  shell_command: Schema.NullOr(Schema.String),
  shell_result_text: Schema.NullOr(Schema.String),
  shell_result_truncated: Schema.NullOr(Schema.Finite),
  shell_result_exit_code: Schema.NullOr(Schema.Finite),
  author_json: Schema.String,
  lineage_json: Schema.String,
  created_at: Schema.Finite,
  updated_at: Schema.Finite,
})
const ProjectionRow = Schema.Struct({
  ...TurnRow.fields,
  checkpoint_generation: Schema.Finite,
  revision: Schema.Finite,
  projection_version: Schema.Finite,
  state_json: Schema.String,
  projector_version: Schema.NullOr(Schema.Finite),
  projector_cursor: Schema.NullOr(Schema.String),
  projector_state: Schema.NullOr(Schema.String),
})
const UnitRow = Schema.Struct({
  unit_key: Schema.String,
  unit_order_key: Schema.String,
  parent_id: Schema.NullOr(Schema.String),
  unit_json: Schema.String,
})
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
  const rawRow = rows[0]
  if (rawRow === undefined) return undefined
  const row = yield* Schema.decodeUnknownEffect(ProjectionRow)(rawRow).pipe(Effect.mapError(error))
  const turn = yield* decode(row).pipe(Effect.mapError(error))
  const unitRows = yield* sql`SELECT unit_key, unit_order_key, parent_id, unit_json
    FROM rika_transcript_units WHERE turn_id = ${turnId} ORDER BY unit_order_key ASC`.pipe(Effect.mapError(error))
  const units = yield* Effect.forEach(unitRows, (raw) =>
    Effect.gen(function* () {
      const unitRow = yield* Schema.decodeUnknownEffect(UnitRow)(raw).pipe(Effect.mapError(error))
      const unit = yield* Schema.decodeEffect(UnitJson)(unitRow.unit_json).pipe(Effect.mapError(error))
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
  const state = yield* Schema.decodeEffect(Schema.fromJsonString(ExecutionProjection.ProjectionState))(
    row.state_json,
  ).pipe(Effect.mapError(error))
  const projectorValues = [row.projector_version, row.projector_cursor, row.projector_state]
  if (projectorValues.some((value) => value !== null) && projectorValues.some((value) => value === null))
    return yield* RepositoryError.make({ message: `Transcript ${turnId} has a partial projector checkpoint` })
  const projectorCheckpoint =
    Number(row.projector_version) === ExecutionProjection.projectionVersion
      ? {
          version: ExecutionProjection.projectionVersion,
          cursor: String(row.projector_cursor),
          state: String(row.projector_state),
        }
      : undefined
  const projection: Projection = {
    turn,
    units,
    checkpointGeneration: Number(row.checkpoint_generation),
    revision: Number(row.revision),
    state,
    projectionVersion: Number(row.projection_version),
  }
  if (projectorCheckpoint !== undefined) Object.assign(projection, { projectorCheckpoint })
  return projection
})
