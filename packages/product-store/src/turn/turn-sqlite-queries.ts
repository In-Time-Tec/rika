import { Effect } from "effect"
import type { SqlClient as SqlClientType } from "effect/unstable/sql/SqlClient"
import { RepositoryError } from "@rika/product/turn-repository"
import { decodeAgent } from "./turn-row-codec"

export const listAgentTurns = (
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
