import { asc, and, eq, inArray } from "drizzle-orm"
import type * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Effect, Function } from "effect"
import { RepositoryError } from "@rika/product/turn-repository"
import { rikaTurns } from "../../database/schema/product"
import { decodeAgent } from "./row-codec"
import { turnRowSelection } from "./reader"

const listAgentTurnsImpl = (db: PgDrizzle.EffectPgDatabase, mapError: (cause: unknown) => RepositoryError) =>
  db
    .select(turnRowSelection)
    .from(rikaTurns)
    .where(
      and(
        eq(rikaTurns.turnKind, "AgentExecution"),
        inArray(rikaTurns.status, ["queued", "accepted", "running", "waiting", "cancelling"]),
      ),
    )
    .orderBy(asc(rikaTurns.createdAt), asc(rikaTurns.id))
    .pipe(
      Effect.mapError(mapError),
      Effect.flatMap((rows) => Effect.all(rows.map(decodeAgent))),
    )

export const listAgentTurns: {
  (
    mapError: (cause: unknown) => RepositoryError,
  ): (db: PgDrizzle.EffectPgDatabase) => ReturnType<typeof listAgentTurnsImpl>
  (db: PgDrizzle.EffectPgDatabase, mapError: (cause: unknown) => RepositoryError): ReturnType<typeof listAgentTurnsImpl>
} = Function.dual(2, listAgentTurnsImpl)
