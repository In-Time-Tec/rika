import type { Projection } from "@rika/product/transcript-page"

import type { TurnId } from "@rika/product/turn-record"
import * as ExecutionProjection from "@rika/product/execution-projection"
import { RepositoryError, type Interface } from "@rika/product/transcript-repository"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { and, eq, lte, sql } from "drizzle-orm"
import type * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Clock, Effect, Schema } from "effect"
import { rikaTranscriptCheckpoints, rikaTranscriptUnits } from "../database/schema/product"

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
    db: PgDrizzle.EffectPgDatabase,
    get: (turnId: TurnId) => Effect.Effect<Projection | undefined, RepositoryError>,
  ): Pick<Interface, "commitProjection" | "replaceUnits"> => ({
    commitProjection: Effect.fn("TranscriptRepository.commitProjection")(function* (turn, change) {
      const upserts = change._tag === "ProjectionSnapshot" ? change.units : change.upsert
      yield* validateUnits(turn.id, upserts)
      const clock = yield* Clock.Clock
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const checkpoint = change.checkpoint
            const now = clock.currentTimeMillisUnsafe()
            const rows =
              change._tag === "ProjectionSnapshot"
                ? yield* tx
                    .insert(rikaTranscriptCheckpoints)
                    .values({
                      turnId: turn.id,
                      threadId: turn.threadId,
                      checkpointGeneration: 0,
                      revision: change.revision,
                      projectionVersion: ExecutionProjection.projectionVersion,
                      stateJson: encodeState(change.state),
                      projectorVersion: checkpoint?.version ?? null,
                      projectorCursor: checkpoint?.cursor ?? null,
                      projectorState: checkpoint?.state ?? null,
                      updatedAt: now,
                    })
                    .onConflictDoUpdate({
                      target: rikaTranscriptCheckpoints.turnId,
                      set: {
                        checkpointGeneration: sql`${rikaTranscriptCheckpoints.checkpointGeneration} + 1`,
                        revision: sql`excluded.revision`,
                        projectionVersion: sql`excluded.projection_version`,
                        stateJson: sql`excluded.state_json`,
                        projectorVersion: sql`excluded.projector_version`,
                        projectorCursor: sql`excluded.projector_cursor`,
                        projectorState: sql`excluded.projector_state`,
                        updatedAt: sql`excluded.updated_at`,
                      },
                      setWhere: lte(rikaTranscriptCheckpoints.revision, sql`excluded.revision`),
                    })
                    .returning({ turnId: rikaTranscriptCheckpoints.turnId })
                : yield* tx
                    .update(rikaTranscriptCheckpoints)
                    .set({
                      checkpointGeneration: sql`${rikaTranscriptCheckpoints.checkpointGeneration} + 1`,
                      revision: change.revision,
                      projectionVersion: ExecutionProjection.projectionVersion,
                      stateJson: encodeState(change.state),
                      projectorVersion: change.checkpoint.version,
                      projectorCursor: change.checkpoint.cursor,
                      projectorState: change.checkpoint.state,
                      updatedAt: now,
                    })
                    .where(
                      and(
                        eq(rikaTranscriptCheckpoints.turnId, turn.id),
                        eq(rikaTranscriptCheckpoints.revision, change.baseRevision),
                      ),
                    )
                    .returning({ turnId: rikaTranscriptCheckpoints.turnId })
            if (rows.length === 0) return "stale" as const
            if (change._tag === "ProjectionSnapshot" && !change.hasOlder)
              yield* tx.delete(rikaTranscriptUnits).where(eq(rikaTranscriptUnits.turnId, turn.id))
            for (const key of change._tag === "ProjectionPatch" ? change.remove : [])
              yield* tx
                .delete(rikaTranscriptUnits)
                .where(and(eq(rikaTranscriptUnits.turnId, turn.id), eq(rikaTranscriptUnits.unitKey, key)))
            for (const unit of upserts) {
              const order = TranscriptOrdering.encodeUnitOrder(unit.order)
              yield* tx
                .insert(rikaTranscriptUnits)
                .values({
                  turnId: turn.id,
                  unitKey: unit.key,
                  threadId: turn.threadId,
                  unitOrderKey: order,
                  parentId: unit.parentId ?? null,
                  revision: unit.revision,
                  unitJson: encodeUnit(unit),
                  createdAt: turn.createdAt,
                  updatedAt: now,
                })
                .onConflictDoUpdate({
                  target: [rikaTranscriptUnits.turnId, rikaTranscriptUnits.unitKey],
                  set: {
                    revision: sql`excluded.revision`,
                    unitJson: sql`excluded.unit_json`,
                    parentId: sql`excluded.parent_id`,
                    updatedAt: sql`excluded.updated_at`,
                  },
                  setWhere: eq(rikaTranscriptUnits.unitOrderKey, sql`excluded.unit_order_key`),
                })
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
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const now = clock.currentTimeMillisUnsafe()
            const revision = units.reduce((maximum, unit) => Math.max(maximum, unit.revision), 0)
            yield* tx
              .insert(rikaTranscriptCheckpoints)
              .values({
                turnId: turn.id,
                threadId: turn.threadId,
                checkpointGeneration: 0,
                revision,
                projectionVersion: ExecutionProjection.projectionVersion,
                stateJson: encodeState(state),
                projectorVersion: null,
                projectorCursor: null,
                projectorState: null,
                updatedAt: now,
              })
              .onConflictDoUpdate({
                target: rikaTranscriptCheckpoints.turnId,
                set: {
                  checkpointGeneration: sql`${rikaTranscriptCheckpoints.checkpointGeneration} + 1`,
                  revision: sql`excluded.revision`,
                  projectionVersion: sql`excluded.projection_version`,
                  stateJson: sql`excluded.state_json`,
                  projectorVersion: null,
                  projectorCursor: null,
                  projectorState: null,
                  updatedAt: sql`excluded.updated_at`,
                },
              })
            yield* tx.delete(rikaTranscriptUnits).where(eq(rikaTranscriptUnits.turnId, turn.id))
            for (const unit of units) {
              const order = TranscriptOrdering.encodeUnitOrder(unit.order)
              yield* tx.insert(rikaTranscriptUnits).values({
                turnId: turn.id,
                unitKey: unit.key,
                threadId: turn.threadId,
                unitOrderKey: order,
                parentId: unit.parentId ?? null,
                revision: unit.revision,
                unitJson: encodeUnit(unit),
                createdAt: turn.createdAt,
                updatedAt: now,
              })
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
