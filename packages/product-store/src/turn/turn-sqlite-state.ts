import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { RepositoryError } from "@rika/product/turn-repository"
import type { Interface } from "@rika/product/turn-repository"
import { decodeAgent } from "./turn-row-codec"
import { turnRowJson } from "./turn-row-json-codec"
import { missing, repositoryError } from "./turn-memory-errors"
export const makeTurnSqliteState = (
  sql: SqlClient,
): Pick<Interface, "setExtensionPin" | "setStatus" | "startAccepted" | "cancelAccepted" | "repairCursor"> => ({
  setExtensionPin: Effect.fn("TurnRepository.setExtensionPin")(function* (id, pin) {
    const encoded = yield* Schema.encodeEffect(turnRowJson.extensionPin)(pin).pipe(Effect.mapError(repositoryError))
    const rows = yield* sql`UPDATE rika_turns SET extension_pin_json = ${encoded}
      WHERE id = ${id} AND turn_kind = 'AgentExecution'
        AND (extension_pin_json IS NULL OR extension_pin_json = ${encoded}) RETURNING *`.pipe(
      Effect.mapError(repositoryError),
    )
    if (rows[0] === undefined)
      return yield* RepositoryError.make({
        message: `Turn ${id} extension pin is immutable or turn does not exist`,
      })
    return yield* decodeAgent(rows[0])
  }),
  setStatus: Effect.fn("TurnRepository.setStatus")(function* (id, status, lastCursor, now) {
    if (status === "queued")
      return yield* RepositoryError.make({
        message: `Turn ${id} cannot transition into 'queued' via setStatus`,
      })
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const before = yield* sql`SELECT * FROM rika_turns WHERE id = ${id} AND turn_kind = 'AgentExecution'`
          if (before[0] === undefined) return yield* missing(id)
          const wasQueued = String((before[0] as { status?: unknown }).status) === "queued"
          if (wasQueued)
            return yield* RepositoryError.make({
              message: `Turn ${id} cannot transition into or out of 'queued' via setStatus`,
            })
          const rows =
            yield* sql`UPDATE rika_turns SET status = ${status}, last_cursor = ${lastCursor ?? null}, updated_at = ${now}
            WHERE id = ${id} AND turn_kind = 'AgentExecution' AND status NOT IN ('completed', 'failed', 'cancelled')
            RETURNING *`
          if (rows[0] === undefined) return yield* decodeAgent(before[0])
          const turn = yield* decodeAgent(rows[0])
          return turn
        }),
      )
      .pipe(Effect.mapError(repositoryError))
  }),
  startAccepted: Effect.fn("TurnRepository.startAccepted")(function* (id, now) {
    const rows = yield* sql`UPDATE rika_turns SET status = 'running', updated_at = ${now}
      WHERE id = ${id} AND turn_kind = 'AgentExecution' AND status = 'accepted'
      RETURNING id`.pipe(Effect.mapError(repositoryError))
    return rows[0] !== undefined
  }),
  cancelAccepted: Effect.fn("TurnRepository.cancelAccepted")(function* (id, now) {
    const rows = yield* sql`UPDATE rika_turns SET status = 'cancelled', updated_at = ${now}
      WHERE id = ${id} AND turn_kind = 'AgentExecution' AND status = 'accepted'
      RETURNING id`.pipe(Effect.mapError(repositoryError))
    return rows[0] !== undefined
  }),
  repairCursor: Effect.fn("TurnRepository.repairCursor")(function* (id, status, expectedCursor, cursor) {
    const rows = yield* sql`UPDATE rika_turns SET last_cursor = ${cursor ?? null}
      WHERE id = ${id}
        AND turn_kind = 'AgentExecution'
        AND status = ${status}
        AND (last_cursor = ${expectedCursor ?? null} OR (last_cursor IS NULL AND ${expectedCursor ?? null} IS NULL))
      RETURNING id`.pipe(Effect.mapError(repositoryError))
    return rows[0] !== undefined
  }),
})
