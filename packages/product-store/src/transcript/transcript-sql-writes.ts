import type { Projection } from "@rika/product/transcript-page"
import type { TurnId } from "@rika/product/turn-record"
import * as ExecutionProjection from "@rika/product/execution-projection"
import { RepositoryError, type Interface } from "@rika/product/transcript-repository"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Clock, Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql/SqlClient"

const error = (cause: unknown) =>
  Schema.is(RepositoryError)(cause) ? cause : RepositoryError.make({ message: String(cause) })
const encodeState = Schema.encodeSync(Schema.fromJsonString(ExecutionProjection.ProjectionState))
const encodeUnit = Schema.encodeSync(Schema.fromJsonString(TranscriptUnit.Unit))
const validateUnits = (turnId: string, units: ReadonlyArray<TranscriptUnit.Unit>) =>
  Effect.gen(function* () {
    const keys = new Set<string>()
    const orders = new Set<string>()
    for (const unit of units) {
      const order = TranscriptOrdering.encodeUnitOrder(unit.order)
      if (
        unit.turnId !== turnId ||
        !TranscriptOrdering.hasIntrinsicOrder(unit) ||
        keys.has(unit.key) ||
        orders.has(order)
      )
        return yield* RepositoryError.make({ message: `Transcript unit ${unit.key} is invalid or duplicated` })
      keys.add(unit.key)
      orders.add(order)
    }
  })

export const transcriptSqlWrites = {
  make: (
    sql: SqlClient,
    get: (turnId: TurnId) => Effect.Effect<Projection | undefined, RepositoryError>,
  ): Pick<Interface, "commitProjection" | "replaceUnits"> => ({
    commitProjection: Effect.fn("TranscriptRepository.commitProjection")(function* (turn, change) {
      const upserts = change._tag === "ProjectionSnapshot" ? change.units : change.upsert
      yield* validateUnits(turn.id, upserts)
      const clock = yield* Clock.Clock
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const checkpoint = change.checkpoint
            const now = clock.currentTimeMillisUnsafe()
            const rows =
              change._tag === "ProjectionSnapshot"
                ? yield* sql`INSERT INTO rika_transcript_checkpoints (
              turn_id, thread_id, checkpoint_generation, revision, projection_version, state_json,
              projector_version, projector_cursor, projector_state, updated_at
            ) VALUES (
              ${turn.id}, ${turn.threadId}, 0, ${change.revision}, ${ExecutionProjection.projectionVersion}, ${encodeState(change.state)},
              ${checkpoint?.version ?? null}, ${checkpoint?.cursor ?? null}, ${checkpoint?.state ?? null}, ${now}
            ) ON CONFLICT(turn_id) DO UPDATE SET
              checkpoint_generation = rika_transcript_checkpoints.checkpoint_generation + 1,
              revision = excluded.revision,
              projection_version = excluded.projection_version,
              state_json = excluded.state_json,
              projector_version = excluded.projector_version,
              projector_cursor = excluded.projector_cursor,
              projector_state = excluded.projector_state,
              updated_at = excluded.updated_at
            WHERE rika_transcript_checkpoints.revision <= excluded.revision
            RETURNING turn_id`
                : yield* sql`UPDATE rika_transcript_checkpoints SET
              checkpoint_generation = checkpoint_generation + 1,
              revision = ${change.revision}, projection_version = ${ExecutionProjection.projectionVersion},
              state_json = ${encodeState(change.state)},
              projector_version = ${change.checkpoint.version}, projector_cursor = ${change.checkpoint.cursor},
              projector_state = ${change.checkpoint.state}, updated_at = ${now}
            WHERE turn_id = ${turn.id} AND revision = ${change.baseRevision}
            RETURNING turn_id`
            if (rows.length === 0) return "stale" as const
            if (change._tag === "ProjectionSnapshot" && !change.hasOlder)
              yield* sql`DELETE FROM rika_transcript_units WHERE turn_id = ${turn.id}`
            for (const key of change._tag === "ProjectionPatch" ? change.remove : [])
              yield* sql`DELETE FROM rika_transcript_units WHERE turn_id = ${turn.id} AND unit_key = ${key}`
            for (const unit of upserts) {
              const order = TranscriptOrdering.encodeUnitOrder(unit.order)
              yield* sql`INSERT INTO rika_transcript_units (
              turn_id, unit_key, thread_id, unit_order_key, parent_id, revision, unit_json, created_at, updated_at
            ) VALUES (
              ${turn.id}, ${unit.key}, ${turn.threadId}, ${order}, ${unit.parentId ?? null},
              ${unit.revision}, ${encodeUnit(unit)}, ${turn.createdAt}, ${now}
            ) ON CONFLICT(turn_id, unit_key) DO UPDATE SET
              revision = excluded.revision, unit_json = excluded.unit_json,
              parent_id = excluded.parent_id, updated_at = excluded.updated_at
            WHERE rika_transcript_units.unit_order_key = excluded.unit_order_key`
            }
            return "committed" as const
          }),
        )
        .pipe(Effect.mapError(error))
    }),
    replaceUnits: Effect.fn("TranscriptRepository.replaceUnits")(function* (turn, units) {
      yield* validateUnits(turn.id, units)
      const clock = yield* Clock.Clock
      const status =
        turn.status === "queued" || turn.status === "accepted" || turn.status === "cancelling" ? "running" : turn.status
      const state = {
        status,
        usage: {
          ...ExecutionProjection.emptyUsageState(),
          sourceComplete: status === "completed" || status === "failed" || status === "cancelled",
        },
        steering: { steeringMessages: 0, followUpMessages: 0 },
      }
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const now = clock.currentTimeMillisUnsafe()
            const revision = units.reduce((maximum, unit) => Math.max(maximum, unit.revision), 0)
            yield* sql`INSERT INTO rika_transcript_checkpoints (
            turn_id, thread_id, checkpoint_generation, revision, projection_version, state_json,
            projector_version, projector_cursor, projector_state, updated_at
          ) VALUES (
            ${turn.id}, ${turn.threadId}, 0, ${revision}, ${ExecutionProjection.projectionVersion}, ${encodeState(state)},
            NULL, NULL, NULL, ${now}
          ) ON CONFLICT(turn_id) DO UPDATE SET
            checkpoint_generation = rika_transcript_checkpoints.checkpoint_generation + 1,
            revision = excluded.revision,
            projection_version = excluded.projection_version, state_json = excluded.state_json,
            projector_version = NULL, projector_cursor = NULL, projector_state = NULL, updated_at = excluded.updated_at`
            yield* sql`DELETE FROM rika_transcript_units WHERE turn_id = ${turn.id}`
            for (const unit of units) {
              const order = TranscriptOrdering.encodeUnitOrder(unit.order)
              yield* sql`INSERT INTO rika_transcript_units (
              turn_id, unit_key, thread_id, unit_order_key, parent_id, revision, unit_json, created_at, updated_at
            ) VALUES (
              ${turn.id}, ${unit.key}, ${turn.threadId}, ${order}, ${unit.parentId ?? null},
              ${unit.revision}, ${encodeUnit(unit)}, ${turn.createdAt}, ${now}
            )`
            }
          }),
        )
        .pipe(Effect.mapError(error))
      const stored = yield* get(turn.id)
      if (stored === undefined) return yield* RepositoryError.make({ message: `Transcript ${turn.id} was not stored` })
      return stored
    }),
  }),
}
