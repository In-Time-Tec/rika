import { and, eq } from "drizzle-orm"
import type * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Effect } from "effect"
import type { Interface } from "@rika/product/turn-repository"
import { TurnResult } from "@rika/product/thread-result"
import { rikaTurns } from "../../database/schema/product"
import { decode } from "./row-codec"
import { turnRowSelection } from "./reader"
import { repositoryError } from "../memory/errors"

const insert = (
  db: PgDrizzle.EffectPgDatabase,
  turn: Parameters<Interface["copyRecordedShell"]>[0] | Parameters<Interface["createRecordedShell"]>[0],
) => {
  const result = turn.status === "running" ? undefined : turn.result
  return db
    .insert(rikaTurns)
    .values({
      id: turn.id,
      threadId: turn.threadId,
      turnKind: "RecordedShell",
      prompt: turn.prompt,
      shellCommand: turn.command,
      shellResultText: result?.text ?? null,
      shellResultTruncated: result === undefined ? null : Number(result.truncated),
      shellResultExitCode: result?.exitCode ?? null,
      authorJson: JSON.stringify(turn.author),
      lineageJson: JSON.stringify(turn.lineage),
      status: turn.status,
      createdAt: turn.createdAt,
      updatedAt: turn.updatedAt,
    })
    .returning(turnRowSelection)
}

export const makeTurnSqlRecordedShell = (
  db: PgDrizzle.EffectPgDatabase,
): Pick<Interface, "createRecordedShell" | "settleRecordedShell" | "copyRecordedShell"> => ({
  createRecordedShell: Effect.fn("TurnRepository.createRecordedShell")(function* (turn) {
    const rows = yield* insert(db, turn).pipe(Effect.mapError(repositoryError))
    const decoded = yield* decode(rows[0])
    if (!TurnResult.isRunningRecordedShell(decoded))
      return yield* repositoryError(`Turn ${turn.id} is not a running recorded shell`)
    return decoded
  }),
  copyRecordedShell: Effect.fn("TurnRepository.copyRecordedShell")(function* (turn) {
    const rows = yield* insert(db, turn).pipe(Effect.mapError(repositoryError))
    const decoded = yield* decode(rows[0])
    if (!TurnResult.isTerminalRecordedShell(decoded))
      return yield* repositoryError(`Turn ${turn.id} is not a terminal recorded shell`)
    return decoded
  }),
  settleRecordedShell: Effect.fn("TurnRepository.settleRecordedShell")(function* (expected, turn) {
    const rows = yield* db
      .update(rikaTurns)
      .set({
        status: turn.status,
        shellResultText: turn.result.text,
        shellResultTruncated: Number(turn.result.truncated),
        shellResultExitCode: turn.result.exitCode ?? null,
        updatedAt: turn.updatedAt,
      })
      .where(
        and(
          eq(rikaTurns.id, expected.id),
          eq(rikaTurns.threadId, expected.threadId),
          eq(rikaTurns.turnKind, "RecordedShell"),
          eq(rikaTurns.status, "running"),
          eq(rikaTurns.prompt, expected.prompt),
          eq(rikaTurns.shellCommand, expected.command),
        ),
      )
      .returning(turnRowSelection)
      .pipe(Effect.mapError(repositoryError))
    if (rows[0] === undefined) return undefined
    const decoded = yield* decode(rows[0])
    if (!TurnResult.isTerminalRecordedShell(decoded))
      return yield* repositoryError(`Turn ${turn.id} did not settle as a recorded shell`)
    return decoded
  }),
})
