import { UsageSummary, type Entry, type PageCursor } from "@rika/product/transcript-page"
import type { ThreadId } from "@rika/product/thread-record"
import * as ExecutionProjection from "@rika/product/execution-projection"
import { RepositoryError, type Interface } from "@rika/product/transcript-repository"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { and, asc, desc, eq, gt, gte, lt, lte, ne, or, type SQL } from "drizzle-orm"
import type * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Effect, Schema } from "effect"
import { decodeDerivedRow } from "../database/derived-row"
import {
  rikaTranscriptCheckpoints,
  rikaTranscriptThreadUsage,
  rikaTranscriptUnits,
  rikaTurns,
} from "../database/schema/product"
import { decode } from "../turn/postgres/row-codec"

const UnitJson = Schema.fromJsonString(TranscriptUnit.Unit)
const StateJson = Schema.fromJsonString(ExecutionProjection.ProjectionState)
const UsageSummaryJson = Schema.fromJsonString(UsageSummary)
const TurnRow = Schema.Struct({
  id: Schema.String,
  thread_id: Schema.String,
  turn_kind: Schema.String,
  prompt: Schema.String,
  status: Schema.String,
  execution_route_json: Schema.NullOr(Schema.String),
  execution_link_json: Schema.optionalKey(Schema.NullOr(Schema.String)),
  prompt_parts_json: Schema.optionalKey(Schema.NullOr(Schema.String)),
  shell_command: Schema.NullOr(Schema.String),
  shell_result_text: Schema.NullOr(Schema.String),
  shell_result_truncated: Schema.NullOr(Schema.Finite),
  shell_result_exit_code: Schema.NullOr(Schema.Finite),
  author_json: Schema.String,
  lineage_json: Schema.String,
  created_at: Schema.Finite,
  updated_at: Schema.Finite,
})
const PageRow = Schema.Struct({
  ...TurnRow.fields,
  unit_json: Schema.String,
  unit_order_key: Schema.String,
  projection_revision: Schema.Finite,
  state_json: Schema.String,
})
const error = (cause: unknown) =>
  Schema.is(RepositoryError)(cause) ? cause : RepositoryError.make({ message: String(cause) })
const turnSelection = {
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

const after = (cursor: PageCursor) =>
  or(
    gt(rikaTranscriptUnits.createdAt, cursor.createdAt),
    and(
      eq(rikaTranscriptUnits.createdAt, cursor.createdAt),
      or(
        gt(rikaTranscriptUnits.turnId, String(cursor.turnId)),
        and(
          eq(rikaTranscriptUnits.turnId, String(cursor.turnId)),
          gt(rikaTranscriptUnits.unitOrderKey, cursor.orderKey),
        ),
      ),
    ),
  )!
const before = (cursor: PageCursor) =>
  or(
    lt(rikaTranscriptUnits.createdAt, cursor.createdAt),
    and(
      eq(rikaTranscriptUnits.createdAt, cursor.createdAt),
      or(
        lt(rikaTranscriptUnits.turnId, String(cursor.turnId)),
        and(
          eq(rikaTranscriptUnits.turnId, String(cursor.turnId)),
          lt(rikaTranscriptUnits.unitOrderKey, cursor.orderKey),
        ),
      ),
    ),
  )!
const atOrBefore = (cursor: PageCursor) =>
  or(
    lt(rikaTranscriptUnits.createdAt, cursor.createdAt),
    and(
      eq(rikaTranscriptUnits.createdAt, cursor.createdAt),
      or(
        lt(rikaTranscriptUnits.turnId, String(cursor.turnId)),
        and(
          eq(rikaTranscriptUnits.turnId, String(cursor.turnId)),
          lte(rikaTranscriptUnits.unitOrderKey, cursor.orderKey),
        ),
      ),
    ),
  )!
const atOrAfter = (cursor: PageCursor) =>
  or(
    gt(rikaTranscriptUnits.createdAt, cursor.createdAt),
    and(
      eq(rikaTranscriptUnits.createdAt, cursor.createdAt),
      or(
        gt(rikaTranscriptUnits.turnId, String(cursor.turnId)),
        and(
          eq(rikaTranscriptUnits.turnId, String(cursor.turnId)),
          gte(rikaTranscriptUnits.unitOrderKey, cursor.orderKey),
        ),
      ),
    ),
  )!

const validatePageOptions = (options: Parameters<Interface["page"]>[1]) => {
  if (options?.before !== undefined && options.after !== undefined)
    return RepositoryError.make({ message: "Transcript page cannot use before and after together" })
  const limit = options?.limit ?? 200
  return Number.isInteger(limit) && limit >= 1 && limit <= 500
    ? limit
    : RepositoryError.make({ message: "Transcript page limit must be from 1 to 500" })
}

const decodeEntry = (raw: typeof PageRow.Encoded) =>
  Effect.gen(function* () {
    const row = yield* Schema.decodeEffect(PageRow)(raw).pipe(Effect.mapError(error))
    const turn = yield* decode(row).pipe(Effect.mapError(error))
    const unit = yield* decodeDerivedRow({
      schema: UnitJson,
      event: "transcript.unit-undecodable",
      value: row.unit_json,
      annotations: [
        ["rika.turn.id", String(turn.id)],
        ["rika.transcript.unit.order", row.unit_order_key],
      ],
    })
    if (unit === undefined) return undefined
    const cursor = { createdAt: turn.createdAt, turnId: turn.id, orderKey: row.unit_order_key }
    if (unit.turnId !== turn.id || TranscriptOrdering.encodeUnitOrder(unit.order) !== cursor.orderKey)
      return yield* RepositoryError.make({ message: `Transcript unit ${unit.key} does not match its durable identity` })
    const projectionState = yield* Schema.decodeEffect(StateJson)(row.state_json).pipe(Effect.mapError(error))
    return { turn, unit, cursor, revision: row.projection_revision, projectionState }
  })

export const makeTranscriptSqlPage = (db: PgDrizzle.EffectPgDatabase): Pick<Interface, "page" | "usage"> => {
  const usage = Effect.fn("TranscriptRepository.usage")(function* (threadId: ThreadId) {
    const row = (yield* db
      .select({ summaryJson: rikaTranscriptThreadUsage.summaryJson })
      .from(rikaTranscriptThreadUsage)
      .where(eq(rikaTranscriptThreadUsage.threadId, threadId))
      .limit(1))[0]
    return row === undefined
      ? { usage: ExecutionProjection.emptyUsageState() }
      : yield* Schema.decodeEffect(UsageSummaryJson)(row.summaryJson)
  }, Effect.mapError(error))
  return {
    page: Effect.fn("TranscriptRepository.page")(function* (threadId, options = {}) {
      const validated = validatePageOptions(options)
      if (Schema.is(RepositoryError)(validated)) return yield* validated
      const limit = validated
      const conditions = [eq(rikaTranscriptUnits.threadId, threadId), ne(rikaTurns.status, "queued")]
      if (options.projectionVersion !== undefined)
        conditions.push(eq(rikaTranscriptCheckpoints.projectionVersion, options.projectionVersion))
      if (options.after !== undefined) conditions.push(after(options.after))
      if (options.before !== undefined) conditions.push(before(options.before))
      const newestFirst = options.after === undefined
      const loaded = yield* db
        .select({
          unit_json: rikaTranscriptUnits.unitJson,
          unit_order_key: rikaTranscriptUnits.unitOrderKey,
          projection_revision: rikaTranscriptCheckpoints.revision,
          state_json: rikaTranscriptCheckpoints.stateJson,
          ...turnSelection,
        })
        .from(rikaTranscriptUnits)
        .innerJoin(rikaTranscriptCheckpoints, eq(rikaTranscriptCheckpoints.turnId, rikaTranscriptUnits.turnId))
        .innerJoin(rikaTurns, eq(rikaTurns.id, rikaTranscriptUnits.turnId))
        .where(and(...conditions))
        .orderBy(
          newestFirst ? desc(rikaTranscriptUnits.createdAt) : asc(rikaTranscriptUnits.createdAt),
          newestFirst ? desc(rikaTranscriptUnits.turnId) : asc(rikaTranscriptUnits.turnId),
          newestFirst ? desc(rikaTranscriptUnits.unitOrderKey) : asc(rikaTranscriptUnits.unitOrderKey),
        )
        .limit(limit + 1)
        .pipe(Effect.mapError(error))
      const hasExtra = loaded.length > limit
      const rows = loaded.slice(0, limit)
      const decoded = (yield* Effect.forEach(rows, decodeEntry)).filter((entry) => entry !== undefined)
      const selected = newestFirst ? decoded.toReversed() : decoded
      const boundaryExists = (condition: SQL<unknown>) => {
        const boundaryConditions = [
          eq(rikaTranscriptUnits.threadId, threadId),
          ne(rikaTurns.status, "queued"),
          condition,
        ]
        if (options.projectionVersion !== undefined)
          boundaryConditions.push(eq(rikaTranscriptCheckpoints.projectionVersion, options.projectionVersion))
        return db
          .select({ turnId: rikaTranscriptUnits.turnId })
          .from(rikaTranscriptUnits)
          .innerJoin(rikaTranscriptCheckpoints, eq(rikaTranscriptCheckpoints.turnId, rikaTranscriptUnits.turnId))
          .innerJoin(rikaTurns, eq(rikaTurns.id, rikaTranscriptUnits.turnId))
          .where(and(...boundaryConditions))
          .limit(1)
          .pipe(
            Effect.map((found) => found.length > 0),
            Effect.mapError(error),
          )
      }
      const hasOlder = options.after === undefined ? hasExtra : yield* boundaryExists(atOrBefore(options.after))
      let hasNewer = false
      if (options.after !== undefined) hasNewer = hasExtra
      else if (options.before !== undefined) hasNewer = yield* boundaryExists(atOrAfter(options.before))
      const entries: ReadonlyArray<Entry> = selected.map(({ turn, unit, revision, projectionState }) => ({
        turn,
        unit,
        projectionRevision: revision,
        projectionModelPhase: -1,
        projectionState,
      }))
      return {
        entries,
        hasOlder,
        hasNewer,
        oldestCursor: selected[0]?.cursor,
        newestCursor: selected.at(-1)?.cursor,
        usage: yield* usage(threadId),
      }
    }),
    usage,
  }
}
