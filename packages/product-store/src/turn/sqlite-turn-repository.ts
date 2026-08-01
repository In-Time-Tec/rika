import { Service, RepositoryError } from "@rika/product/turn-repository"
export { Service, RepositoryError }
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { TurnId } from "@rika/product/turn-record"
import { repositoryError } from "./turn-memory-errors"
import { cursorFor, pageSize } from "./turn-memory-state"
import { decode, decodeAgent } from "./turn-row-codec"
import { readTurn } from "./turn-sqlite-reader"
import { listAgentTurns } from "./turn-sqlite-queries"
import { makeTurnSqliteQueue } from "./turn-sqlite-queue"
import { makeTurnSqliteState } from "./turn-sqlite-state"
import { makeTurnSqliteSubmission } from "./turn-sqlite-submission"

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const get = Effect.fn("TurnRepository.get")((id: TurnId) => readTurn(sql, id))
    return Service.of({
      ...makeTurnSqliteSubmission(sql),
      ...makeTurnSqliteQueue(sql),
      ...makeTurnSqliteState(sql),
      get,
      list: Effect.fn("TurnRepository.list")(function* (threadId): Effect.fn.Return<
        ReadonlyArray<import("@rika/product/turn-record").Turn>,
        import("@rika/product/turn-repository").RepositoryError
      > {
        const rows =
          yield* sql`SELECT * FROM rika_turns WHERE thread_id = ${threadId} ORDER BY created_at ASC, rowid ASC`.pipe(
            Effect.mapError(repositoryError),
          )
        return yield* Effect.all(rows.map(decode))
      }),
      listRecentNonqueued: Effect.fn("TurnRepository.listRecentNonqueued")(
        function* (
          threadId,
          limit,
        ): Effect.fn.Return<
          ReadonlyArray<import("@rika/product/turn-record").Turn>,
          import("@rika/product/turn-repository").RepositoryError
        > {
          const rows = yield* sql`SELECT * FROM rika_turns
          WHERE thread_id = ${threadId} AND status <> 'queued'
          ORDER BY created_at DESC, id DESC LIMIT ${Math.max(0, Math.floor(limit))}`.pipe(
            Effect.mapError(repositoryError),
          )
          return (yield* Effect.all(rows.map(decode))).toReversed()
        },
      ),
      page: Effect.fn("TurnRepository.page")(function* (
        threadId,
        options = {},
      ): Effect.fn.Return<
        import("@rika/product/turn-repository").PageResult,
        import("@rika/product/turn-repository").RepositoryError
      > {
        const limit = pageSize(options.limit)
        const rows =
          options.before === undefined
            ? yield* sql`SELECT * FROM rika_turns WHERE thread_id = ${threadId} ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`.pipe(
                Effect.mapError(repositoryError),
              )
            : yield* sql`SELECT * FROM rika_turns WHERE thread_id = ${threadId} AND (created_at < ${options.before.createdAt} OR (created_at = ${options.before.createdAt} AND id < ${options.before.id})) ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`.pipe(
                Effect.mapError(repositoryError),
              )
        const turns = (yield* Effect.all(rows.slice(0, limit).map(decode))).toReversed()
        return {
          turns,
          hasOlder: rows.length > limit,
          oldestCursor: cursorFor(turns[0]),
          newestCursor: cursorFor(turns.at(-1)),
        }
      }),
      findActive: Effect.fn("TurnRepository.findActive")(function* (threadId): Effect.fn.Return<
        import("@rika/product/turn-record").AgentExecutionTurn | undefined,
        import("@rika/product/turn-repository").RepositoryError
      > {
        const rows =
          yield* sql`SELECT * FROM rika_turns WHERE thread_id = ${threadId} AND turn_kind = 'AgentExecution' AND status IN ('accepted', 'running', 'waiting') ORDER BY created_at ASC, rowid ASC LIMIT 1`.pipe(
            Effect.mapError(repositoryError),
          )
        return rows[0] === undefined ? undefined : yield* decodeAgent(rows[0])
      }),
      listNonterminal: listAgentTurns(sql, "none", repositoryError).pipe(
        Effect.withSpan("TurnRepository.listNonterminal"),
      ),
      listStopRequested: listAgentTurns(sql, "requested", repositoryError).pipe(
        Effect.withSpan("TurnRepository.listStopRequested"),
      ),
      requestStop: Effect.fn("TurnRepository.requestStop")(function* (id, now): Effect.fn.Return<
        import("@rika/product/turn-record").AgentExecutionTurn | undefined,
        import("@rika/product/turn-repository").RepositoryError
      > {
        const rows = yield* sql`UPDATE rika_turns SET stop_intent = 'requested', updated_at = ${now}
          WHERE id = ${id} AND turn_kind = 'AgentExecution' AND status IN ('queued', 'accepted', 'running', 'waiting') RETURNING *`.pipe(
          Effect.mapError(repositoryError),
        )
        const row = rows[0]
        return row === undefined ? undefined : yield* decodeAgent(row)
      }),
    })
  }),
)
export { makeMemory, memoryLayer, memoryCoordinator } from "./memory-turn-repository"
