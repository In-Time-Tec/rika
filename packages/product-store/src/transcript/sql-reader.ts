import * as ExecutionProjection from "@rika/product/execution-projection"
import type { Projection } from "@rika/product/transcript-page"
import { RepositoryError } from "@rika/product/transcript-repository"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { asc, eq } from "drizzle-orm"
import type * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Effect, Schema } from "effect"
import type { TurnId } from "@rika/product/turn-record"
import { rikaTranscriptCheckpoints, rikaTranscriptUnits, rikaTurns } from "../database/schema/product"
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
  db: PgDrizzle.EffectPgDatabase,
  turnId: TurnId,
): Effect.fn.Return<Projection | undefined, RepositoryError> {
  const rows = yield* db
    .select({
      checkpoint_generation: rikaTranscriptCheckpoints.checkpointGeneration,
      revision: rikaTranscriptCheckpoints.revision,
      projection_version: rikaTranscriptCheckpoints.projectionVersion,
      state_json: rikaTranscriptCheckpoints.stateJson,
      projector_version: rikaTranscriptCheckpoints.projectorVersion,
      projector_cursor: rikaTranscriptCheckpoints.projectorCursor,
      projector_state: rikaTranscriptCheckpoints.projectorState,
      id: rikaTurns.id,
      thread_id: rikaTurns.threadId,
      turn_kind: rikaTurns.turnKind,
      prompt: rikaTurns.prompt,
      status: rikaTurns.status,
      execution_route_json: rikaTurns.executionRouteJson,
      execution_link_json: rikaTurns.executionLinkJson,
      prompt_parts_json: rikaTurns.promptPartsJson,
      shell_command: rikaTurns.shellCommand,
      shell_result_text: rikaTurns.shellResultText,
      shell_result_truncated: rikaTurns.shellResultTruncated,
      shell_result_exit_code: rikaTurns.shellResultExitCode,
      author_json: rikaTurns.authorJson,
      lineage_json: rikaTurns.lineageJson,
      created_at: rikaTurns.createdAt,
      updated_at: rikaTurns.updatedAt,
    })
    .from(rikaTranscriptCheckpoints)
    .innerJoin(rikaTurns, eq(rikaTurns.id, rikaTranscriptCheckpoints.turnId))
    .where(eq(rikaTranscriptCheckpoints.turnId, turnId))
    .pipe(Effect.mapError(error))
  const rawRow = rows[0]
  if (rawRow === undefined) return undefined
  const row = yield* Schema.decodeEffect(ProjectionRow)(rawRow).pipe(Effect.mapError(error))
  const turn = yield* decode(row).pipe(Effect.mapError(error))
  const unitRows = yield* db
    .select({
      unit_key: rikaTranscriptUnits.unitKey,
      unit_order_key: rikaTranscriptUnits.unitOrderKey,
      parent_id: rikaTranscriptUnits.parentId,
      unit_json: rikaTranscriptUnits.unitJson,
    })
    .from(rikaTranscriptUnits)
    .where(eq(rikaTranscriptUnits.turnId, turnId))
    .orderBy(asc(rikaTranscriptUnits.unitOrderKey))
    .pipe(Effect.mapError(error))
  const units = yield* Effect.forEach(unitRows, (raw) =>
    Effect.gen(function* () {
      const unitRow = yield* Schema.decodeEffect(UnitRow)(raw).pipe(Effect.mapError(error))
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
