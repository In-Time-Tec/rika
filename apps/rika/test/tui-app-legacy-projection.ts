import * as BunServices from "@effect/platform-bun/BunServices"
import * as Database from "@rika/product-store/product-database-layer"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as TranscriptRepository from "@rika/product-store/sqlite-transcript-repository"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import { Context, Effect, Layer, Path } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"

const invalidateProjection = Effect.fn("TuiApp.invalidateProjection")(function* (turnId: Turn.TurnId) {
  const sql = yield* SqlClient
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const rows = yield* sql`UPDATE rika_transcript_checkpoints
        SET projection_version = 2, model_phase = -1,
          usable_completion_sequence = NULL,
          oldest_cursor = NULL, checkpoint_cursor = NULL, cost_usd = NULL, usage_cursors_json = NULL,
          pricing_version = NULL
        WHERE turn_id = ${turnId}
        RETURNING turn_id`
      if (rows.length !== 1) return yield* Effect.die(`Transcript projection ${turnId} does not exist`)
      yield* sql`DELETE FROM rika_transcript_execution_checkpoints WHERE turn_id = ${turnId}`
      yield* sql`DELETE FROM rika_transcript_units WHERE turn_id = ${turnId}`
    }),
  )
})

export const makeProjectionsLegacy = Effect.fn("TuiApp.makeProjectionsLegacy")(function* (root: string) {
  const path = yield* Path.Path
  const database = Database.layer(path.join(root, "rika.db"))
  const repositories = Layer.mergeAll(ThreadRepository.layer, TurnRepository.layer, TranscriptRepository.layer).pipe(
    Layer.provide(database),
  )
  const context = yield* Layer.build(Layer.merge(repositories, database).pipe(Layer.provide(BunServices.layer)))
  const transcripts = Context.get(context, TranscriptRepository.Service)
  const turns = Context.get(context, TurnRepository.Service)
  const aged: Array<string> = []
  for (const thread of yield* Context.get(context, ThreadRepository.Service).list())
    for (const turn of yield* turns.list(thread.id)) {
      const projection = yield* transcripts.get(turn.id)
      if (projection === undefined) continue
      aged.push(String(turn.id))
      yield* invalidateProjection(turn.id).pipe(Effect.provide(context))
    }
  return aged
})
