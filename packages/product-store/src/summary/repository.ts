import { Service } from "@rika/product/thread-summary-repository"
export { Service }
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { and, asc, desc, eq, inArray, isNull, notExists, or, sql } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import { ThreadId } from "@rika/product/thread-record"
import { EditTotals, RepairCandidate, ThreadSummary } from "@rika/product/thread-summary"
import { TurnId } from "@rika/product/turn-record"
import { Status } from "@rika/product/execution-status"
import * as ThreadState from "@rika/product/thread-state"
import {
  rikaThreadDeletionOutbox,
  rikaThreadPickerSummary,
  rikaThreadReadState,
  rikaThreads,
  rikaThreadTurnActivity,
  rikaTurns,
} from "../database/schema/product"

export class RepositoryError extends Schema.TaggedError<RepositoryError>()("ThreadSummaryRepositoryError", {
  message: Schema.String,
}) {}

export interface ListInput {
  readonly includeArchived?: boolean
  readonly limit?: number
}

export interface TurnActivityInput {
  readonly turnId: TurnId
  readonly threadId: ThreadId
  readonly projectedCursor?: string
  readonly complete: boolean
  readonly editTotals: EditTotals
  readonly lastEventAt?: number
  readonly now: number
}

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<ReadonlyArray<ThreadSummary>, RepositoryError>
  readonly ensureTurn: (turnId: TurnId, threadId: ThreadId, now: number) => Effect.Effect<void, RepositoryError>
  readonly replaceTurn: (input: TurnActivityInput) => Effect.Effect<void, RepositoryError>
  readonly markRead: (threadId: ThreadId, now: number) => Effect.Effect<void, RepositoryError>
  readonly listRepairCandidates: (limit?: number) => Effect.Effect<ReadonlyArray<RepairCandidate>, RepositoryError>
}

const repositoryError = <Error>(error: Error) => RepositoryError.make({ message: String(error) })
const listLimit = (value: number | undefined) => Math.min(Math.max(value ?? 100, 1), 100)

const decodeSummary = (value: {
  readonly id: string | null
  readonly workspace: string | null
  readonly title: string | null
  readonly pinned: number | null
  readonly archived: number | null
  readonly statusRank: number | null
  readonly lastStatus: string | null
  readonly lastActivityAt: number | null
  readonly lastReadAt: number | null
  readonly turnCount: number | null
  readonly currentActivityCount: number | null
  readonly added: number | null
  readonly modified: number | null
  readonly removed: number | null
}) =>
  Effect.gen(function* () {
    const editTotals =
      (value.turnCount ?? 0) > 0 && value.turnCount === value.currentActivityCount
        ? {
            added: Math.max(0, value.added ?? 0),
            modified: Math.max(0, value.modified ?? 0),
            removed: Math.max(0, value.removed ?? 0),
          }
        : undefined
    const id = yield* Schema.decodeUnknownEffect(ThreadId)(value.id)
    const summary = ThreadSummary.make({
      id,
      workspace: yield* Schema.decodeUnknownEffect(Schema.String)(value.workspace),
      title: yield* Schema.decodeUnknownEffect(Schema.String)(value.title),
      pinned: value.pinned === 1,
      archived: value.archived === 1,
      status: ThreadState.threadStateFromRank({
        rank: value.statusRank ?? 0,
        lastStatus: value.lastStatus ?? undefined,
      }),
      unread: (value.lastActivityAt ?? 0) > (value.lastReadAt ?? 0),
      lastActivityAt: value.lastActivityAt ?? 0,
    })
    if (editTotals !== undefined) Object.assign(summary, { editTotals })
    return summary
  }).pipe(Effect.mapError(repositoryError))

const decodeRepair = (row: { readonly turnId: string; readonly threadId: string; readonly status: string }) =>
  Effect.gen(function* () {
    const status = yield* Schema.decodeUnknownEffect(Status)(row.status)
    const turnId = yield* Schema.decodeEffect(TurnId)(row.turnId)
    const threadId = yield* Schema.decodeEffect(ThreadId)(row.threadId)
    return RepairCandidate.make({
      turnId,
      threadId,
      status,
    })
  }).pipe(Effect.mapError(repositoryError))

export const layerForOwner = (ownerId: string) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = yield* PgDrizzle.makeWithDefaults()
      return Service.of({
        list: Effect.fn("ThreadSummaryRepository.list")(function* (input: ListInput = {}) {
          const filters = [
            eq(rikaThreads.ownerId, ownerId),
            notExists(
              db
                .select({ threadId: rikaThreadDeletionOutbox.threadId })
                .from(rikaThreadDeletionOutbox)
                .where(eq(rikaThreadDeletionOutbox.threadId, rikaThreadPickerSummary.threadId)),
            ),
          ]
          if (input.includeArchived !== true) filters.push(eq(rikaThreadPickerSummary.archived, 0))
          const rows = yield* db
            .select({
              id: rikaThreadPickerSummary.threadId,
              workspace: rikaThreadPickerSummary.workspace,
              title: rikaThreadPickerSummary.title,
              pinned: rikaThreadPickerSummary.pinned,
              archived: rikaThreadPickerSummary.archived,
              statusRank: rikaThreadPickerSummary.statusRank,
              lastStatus: rikaThreadPickerSummary.lastStatus,
              lastActivityAt: rikaThreadPickerSummary.lastActivityAt,
              lastReadAt: rikaThreadReadState.lastReadAt,
              turnCount: rikaThreadPickerSummary.turnCount,
              currentActivityCount: rikaThreadPickerSummary.currentActivityCount,
              added: rikaThreadPickerSummary.added,
              modified: rikaThreadPickerSummary.modified,
              removed: rikaThreadPickerSummary.removed,
            })
            .from(rikaThreadPickerSummary)
            .innerJoin(rikaThreads, eq(rikaThreads.id, rikaThreadPickerSummary.threadId))
            .leftJoin(rikaThreadReadState, eq(rikaThreadReadState.threadId, rikaThreadPickerSummary.threadId))
            .where(and(...filters))
            .orderBy(
              desc(rikaThreadPickerSummary.pinned),
              desc(rikaThreadPickerSummary.lastActivityAt),
              asc(rikaThreadPickerSummary.threadId),
            )
            .limit(listLimit(input.limit))
            .pipe(Effect.mapError(repositoryError))
          return yield* Effect.all(rows.map(decodeSummary))
        }),
        ensureTurn: Effect.fn("ThreadSummaryRepository.ensureTurn")(function* (turnId, threadId, now) {
          yield* db
            .insert(rikaThreadTurnActivity)
            .values({
              turnId,
              threadId,
              projectedCursor: null,
              complete: 0,
              added: 0,
              modified: 0,
              removed: 0,
              lastEventAt: null,
              updatedAt: now,
            })
            .onConflictDoNothing()
            .pipe(Effect.mapError(repositoryError))
        }),
        replaceTurn: Effect.fn("ThreadSummaryRepository.replaceTurn")(function* (input) {
          const values = {
            turnId: input.turnId,
            threadId: input.threadId,
            projectedCursor: input.projectedCursor ?? null,
            complete: Number(input.complete),
            added: input.editTotals.added,
            modified: input.editTotals.modified,
            removed: input.editTotals.removed,
            lastEventAt: input.lastEventAt ?? null,
            updatedAt: input.now,
          }
          yield* db
            .insert(rikaThreadTurnActivity)
            .values(values)
            .onConflictDoUpdate({
              target: rikaThreadTurnActivity.turnId,
              set: {
                threadId: values.threadId,
                projectedCursor: values.projectedCursor,
                complete: values.complete,
                added: values.added,
                modified: values.modified,
                removed: values.removed,
                lastEventAt: values.lastEventAt,
                updatedAt: values.updatedAt,
              },
              where: sql`excluded.updated_at >= ${rikaThreadTurnActivity.updatedAt}`,
            })
            .pipe(Effect.mapError(repositoryError))
        }),
        markRead: Effect.fn("ThreadSummaryRepository.markRead")(function* (threadId, now) {
          yield* db
            .insert(rikaThreadReadState)
            .values({ threadId, lastReadAt: now })
            .onConflictDoUpdate({
              target: rikaThreadReadState.threadId,
              set: { lastReadAt: sql`greatest(${rikaThreadReadState.lastReadAt}, excluded.last_read_at)` },
            })
            .pipe(Effect.mapError(repositoryError))
        }),
        listRepairCandidates: Effect.fn("ThreadSummaryRepository.listRepairCandidates")(function* (limit = 25) {
          const rows = yield* db
            .select({ turnId: rikaTurns.id, threadId: rikaTurns.threadId, status: rikaTurns.status })
            .from(rikaTurns)
            .innerJoin(rikaThreads, eq(rikaThreads.id, rikaTurns.threadId))
            .leftJoin(rikaThreadTurnActivity, eq(rikaThreadTurnActivity.turnId, rikaTurns.id))
            .where(
              and(
                eq(rikaThreads.ownerId, ownerId),
                notExists(
                  db
                    .select({ threadId: rikaThreadDeletionOutbox.threadId })
                    .from(rikaThreadDeletionOutbox)
                    .where(eq(rikaThreadDeletionOutbox.threadId, rikaTurns.threadId)),
                ),
                eq(rikaTurns.turnKind, "AgentExecution"),
                or(
                  isNull(rikaThreadTurnActivity.turnId),
                  and(
                    inArray(rikaTurns.status, ["completed", "failed", "cancelled"]),
                    eq(rikaThreadTurnActivity.complete, 0),
                  ),
                ),
              ),
            )
            .orderBy(asc(rikaTurns.createdAt), asc(rikaTurns.id))
            .limit(listLimit(limit))
            .pipe(Effect.mapError(repositoryError))
          return yield* Effect.all(rows.map(decodeRepair))
        }),
      })
    }),
  )

export const layer = layerForOwner("local")
