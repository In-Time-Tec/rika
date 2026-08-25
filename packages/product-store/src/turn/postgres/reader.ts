import { eq } from "drizzle-orm"
import type * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Effect } from "effect"
import { TurnId } from "@rika/product/turn-record"
import type { Turn } from "@rika/product/turn-record"
import { RepositoryError } from "@rika/product/turn-repository"
import { rikaTurns } from "../../database/schema/product"
import { decode } from "./row-codec"

export const turnRowSelection = {
  id: rikaTurns.id,
  thread_id: rikaTurns.threadId,
  turn_kind: rikaTurns.turnKind,
  prompt: rikaTurns.prompt,
  status: rikaTurns.status,
  execution_route_json: rikaTurns.executionRouteJson,
  execution_link_json: rikaTurns.executionLinkJson,
  prompt_parts_json: rikaTurns.promptPartsJson,
  shell_command: rikaTurns.shellCommand,
  shell_result_text: rikaTurns.shellResultText,
  shell_result_truncated: rikaTurns.shellResultTruncated,
  shell_result_exit_code: rikaTurns.shellResultExitCode,
  author_json: rikaTurns.authorJson,
  lineage_json: rikaTurns.lineageJson,
  created_at: rikaTurns.createdAt,
  updated_at: rikaTurns.updatedAt,
}

const readTurnImpl = (db: PgDrizzle.EffectPgDatabase, id: TurnId): Effect.Effect<Turn | undefined, RepositoryError> =>
  db.select(turnRowSelection).from(rikaTurns).where(eq(rikaTurns.id, id)).limit(1).pipe(
    Effect.mapError((cause) => RepositoryError.make({ message: cause.message })),
    Effect.flatMap((rows) => Effect.all(rows.map(decode))),
    Effect.map((turns) => turns[0]),
  )

export function readTurn(db: PgDrizzle.EffectPgDatabase): (id: TurnId) => Effect.Effect<Turn | undefined, RepositoryError>
export function readTurn(db: PgDrizzle.EffectPgDatabase, id: TurnId): Effect.Effect<Turn | undefined, RepositoryError>
export function readTurn(db: PgDrizzle.EffectPgDatabase, id?: TurnId) {
  return id === undefined ? (nextId: TurnId) => readTurnImpl(db, nextId) : readTurnImpl(db, id)
}
