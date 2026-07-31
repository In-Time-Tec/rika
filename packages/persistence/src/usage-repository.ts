import { Clock, Context, Effect, Layer, Ref, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"

export const projectionVersion = 2

export interface ActiveInterval {
  readonly start: number
  readonly end?: number
}

export interface Materialized {
  readonly costNanoUsd?: number
  readonly tokens?: number
  readonly activeMillis?: number
  readonly activeIntervals?: ReadonlyArray<ActiveInterval>
  readonly pricedAttempts: number
  readonly unpricedAttempts: number
  readonly countedAttempts: number
  readonly uncountedAttempts: number
  readonly sourceComplete: boolean
}

export interface SourceUsage extends Materialized {
  readonly sourceId: string
  readonly turnId: string
  readonly threadId: string
  readonly revision: number
  readonly projectionVersion: number
  readonly foldJson?: string
}

export interface TurnUsage extends Materialized {
  readonly turnId: string
  readonly threadId: string
  readonly revision: number
  readonly projectionVersion: number
}

export interface Aggregate extends Materialized {
  readonly turns: number
  readonly revision: number
  readonly projectionVersion: number
  readonly activeSince?: number
}

export type CommitResult =
  | { readonly _tag: "Applied"; readonly value: SourceUsage }
  | { readonly _tag: "Conflict"; readonly value: SourceUsage | undefined }

export class RepositoryError extends Schema.TaggedErrorClass<RepositoryError>()("UsageRepositoryError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly admitSource: (
    sourceId: string,
    turnId: string,
    threadId: string,
  ) => Effect.Effect<SourceUsage, RepositoryError>
  readonly readSource: (sourceId: string, turnId: string) => Effect.Effect<SourceUsage | undefined, RepositoryError>
  readonly readTurn: (turnId: string) => Effect.Effect<TurnUsage | undefined, RepositoryError>
  readonly readThread: (threadId: string) => Effect.Effect<Aggregate, RepositoryError>
  readonly readGlobal: Effect.Effect<Aggregate, RepositoryError>
  readonly loadSourceFold: (
    sourceId: string,
    turnId: string,
  ) => Effect.Effect<
    { readonly revision: number; readonly projectionVersion: number; readonly foldJson?: string } | undefined,
    RepositoryError
  >
  readonly commitSource: (
    sourceId: string,
    turnId: string,
    expectedRevision: number,
    foldJson: string,
    totals: Materialized,
  ) => Effect.Effect<CommitResult, RepositoryError>
  readonly replaceSource: (
    sourceId: string,
    turnId: string,
    threadId: string,
    expectedProjectionVersion: number,
    expectedRevision: number,
    foldJson: string,
    totals: Materialized,
  ) => Effect.Effect<CommitResult, RepositoryError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/persistence/usage-repository/Service") {}

const zero: Materialized = {
  pricedAttempts: 0,
  unpricedAttempts: 0,
  countedAttempts: 0,
  uncountedAttempts: 0,
  sourceComplete: false,
}
const clone = <A>(value: A): A => structuredClone(value)
const error = (cause: unknown) => RepositoryError.make({ message: String(cause) })
const memoryKey = (sourceId: string, turnId: string) => `${turnId}\0${sourceId}`
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

export interface MemoryOptions {
  readonly initial?: ReadonlyArray<SourceUsage>
}

export const makeMemory = (options: MemoryOptions = {}) =>
  Effect.gen(function* () {
    const initial = yield* Effect.try({
      try: () => {
        const values = options.initial ?? []
        assertTurnOwnership(values)
        const rows = new Map<string, SourceUsage>()
        for (const value of values) {
          validate(value)
          const key = memoryKey(value.sourceId, value.turnId)
          if (rows.has(key)) throw new Error(`Usage source ${value.sourceId} for Turn ${value.turnId} is duplicated`)
          rows.set(key, clone(value))
        }
        return rows
      },
      catch: error,
    })
    const rows = yield* Ref.make(initial)
    const readSource = Effect.fn("UsageRepository.readSource")(function* (sourceId: string, turnId: string) {
      const value = (yield* Ref.get(rows)).get(memoryKey(sourceId, turnId))
      return value === undefined ? undefined : clone(value)
    })
    const replace = (
      sourceId: string,
      turnId: string,
      threadId: string,
      expectedVersion: number,
      expectedRevision: number,
      foldJson: string,
      totals: Materialized,
    ) =>
      Effect.gen(function* () {
        yield* Effect.try({ try: () => validate(totals), catch: error })
        return yield* Ref.modify(rows, (current): [CommitResult, Map<string, SourceUsage>] => {
          const identity = memoryKey(sourceId, turnId)
          const previous = current.get(identity)
          if (previous !== undefined && previous.threadId !== threadId)
            return [{ _tag: "Conflict", value: clone(previous) }, current]
          if (
            previous?.projectionVersion === projectionVersion ||
            (previous !== undefined &&
              (previous.projectionVersion !== expectedVersion || previous.revision !== expectedRevision))
          )
            return [{ _tag: "Conflict", value: previous === undefined ? undefined : clone(previous) }, current]
          const value: SourceUsage = clone({
            sourceId,
            turnId,
            threadId,
            revision: (previous?.revision ?? 0) + 1,
            projectionVersion,
            foldJson,
            ...totals,
          })
          return [{ _tag: "Applied", value: clone(value) }, new Map(current).set(identity, value)]
        })
      })
    return Service.of({
      admitSource: Effect.fn("UsageRepository.admitSource")(function* (sourceId, turnId, threadId) {
        const existing = (yield* Ref.get(rows)).get(memoryKey(sourceId, turnId))
        if (existing !== undefined && existing.threadId !== threadId)
          return yield* RepositoryError.make({
            message: `Usage source ${sourceId} for Turn ${turnId} belongs to thread ${existing.threadId}`,
          })
        return yield* Ref.modify(rows, (current) => {
          const identity = memoryKey(sourceId, turnId)
          const previous = current.get(identity)
          if (previous !== undefined) return [clone(previous), current]
          const value: SourceUsage = { sourceId, turnId, threadId, revision: 0, projectionVersion, ...zero }
          return [clone(value), new Map(current).set(identity, value)]
        })
      }),
      readSource,
      readTurn: Effect.fn("UsageRepository.readTurn")(function* (turnId) {
        return yield* checked(
          [...(yield* Ref.get(rows)).values()].filter((value) => value.turnId === turnId),
          turnAggregate,
        )
      }),
      readThread: Effect.fn("UsageRepository.readThread")(function* (threadId) {
        const values = [...(yield* Ref.get(rows)).values()]
        yield* checked(values, () => undefined)
        return aggregate(values.filter((value) => value.threadId === threadId))
      }),
      readGlobal: Ref.get(rows).pipe(Effect.flatMap((current) => checked([...current.values()], aggregate))),
      loadSourceFold: Effect.fn("UsageRepository.loadSourceFold")(function* (sourceId, turnId) {
        const value = yield* readSource(sourceId, turnId)
        return value === undefined
          ? undefined
          : {
              revision: value.revision,
              projectionVersion: value.projectionVersion,
              ...(value.foldJson === undefined ? {} : { foldJson: value.foldJson }),
            }
      }),
      commitSource: Effect.fn("UsageRepository.commitSource")(
        function* (sourceId, turnId, expectedRevision, foldJson, totals) {
          yield* Effect.try({ try: () => validate(totals), catch: error })
          return yield* Ref.modify(rows, (current): [CommitResult, Map<string, SourceUsage>] => {
            const identity = memoryKey(sourceId, turnId)
            const previous = current.get(identity)
            if (
              previous === undefined ||
              previous.revision !== expectedRevision ||
              previous.projectionVersion !== projectionVersion
            )
              return [{ _tag: "Conflict", value: previous === undefined ? undefined : clone(previous) }, current]
            const value = clone({ ...previous, ...totals, foldJson, revision: previous.revision + 1 })
            return [{ _tag: "Applied", value: clone(value) }, new Map(current).set(identity, value)]
          })
        },
      ),
      replaceSource: Effect.fn("UsageRepository.replaceSource")(replace),
    })
  })

export const memoryLayer = Layer.effect(Service, makeMemory())

const Row = Schema.Struct({
  source_id: Schema.String,
  turn_id: Schema.String,
  thread_id: Schema.String,
  revision: Schema.Finite,
  projection_version: Schema.Finite,
  fold_json: Schema.NullOr(Schema.String),
  cost_nano_usd: Schema.NullOr(Schema.Finite),
  tokens: Schema.NullOr(Schema.Finite),
  active_millis: Schema.NullOr(Schema.Finite),
  active_intervals_json: Schema.NullOr(Schema.String),
  priced_attempts: Schema.Finite,
  unpriced_attempts: Schema.Finite,
  counted_attempts: Schema.Finite,
  uncounted_attempts: Schema.Finite,
  source_complete: Schema.Finite,
})
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
          AND rika_turn_usage.projection_version < ${projectionVersion} RETURNING *`.pipe(Effect.mapError(error))
          return changed.length === 0
            ? ({ _tag: "Conflict", value: yield* readSource(sourceId, turnId) } as const)
            : ({ _tag: "Applied", value: yield* decodeRow(changed[0]) } as const)
        },
      ),
    })
  }),
)
