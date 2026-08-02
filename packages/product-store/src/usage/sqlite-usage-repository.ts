import { Service, RepositoryError } from "@rika/product/usage-repository"
import * as Contract from "@rika/product/usage-repository"
export { Service, RepositoryError, Contract }
import { Effect, Layer, Clock, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { projectionVersion } from "./usage-model"
import type { ActiveInterval, Materialized, SourceUsage, TurnUsage, Aggregate } from "./usage-model"
export { projectionVersion }
export type { Materialized } from "./usage-model"
export type { Interface } from "@rika/product/usage-repository"

const error = (cause: unknown) => RepositoryError.make({ message: String(cause) })
const safe = (value: number | undefined, name: string) => {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
    throw new Error(`${name} must be a non-negative safe integer`)
}
const validate = (totals: Materialized) => {
  safe(totals.costNanoUsd, "costNanoUsd")
  safe(totals.tokens, "tokens")
  safe(totals.activeMillis, "activeMillis")
  if (totals.activeIntervals !== undefined)
    for (const interval of totals.activeIntervals) {
      safe(interval.start, "activeIntervals.start")
      safe(interval.end, "activeIntervals.end")
      if (interval.end !== undefined && interval.end < interval.start)
        throw new Error("activeIntervals.end must not precede start")
    }
  safe(totals.pricedAttempts, "pricedAttempts")
  safe(totals.unpricedAttempts, "unpricedAttempts")
  safe(totals.countedAttempts, "countedAttempts")
  safe(totals.uncountedAttempts, "uncountedAttempts")
}
const unionActiveTime = (values: ReadonlyArray<ReadonlyArray<ActiveInterval> | undefined>) => {
  if (!values.some((value) => value !== undefined)) return {}
  const intervals = values
    .flatMap((value) => value ?? [])
    .toSorted((a, b) => a.start - b.start || (a.end ?? Infinity) - (b.end ?? Infinity))
  const unioned: Array<ActiveInterval> = []
  for (const interval of intervals) {
    const previous = unioned.at(-1)
    if (previous === undefined || (previous.end !== undefined && interval.start > previous.end)) {
      unioned.push({ ...interval })
      continue
    }
    unioned[unioned.length - 1] = {
      start: previous.start,
      ...(previous.end === undefined || interval.end === undefined
        ? {}
        : { end: Math.max(previous.end, interval.end) }),
    }
  }
  const activeMillis = unioned.reduce(
    (total, interval) => total + (interval.end === undefined ? 0 : interval.end - interval.start),
    0,
  )
  const active = unioned.find((interval) => interval.end === undefined)
  return {
    activeIntervals: unioned,
    activeMillis,
    ...(active === undefined ? {} : { activeSince: active.start }),
  }
}
const materialize = (values: ReadonlyArray<SourceUsage>): Materialized & { readonly activeSince?: number } => ({
  ...(values.some((value) => value.costNanoUsd !== undefined)
    ? { costNanoUsd: values.reduce((n, value) => n + (value.costNanoUsd ?? 0), 0) }
    : {}),
  ...(values.some((value) => value.tokens !== undefined)
    ? { tokens: values.reduce((n, value) => n + (value.tokens ?? 0), 0) }
    : {}),
  ...unionActiveTime(values.map((value) => value.activeIntervals)),
  pricedAttempts: values.reduce((n, value) => n + value.pricedAttempts, 0),
  unpricedAttempts: values.reduce((n, value) => n + value.unpricedAttempts, 0),
  countedAttempts: values.reduce((n, value) => n + value.countedAttempts, 0),
  uncountedAttempts: values.reduce((n, value) => n + value.uncountedAttempts, 0),
  sourceComplete: values.length > 0 && values.every((value) => value.sourceComplete),
})
const assertTurnOwnership = (values: ReadonlyArray<SourceUsage>) => {
  const threads = new Map<string, string>()
  for (const value of values) {
    const threadId = threads.get(value.turnId)
    if (threadId !== undefined && threadId !== value.threadId)
      throw new Error(`Turn ${value.turnId} has usage owned by multiple threads`)
    threads.set(value.turnId, value.threadId)
  }
}
const checked = <A>(values: ReadonlyArray<SourceUsage>, project: (values: ReadonlyArray<SourceUsage>) => A) =>
  Effect.try({
    try: () => {
      assertTurnOwnership(values)
      return project(values)
    },
    catch: error,
  })
const turnAggregate = (values: ReadonlyArray<SourceUsage>): TurnUsage | undefined => {
  const first = values[0]
  if (first === undefined) return undefined
  return {
    turnId: first.turnId,
    threadId: first.threadId,
    revision: values.reduce((n, value) => n + value.revision, 0),
    projectionVersion: Math.min(...values.map((value) => value.projectionVersion)),
    ...materialize(values),
  }
}
const aggregate = (values: ReadonlyArray<SourceUsage>): Aggregate => ({
  turns: new Set(values.map((value) => value.turnId)).size,
  revision: values.reduce((n, value) => n + value.revision, 0),
  projectionVersion:
    values.length === 0 ? projectionVersion : Math.min(...values.map((value) => value.projectionVersion)),
  ...materialize(values),
})

import { UsageRow as Row } from "./usage-row-codec"
const ActiveIntervalSchema = Schema.Struct({ start: Schema.Finite, end: Schema.optionalKey(Schema.Finite) })
const ActiveIntervalsJson = Schema.fromJsonString(Schema.Array(ActiveIntervalSchema))
const decodeRow = (input: unknown) =>
  Effect.gen(function* () {
    const row = yield* Schema.decodeUnknownEffect(Row)(input)
    const activeIntervals =
      row.active_intervals_json === null
        ? undefined
        : yield* Schema.decodeUnknownEffect(ActiveIntervalsJson)(row.active_intervals_json)
    const value: SourceUsage = {
      sourceId: row.source_id,
      turnId: row.turn_id,
      threadId: row.thread_id,
      revision: row.revision,
      projectionVersion: row.projection_version,
      ...(row.fold_json === null ? {} : { foldJson: row.fold_json }),
      ...(row.cost_nano_usd === null ? {} : { costNanoUsd: row.cost_nano_usd }),
      ...(row.tokens === null ? {} : { tokens: row.tokens }),
      ...(row.active_millis === null ? {} : { activeMillis: row.active_millis }),
      ...(activeIntervals === undefined ? {} : { activeIntervals }),
      pricedAttempts: row.priced_attempts,
      unpricedAttempts: row.unpriced_attempts,
      countedAttempts: row.counted_attempts,
      uncountedAttempts: row.uncounted_attempts,
      sourceComplete: row.source_complete === 1,
    }
    yield* Effect.try({ try: () => validate(value), catch: error })
    return value
  }).pipe(Effect.mapError(error))
const select = (effect: Effect.Effect<ReadonlyArray<unknown>, RepositoryError>) =>
  effect.pipe(Effect.flatMap((rows) => Effect.all(rows.map(decodeRow))))
const encoded = (totals: Materialized) =>
  totals.activeIntervals === undefined
    ? Effect.succeed(null)
    : Schema.encodeEffect(ActiveIntervalsJson)(totals.activeIntervals).pipe(Effect.mapError(error))

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const readSource = Effect.fn("UsageRepository.readSource")(function* (sourceId: string, turnId: string) {
      return (yield* select(
        sql`SELECT * FROM rika_turn_usage WHERE turn_id = ${turnId} AND source_id = ${sourceId}`.pipe(
          Effect.mapError(error),
        ),
      ))[0]
    })
    const readRows = (query: Effect.Effect<ReadonlyArray<unknown>, RepositoryError>) => select(query)
    const commit = Effect.fn("UsageRepository.commitSource")(function* (
      sourceId: string,
      turnId: string,
      expectedRevision: number,
      foldJson: string,
      totals: Materialized,
    ) {
      yield* Effect.try({ try: () => validate(totals), catch: error })
      const now = yield* Clock.currentTimeMillis
      const intervals = yield* encoded(totals)
      const changed = yield* sql`UPDATE rika_turn_usage SET revision = revision + 1, fold_json = ${foldJson},
      cost_nano_usd = ${totals.costNanoUsd ?? null}, tokens = ${totals.tokens ?? null}, active_millis = ${totals.activeMillis ?? null},
      active_intervals_json = ${intervals}, priced_attempts = ${totals.pricedAttempts}, unpriced_attempts = ${totals.unpricedAttempts},
      counted_attempts = ${totals.countedAttempts}, uncounted_attempts = ${totals.uncountedAttempts},
      source_complete = ${totals.sourceComplete ? 1 : 0}, updated_at = ${now}
      WHERE turn_id = ${turnId} AND source_id = ${sourceId} AND revision = ${expectedRevision}
        AND projection_version = ${projectionVersion} RETURNING *`.pipe(Effect.mapError(error))
      return changed.length === 0
        ? ({ _tag: "Conflict", value: yield* readSource(sourceId, turnId) } as const)
        : ({ _tag: "Applied", value: yield* decodeRow(changed[0]) } as const)
    })
    return Service.of({
      admitSource: Effect.fn("UsageRepository.admitSource")(function* (sourceId, turnId, threadId) {
        const now = yield* Clock.currentTimeMillis
        yield* sql`INSERT OR IGNORE INTO rika_turn_usage (source_id, turn_id, thread_id, projection_version, updated_at)
        VALUES (${sourceId}, ${turnId}, ${threadId}, ${projectionVersion}, ${now})`.pipe(Effect.mapError(error))
        const value = (yield* readSource(sourceId, turnId))!
        if (value.threadId !== threadId)
          return yield* RepositoryError.make({
            message: `Usage source ${sourceId} for Turn ${turnId} belongs to thread ${value.threadId}`,
          })
        return value
      }),
      readSource,
      readTurn: Effect.fn("UsageRepository.readTurn")(function* (turnId) {
        return yield* checked(
          yield* readRows(sql`SELECT * FROM rika_turn_usage WHERE turn_id = ${turnId}`.pipe(Effect.mapError(error))),
          turnAggregate,
        )
      }),
      readThread: Effect.fn("UsageRepository.readThread")(function* (threadId) {
        const values = yield* readRows(sql`SELECT * FROM rika_turn_usage`.pipe(Effect.mapError(error)))
        yield* checked(values, () => undefined)
        return aggregate(values.filter((value) => value.threadId === threadId))
      }),
      readGlobal: readRows(sql`SELECT * FROM rika_turn_usage`.pipe(Effect.mapError(error))).pipe(
        Effect.flatMap((values) => checked(values, aggregate)),
      ),
      loadSourceFold: Effect.fn("UsageRepository.loadSourceFold")(function* (sourceId, turnId) {
        const value = yield* readSource(sourceId, turnId)
        return value === undefined
          ? undefined
          : {
              revision: value.revision,
              projectionVersion: value.projectionVersion,
              sourceComplete: value.sourceComplete,
              ...(value.foldJson === undefined ? {} : { foldJson: value.foldJson }),
            }
      }),
      commitSource: commit,
      replaceSource: Effect.fn("UsageRepository.replaceSource")(
        function* (sourceId, turnId, threadId, expectedVersion, expectedRevision, foldJson, totals) {
          yield* Effect.try({ try: () => validate(totals), catch: error })
          const now = yield* Clock.currentTimeMillis
          const intervals = yield* encoded(totals)
          const changed = yield* sql`INSERT INTO rika_turn_usage
        (source_id, turn_id, thread_id, revision, projection_version, fold_json, cost_nano_usd, tokens, active_millis,
         active_intervals_json, priced_attempts, unpriced_attempts, counted_attempts, uncounted_attempts, source_complete, updated_at)
        VALUES (${sourceId}, ${turnId}, ${threadId}, 1, ${projectionVersion}, ${foldJson}, ${totals.costNanoUsd ?? null},
          ${totals.tokens ?? null}, ${totals.activeMillis ?? null}, ${intervals}, ${totals.pricedAttempts}, ${totals.unpricedAttempts},
          ${totals.countedAttempts}, ${totals.uncountedAttempts}, ${totals.sourceComplete ? 1 : 0}, ${now})
        ON CONFLICT(turn_id, source_id) DO UPDATE SET revision = rika_turn_usage.revision + 1,
          projection_version = ${projectionVersion}, fold_json = ${foldJson}, cost_nano_usd = ${totals.costNanoUsd ?? null},
          tokens = ${totals.tokens ?? null}, active_millis = ${totals.activeMillis ?? null}, active_intervals_json = ${intervals},
          priced_attempts = ${totals.pricedAttempts}, unpriced_attempts = ${totals.unpricedAttempts}, counted_attempts = ${totals.countedAttempts},
          uncounted_attempts = ${totals.uncountedAttempts}, source_complete = ${totals.sourceComplete ? 1 : 0}, updated_at = ${now}
        WHERE rika_turn_usage.projection_version = ${expectedVersion} AND rika_turn_usage.revision = ${expectedRevision}
          AND rika_turn_usage.thread_id = ${threadId}
          AND (rika_turn_usage.projection_version < ${projectionVersion} OR
            (rika_turn_usage.projection_version = ${projectionVersion} AND rika_turn_usage.source_complete = 0)) RETURNING *`.pipe(
            Effect.mapError(error),
          )
          return changed.length === 0
            ? ({ _tag: "Conflict", value: yield* readSource(sourceId, turnId) } as const)
            : ({ _tag: "Applied", value: yield* decodeRow(changed[0]) } as const)
        },
      ),
    })
  }),
)

export { memoryLayer } from "./memory-usage-repository"
