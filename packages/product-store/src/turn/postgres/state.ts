import { and, eq, inArray, isNull, notInArray } from "drizzle-orm"
import type * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Effect } from "effect"
import { RepositoryError } from "@rika/product/turn-repository"
import type { Interface } from "@rika/product/turn-repository"
import { rikaTurns } from "../../database/schema/product"
import { decodeAgent } from "./row-codec"
import { turnRowSelection } from "./reader"
import { missing, repositoryError } from "../memory/errors"

export const makeTurnSqlState = (
  db: PgDrizzle.EffectPgDatabase,
): Pick<Interface, "setStatus" | "startAccepted" | "cancelUnlinked"> => ({
  setStatus: Effect.fn("TurnRepository.setStatus")(function* (id, status, now) {
    if (status === "queued")
      return yield* RepositoryError.make({ message: `Turn ${id} cannot transition into 'queued' via setStatus` })
    return yield* db.transaction((tx) => Effect.gen(function* () {
      const before = yield* tx.select(turnRowSelection).from(rikaTurns).where(and(
        eq(rikaTurns.id, id), eq(rikaTurns.turnKind, "AgentExecution"),
      )).limit(1)
      if (before[0] === undefined) return yield* missing(id)
      const existing = yield* decodeAgent(before[0])
      if (existing.status === "queued")
        return yield* RepositoryError.make({
          message: `Turn ${id} cannot transition into or out of 'queued' via setStatus`,
        })
      const rows = yield* tx.update(rikaTurns).set({ status, updatedAt: now }).where(and(
        eq(rikaTurns.id, id),
        eq(rikaTurns.turnKind, "AgentExecution"),
        notInArray(rikaTurns.status, ["completed", "failed", "cancelled"]),
      )).returning(turnRowSelection)
      return rows[0] === undefined ? existing : yield* decodeAgent(rows[0])
    })).pipe(Effect.mapError(repositoryError))
  }),
  startAccepted: Effect.fn("TurnRepository.startAccepted")(function* (id, now) {
    const rows = yield* db.update(rikaTurns).set({ status: "running", updatedAt: now }).where(and(
      eq(rikaTurns.id, id), eq(rikaTurns.turnKind, "AgentExecution"), eq(rikaTurns.status, "accepted"),
    )).returning({ id: rikaTurns.id }).pipe(Effect.mapError(repositoryError))
    return rows[0] !== undefined
  }),
  cancelUnlinked: Effect.fn("TurnRepository.cancelUnlinked")(function* (id, now) {
    const rows = yield* db.update(rikaTurns).set({ status: "cancelled", updatedAt: now }).where(and(
      eq(rikaTurns.id, id),
      eq(rikaTurns.turnKind, "AgentExecution"),
      inArray(rikaTurns.status, ["accepted", "running"]),
      isNull(rikaTurns.executionLinkJson),
    )).returning({ id: rikaTurns.id }).pipe(Effect.mapError(repositoryError))
    return rows[0] !== undefined
  }),
})
