import { expect } from "@effect/vitest"
import type * as Thread from "@rika/product/thread-record"
import type * as TranscriptRepository from "@rika/product/transcript-repository"
import type * as Turn from "@rika/product/turn-record"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import * as UnitOrder from "@rika/transcript/transcript-unit-order"
import { eq } from "drizzle-orm"
import type { NodePgDatabase } from "drizzle-orm/node-postgres"
import { Effect, Schema } from "effect"
import * as schema from "../../src/database/schema/product"

const LegacyUnitJson = Schema.fromJsonString(Schema.Unknown)

/**
 * A unit persisted by a release whose contract still had `Cell` blocks is a stale derived row:
 * Turn and page reads skip it instead of failing the whole Turn or page.
 */
export const expectLegacyUnitsSkipped = (
  db: NodePgDatabase,
  transcripts: TranscriptRepository.Interface,
  input: {
    readonly threadId: Thread.ThreadId
    readonly turn: Turn.Turn
    readonly units: ReadonlyArray<TranscriptUnit.Unit>
  },
) =>
  Effect.gen(function* () {
    const legacyKey = `turn:${input.turn.id}:legacy-cell`
    const order = UnitOrder.unitOrder(legacyKey, 99)
    const unitJson = yield* Schema.encodeEffect(LegacyUnitJson)({
      key: legacyKey,
      turnId: input.turn.id,
      order,
      revision: 0,
      content: { _tag: "Cell", cellId: "legacy" },
    })
    yield* Effect.tryPromise(() =>
      db.insert(schema.rikaTranscriptUnits).values({
        turnId: input.turn.id,
        unitKey: legacyKey,
        threadId: input.threadId,
        unitOrderKey: UnitOrder.encodeUnitOrder(order),
        parentId: null,
        revision: 0,
        unitJson,
        createdAt: 99,
        updatedAt: 99,
      }),
    )
    const expectedKeys = input.units.map((unit) => unit.key)
    expect((yield* transcripts.get(input.turn.id))?.units.map((unit) => unit.key)).toEqual(expectedKeys)
    expect((yield* transcripts.page(input.threadId, { limit: 10 })).entries.map((entry) => entry.unit.key)).toEqual(
      expectedKeys,
    )
    yield* Effect.tryPromise(() =>
      db.delete(schema.rikaTranscriptUnits).where(eq(schema.rikaTranscriptUnits.unitKey, legacyKey)),
    )
  })
