import { Effect } from "effect"
import type { SqlClient as SqlClientType } from "effect/unstable/sql/SqlClient"
import { RepositoryError } from "@rika/product/turn-repository"
import { decodeAgent } from "./turn-row-codec"

export function listAgentTurns(
  stopIntent: "none" | "requested",
  mapError: (cause: unknown) => RepositoryError,
): (sql: SqlClientType) => ReturnType<typeof listAgentTurnsImplementation>
export function listAgentTurns(
  sql: SqlClientType,
  stopIntent: "none" | "requested",
  mapError: (cause: unknown) => RepositoryError,
): ReturnType<typeof listAgentTurnsImplementation>
export function listAgentTurns(
  sqlOrStopIntent: SqlClientType | "none" | "requested",
  stopIntentOrMapError?: "none" | "requested" | ((cause: unknown) => RepositoryError),
  mapError?: (cause: unknown) => RepositoryError,
):
  | ReturnType<typeof listAgentTurnsImplementation>
  | ((sql: SqlClientType) => ReturnType<typeof listAgentTurnsImplementation>) {
  if (mapError === undefined) {
    if (typeof sqlOrStopIntent !== "string" || typeof stopIntentOrMapError !== "function")
      throw new Error("Invalid agent turn query arguments")
    return (sql) => listAgentTurns(sql, sqlOrStopIntent, stopIntentOrMapError)
  }
  if (typeof sqlOrStopIntent === "string" || typeof stopIntentOrMapError !== "string")
    throw new Error("Invalid agent turn query arguments")
  return listAgentTurnsImplementation(sqlOrStopIntent, stopIntentOrMapError, mapError)
}

const listAgentTurnsImplementation = (
  sql: SqlClientType,
  stopIntent: "none" | "requested",
  mapError: (cause: unknown) => RepositoryError,
) =>
  sql`SELECT * FROM rika_turns
    WHERE turn_kind = 'AgentExecution' AND status IN ('queued', 'accepted', 'running', 'waiting')
      AND stop_intent = ${stopIntent}
    ORDER BY created_at ASC, rowid ASC`.pipe(
    Effect.mapError(mapError),
    Effect.flatMap((rows) => Effect.all(rows.map(decodeAgent))),
  )
