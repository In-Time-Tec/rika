import { and, asc, desc, eq, gt, lt, notExists, or, type SQL } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Effect } from "effect"
import {
  rikaHostedThreads,
  rikaThreadDeletionOutbox,
  rikaThreads,
} from "../../database/schema/product"
import {
  ProductRepositoryError,
  type ProductRepositoryService,
  type ProductThreadMetadata,
  type ProductThreadMetadataCursor,
} from "./contract"

const databaseError = (cause: unknown) => ProductRepositoryError.make({ kind: "unavailable", message: String(cause) })
const query = <A extends object, E, R>(effect: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  effect.pipe(Effect.mapError(databaseError))

const metadataRow = (row: {
  readonly id: string
  readonly title: string
  readonly target: "runner" | "orb"
  readonly updatedAt: number
  readonly pinned: number
}): ProductThreadMetadata => ({
  id: row.id,
  title: row.title,
  target: row.target,
  updatedAt: row.updatedAt,
  pinned: row.pinned === 1,
})

export const metadataOperations = Effect.gen(function* () {
  const db = yield* PgDrizzle.makeWithDefaults()
  const threadMetadataList: ProductRepositoryService["threadMetadataList"] = (input) => {
    const limit = Math.min(Math.max(Math.floor(input.limit), 1), 100)
    const filters: Array<SQL> = [
      eq(rikaThreads.ownerId, input.ownerId),
      eq(rikaThreads.archived, 0),
      notExists(
        db
          .select({ threadId: rikaThreadDeletionOutbox.threadId })
          .from(rikaThreadDeletionOutbox)
          .where(eq(rikaThreadDeletionOutbox.threadId, rikaThreads.id)),
      ),
    ]
    if (input.cursor !== undefined) {
      const pinned = Number(input.cursor.pinned)
      filters.push(
        or(
          lt(rikaThreads.pinned, pinned),
          and(eq(rikaThreads.pinned, pinned), lt(rikaThreads.updatedAt, input.cursor.updatedAt)),
          and(
            eq(rikaThreads.pinned, pinned),
            eq(rikaThreads.updatedAt, input.cursor.updatedAt),
            gt(rikaThreads.id, input.cursor.threadId),
          ),
        )!,
      )
    }
    return query(
      db
        .select({
          id: rikaThreads.id,
          title: rikaThreads.title,
          target: rikaHostedThreads.executorKind,
          updatedAt: rikaThreads.updatedAt,
          pinned: rikaThreads.pinned,
        })
        .from(rikaThreads)
        .innerJoin(
          rikaHostedThreads,
          and(eq(rikaHostedThreads.id, rikaThreads.id), eq(rikaHostedThreads.ownerId, rikaThreads.ownerId)),
        )
        .where(and(...filters))
        .orderBy(desc(rikaThreads.pinned), desc(rikaThreads.updatedAt), asc(rikaThreads.id))
        .limit(limit + 1),
    ).pipe(
      Effect.map((rows) => {
        const threads = rows.slice(0, limit).map(metadataRow)
        const last = threads.at(-1)
        const nextCursor: ProductThreadMetadataCursor | undefined =
          rows.length > limit && last !== undefined
            ? { pinned: last.pinned, updatedAt: last.updatedAt, threadId: last.id }
            : undefined
        return nextCursor === undefined ? { threads } : { threads, nextCursor }
      }),
    )
  }

  const threadMetadata: ProductRepositoryService["threadMetadata"] = (ownerId, threadId) =>
    query(
      db
        .select({
          id: rikaThreads.id,
          title: rikaThreads.title,
          target: rikaHostedThreads.executorKind,
          updatedAt: rikaThreads.updatedAt,
          pinned: rikaThreads.pinned,
        })
        .from(rikaThreads)
        .innerJoin(
          rikaHostedThreads,
          and(eq(rikaHostedThreads.id, rikaThreads.id), eq(rikaHostedThreads.ownerId, rikaThreads.ownerId)),
        )
        .where(
          and(
            eq(rikaThreads.ownerId, ownerId),
            eq(rikaThreads.id, threadId),
            notExists(
              db
                .select({ threadId: rikaThreadDeletionOutbox.threadId })
                .from(rikaThreadDeletionOutbox)
                .where(eq(rikaThreadDeletionOutbox.threadId, rikaThreads.id)),
            ),
          ),
        )
        .limit(1),
    ).pipe(Effect.map((rows) => (rows[0] === undefined ? undefined : metadataRow(rows[0]))))

  return { threadMetadataList, threadMetadata }
})
