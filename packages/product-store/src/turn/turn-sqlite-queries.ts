import { Effect, Function } from "effect"
import type { SqlClient as SqlClientType } from "effect/unstable/sql/SqlClient"
import { RepositoryError } from "@rika/product/turn-repository"
import { decodeAgent } from "./turn-row-codec"

const listAgentTurnsImpl = (sql: SqlClientType, mapError: (cause: unknown) => RepositoryError) =>
  sql`SELECT * FROM rika_turns
    WHERE turn_kind = 'AgentExecution' AND status IN ('queued', 'accepted', 'running', 'waiting')
    ORDER BY created_at ASC, rowid ASC`.pipe(
    Effect.mapError(mapError),
    Effect.flatMap((rows) => Effect.all(rows.map(decodeAgent))),
  )

export const listAgentTurns: {
  (mapError: (cause: unknown) => RepositoryError): (sql: SqlClientType) => ReturnType<typeof listAgentTurnsImpl>
  (sql: SqlClientType, mapError: (cause: unknown) => RepositoryError): ReturnType<typeof listAgentTurnsImpl>
} = Function.dual(2, listAgentTurnsImpl)
