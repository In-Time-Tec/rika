import type { HostedThreadSnapshot } from "@rika/product/client-protocol"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import type { ThreadViewSnapshot } from "@rika/product/thread-view"
import type * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Effect } from "effect"
import { ProcessObservationProjection } from "../execution/process-observation"
import { databaseError } from "./persistence"

// Session views can outlive the process result they first projected. Apply the
// durable terminal observation at publication, not only at transcript writes.
const view = (tx: PgDrizzle.EffectPgDatabase, snapshot: ThreadViewSnapshot) =>
  Effect.gen(function* () {
    const turns = yield* Effect.forEach(snapshot.turns, (entry) =>
      ProcessObservationProjection.overlay(tx, entry.turn.id, entry.units).pipe(
        Effect.map((units) => ({ ...entry, units })),
      ),
    )
    return { ...snapshot, turns }
  }).pipe(Effect.mapError(databaseError))

const snapshot = (tx: PgDrizzle.EffectPgDatabase, value: HostedThreadSnapshot) =>
  view(tx, value.view).pipe(Effect.map((overlaid) => ({ ...value, view: overlaid })))

const event = (
  tx: PgDrizzle.EffectPgDatabase,
  value: InteractiveEvent,
): Effect.Effect<InteractiveEvent, ReturnType<typeof databaseError>> =>
  Effect.gen(function* () {
    if (value._tag === "ThreadViewSnapshot") return { ...value, snapshot: yield* view(tx, value.snapshot) }
    if (value._tag !== "ThreadViewPatch") return value
    let upsert = [...value.patch.upsert]
    for (const turnId of new Set(upsert.map((unit) => unit.turnId))) {
      const units = upsert.filter((unit) => unit.turnId === turnId)
      const overlaid = yield* ProcessObservationProjection.overlay(tx, turnId, units).pipe(
        Effect.mapError(databaseError),
      )
      const byKey = new Map(overlaid.map((unit) => [unit.key, unit]))
      upsert = upsert.map((unit) => byKey.get(unit.key) ?? unit)
    }
    return { ...value, patch: { ...value.patch, upsert } }
  })

export const processObservationProjection = { snapshot, event }
