import { Clock, Context, Effect, Layer, Ref, Schema, Semaphore } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"

export const projectionVersion = 1

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

export interface TurnUsage extends Materialized {
  readonly turnId: string
  readonly threadId: string
  readonly revision: number
  readonly projectionVersion: number
  readonly foldJson?: string
}

export interface Aggregate extends Materialized {
  readonly turns: number
  readonly activeSince?: number
}

export type CommitResult = { readonly _tag: "Applied"; readonly value: TurnUsage } | { readonly _tag: "Conflict" }
export type RepairClaim = { readonly _tag: "Claimed"; readonly checkpoint?: string } | { readonly _tag: "Busy" }

export class RepositoryError extends Schema.TaggedErrorClass<RepositoryError>()("UsageRepositoryError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly admit: (turnId: string, threadId: string) => Effect.Effect<TurnUsage, RepositoryError>
  readonly readTurn: (turnId: string) => Effect.Effect<TurnUsage | undefined, RepositoryError>
  readonly readThread: (threadId: string) => Effect.Effect<Aggregate, RepositoryError>
  readonly readGlobal: Effect.Effect<Aggregate, RepositoryError>
  readonly loadFold: (
    turnId: string,
  ) => Effect.Effect<
    { readonly revision: number; readonly projectionVersion: number; readonly foldJson?: string } | undefined,
    RepositoryError
  >
  readonly commitFold: (
    turnId: string,
    expectedRevision: number,
    foldJson: string,
    totals: Materialized,
  ) => Effect.Effect<CommitResult, RepositoryError>
  readonly commitRepairFold: (
    turnId: string,
    token: string,
    expectedRevision: number,
    foldJson: string,
    totals: Materialized,
  ) => Effect.Effect<CommitResult, RepositoryError>
  readonly claimRepair: (turnId: string, token: string) => Effect.Effect<RepairClaim, RepositoryError>
  readonly checkpointRepair: (
    turnId: string,
    token: string,
    checkpoint: string,
  ) => Effect.Effect<boolean, RepositoryError>
  readonly finishRepair: (turnId: string, token: string) => Effect.Effect<boolean, RepositoryError>
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
const validateAggregate = (value: Aggregate) => {
  safe(value.turns, "turns")
  safe(value.activeSince, "activeSince")
  validate(value)
  return value
}
const unionActiveTime = (
  values: ReadonlyArray<ReadonlyArray<ActiveInterval> | undefined>,
): { readonly activeMillis: number; readonly activeSince?: number } | undefined => {
  if (values.length === 0 || values.some((value) => value === undefined)) return undefined
  const intervals = values
    .flatMap((value) => value ?? [])
    .toSorted((left, right) => left.start - right.start || (left.end ?? Infinity) - (right.end ?? Infinity))
  let total = 0
  let start: number | undefined
  let end: number | undefined
  for (const interval of intervals) {
    if (start === undefined) {
      start = interval.start
      end = interval.end
    } else if (end === undefined) continue
    else if (interval.start <= end) end = interval.end === undefined ? undefined : Math.max(end, interval.end)
    else {
      total += end - start
      start = interval.start
      end = interval.end
    }
  }
  if (start === undefined) return { activeMillis: 0 }
  return end === undefined ? { activeMillis: total, activeSince: start } : { activeMillis: total + end - start }
}
const aggregate = (values: ReadonlyArray<TurnUsage>): Aggregate => {
  const active = unionActiveTime(values.map((value) => value.activeIntervals))
  return {
    turns: values.length,
    ...(values.length > 0 && values.every((value) => value.costNanoUsd !== undefined)
      ? { costNanoUsd: values.reduce((sum, value) => sum + (value.costNanoUsd ?? 0), 0) }
      : {}),
    ...(values.length > 0 && values.every((value) => value.tokens !== undefined)
      ? { tokens: values.reduce((sum, value) => sum + (value.tokens ?? 0), 0) }
      : {}),
    ...active,
    pricedAttempts: values.reduce((sum, value) => sum + value.pricedAttempts, 0),
    unpricedAttempts: values.reduce((sum, value) => sum + value.unpricedAttempts, 0),
    countedAttempts: values.reduce((sum, value) => sum + value.countedAttempts, 0),
    uncountedAttempts: values.reduce((sum, value) => sum + value.uncountedAttempts, 0),
    sourceComplete: values.length > 0 && values.every((value) => value.sourceComplete),
  }
}

const makeMemory = Effect.gen(function* () {
  const rows = yield* Ref.make(new Map<string, TurnUsage>())
  const repairs = yield* Ref.make(new Map<string, { token: string; checkpoint?: string; updatedAt: number }>())
  const repairAdmission = yield* Semaphore.make(1)
  const readTurn = Effect.fn("UsageRepository.readTurn")(function* (turnId: string) {
    const value = (yield* Ref.get(rows)).get(turnId)
    return value === undefined ? undefined : clone(value)
  })
  return Service.of({
    admit: Effect.fn("UsageRepository.admit")(function* (turnId, threadId) {
      return yield* Ref.modify(rows, (current) => {
        const existing = current.get(turnId)
        if (existing !== undefined) return [clone(existing), current]
        const value: TurnUsage = { turnId, threadId, revision: 0, projectionVersion, ...zero }
        return [clone(value), new Map(current).set(turnId, value)]
      })
    }),
    readTurn,
    readThread: Effect.fn("UsageRepository.readThread")(function* (threadId) {
      const current = yield* Ref.get(rows)
      return yield* Effect.try({
        try: () => validateAggregate(aggregate([...current.values()].filter((value) => value.threadId === threadId))),
        catch: error,
      })
    }),
    readGlobal: Ref.get(rows).pipe(
      Effect.flatMap((current) =>
        Effect.try({ try: () => validateAggregate(aggregate([...current.values()])), catch: error }),
      ),
    ),
    loadFold: Effect.fn("UsageRepository.loadFold")(function* (turnId) {
      const value = yield* readTurn(turnId)
      return value === undefined
        ? undefined
        : {
            revision: value.revision,
            projectionVersion: value.projectionVersion,
            ...(value.foldJson === undefined ? {} : { foldJson: value.foldJson }),
          }
    }),
    commitFold: Effect.fn("UsageRepository.commitFold")(function* (turnId, expectedRevision, foldJson, totals) {
      validate(totals)
      return yield* Ref.modify(rows, (current): [CommitResult, Map<string, TurnUsage>] => {
        const previous = current.get(turnId)
        if (
          previous === undefined ||
          previous.revision !== expectedRevision ||
          previous.projectionVersion !== projectionVersion
        )
          return [{ _tag: "Conflict" }, current]
        const value: TurnUsage = clone({ ...previous, ...totals, foldJson, revision: previous.revision + 1 })
        return [{ _tag: "Applied", value: clone(value) }, new Map(current).set(turnId, value)]
      })
    }),
    commitRepairFold: Effect.fn("UsageRepository.commitRepairFold")(
      (turnId, token, expectedRevision, foldJson, totals) =>
        repairAdmission.withPermits(1)(
          Effect.gen(function* () {
            validate(totals)
            const now = yield* Clock.currentTimeMillis
            const repair = (yield* Ref.get(repairs)).get(turnId)
            return yield* Ref.modify(rows, (current): [CommitResult, Map<string, TurnUsage>] => {
              const previous = current.get(turnId)
              if (
                previous === undefined ||
                previous.revision !== expectedRevision ||
                previous.projectionVersion !== projectionVersion ||
                repair?.token !== token ||
                repair.updatedAt < now - repairLeaseMillis
              )
                return [{ _tag: "Conflict" }, current]
              const value: TurnUsage = clone({ ...previous, ...totals, foldJson, revision: previous.revision + 1 })
              return [{ _tag: "Applied", value: clone(value) }, new Map(current).set(turnId, value)]
            })
          }),
        ),
    ),
    claimRepair: Effect.fn("UsageRepository.claimRepair")(function* (turnId, token) {
      const now = yield* Clock.currentTimeMillis
      return yield* repairAdmission.withPermits(1)(
        Ref.modify(
          repairs,
          (current): [RepairClaim, Map<string, { token: string; checkpoint?: string; updatedAt: number }>] => {
            const previous = current.get(turnId)
            if (previous !== undefined && previous.token !== token && previous.updatedAt >= now - repairLeaseMillis)
              return [{ _tag: "Busy" }, current]
            const next = previous?.token === token ? { ...previous, updatedAt: now } : { token, updatedAt: now }
            return [
              { _tag: "Claimed", ...(next.checkpoint === undefined ? {} : { checkpoint: next.checkpoint }) },
              new Map(current).set(turnId, next),
            ]
          },
        ),
      )
    }),
    checkpointRepair: Effect.fn("UsageRepository.checkpointRepair")(function* (turnId, token, checkpoint) {
      const now = yield* Clock.currentTimeMillis
      return yield* repairAdmission.withPermits(1)(
        Ref.modify(repairs, (current) => {
          const previous = current.get(turnId)
          if (previous?.token !== token || previous.updatedAt < now - repairLeaseMillis) return [false, current]
          return [true, new Map(current).set(turnId, { token, checkpoint, updatedAt: now })]
        }),
      )
    }),
    finishRepair: Effect.fn("UsageRepository.finishRepair")(function* (turnId, token) {
      return yield* repairAdmission.withPermits(1)(
        Ref.modify(repairs, (current) => {
          if (current.get(turnId)?.token !== token) return [false, current]
          const next = new Map(current)
          next.delete(turnId)
          return [true, next]
        }),
      )
    }),
  })
})

export const memoryLayer = Layer.effect(Service, makeMemory)

const error = (cause: unknown) => RepositoryError.make({ message: String(cause) })
const repairLeaseMillis = 5 * 60 * 1_000
const Row = Schema.Struct({
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
const decodeIntervals = (json: string) =>
  Schema.decodeUnknownEffect(ActiveIntervalsJson)(json).pipe(
    Effect.tap((intervals) =>
      Effect.try({ try: () => validate({ ...zero, activeIntervals: intervals }), catch: error }),
    ),
    Effect.mapError(error),
  )
const decodeRow = (input: unknown) =>
  Effect.gen(function* () {
    const row = yield* Schema.decodeUnknownEffect(Row)(input)
    if (row.projection_version !== projectionVersion)
      return yield* RepositoryError.make({
        message: `Usage projection ${row.projection_version} is not supported by projection ${projectionVersion}`,
      })
    const activeIntervals =
      row.active_intervals_json === null ? undefined : yield* decodeIntervals(row.active_intervals_json)
    const value: TurnUsage = {
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
const select = (where: Effect.Effect<ReadonlyArray<unknown>, RepositoryError>) =>
  where.pipe(Effect.flatMap((values) => Effect.all(values.map(decodeRow))))
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const readTurn = Effect.fn("UsageRepository.readTurn")(function* (turnId: string) {
      const values = yield* select(
        sql`SELECT * FROM rika_turn_usage WHERE turn_id = ${turnId}`.pipe(Effect.mapError(error)),
      )
      return values[0]
    })
    const readAggregate = (effect: Effect.Effect<ReadonlyArray<unknown>, RepositoryError>) =>
      select(effect).pipe(
        Effect.flatMap((values) =>
          Effect.try({
            try: () => validateAggregate(aggregate(values)),
            catch: error,
          }),
        ),
      )
    return Service.of({
      admit: Effect.fn("UsageRepository.admit")(function* (turnId, threadId) {
        const now = yield* Clock.currentTimeMillis
        yield* sql`INSERT OR IGNORE INTO rika_turn_usage (turn_id, thread_id, updated_at) VALUES (${turnId}, ${threadId}, ${now})`.pipe(
          Effect.mapError(error),
        )
        return (yield* readTurn(turnId))!
      }),
      readTurn,
      readThread: Effect.fn("UsageRepository.readThread")((threadId) =>
        readAggregate(
          sql`SELECT turn_id, thread_id, revision, projection_version, NULL AS fold_json,
          cost_nano_usd, tokens, active_millis, active_intervals_json, priced_attempts, unpriced_attempts,
          counted_attempts, uncounted_attempts, source_complete
          FROM rika_turn_usage WHERE thread_id = ${threadId}`.pipe(Effect.mapError(error)),
        ),
      ),
      readGlobal: readAggregate(
        sql`SELECT turn_id, thread_id, revision, projection_version, NULL AS fold_json,
        cost_nano_usd, tokens, active_millis, active_intervals_json, priced_attempts, unpriced_attempts,
        counted_attempts, uncounted_attempts, source_complete
        FROM rika_turn_usage`.pipe(Effect.mapError(error)),
      ),
      loadFold: Effect.fn("UsageRepository.loadFold")(function* (turnId) {
        const value = yield* readTurn(turnId)
        return value === undefined
          ? undefined
          : {
              revision: value.revision,
              projectionVersion: value.projectionVersion,
              ...(value.foldJson === undefined ? {} : { foldJson: value.foldJson }),
            }
      }),
      commitFold: Effect.fn("UsageRepository.commitFold")(function* (turnId, expectedRevision, foldJson, totals) {
        validate(totals)
        const now = yield* Clock.currentTimeMillis
        const activeIntervalsJson =
          totals.activeIntervals === undefined
            ? null
            : yield* Schema.encodeEffect(ActiveIntervalsJson)(totals.activeIntervals).pipe(Effect.mapError(error))
        const changed = yield* sql`UPDATE rika_turn_usage SET revision = revision + 1, fold_json = ${foldJson},
        cost_nano_usd = ${totals.costNanoUsd ?? null}, tokens = ${totals.tokens ?? null}, active_millis = ${totals.activeMillis ?? null},
        active_intervals_json = ${activeIntervalsJson},
        priced_attempts = ${totals.pricedAttempts}, unpriced_attempts = ${totals.unpricedAttempts}, counted_attempts = ${totals.countedAttempts},
        uncounted_attempts = ${totals.uncountedAttempts}, source_complete = ${totals.sourceComplete ? 1 : 0}, updated_at = ${now}
        WHERE turn_id = ${turnId} AND revision = ${expectedRevision} AND projection_version = ${projectionVersion} RETURNING *`.pipe(
          Effect.mapError(error),
        )
        if (changed.length === 0) return { _tag: "Conflict" } as const
        return { _tag: "Applied", value: yield* decodeRow(changed[0]) } as const
      }),
      commitRepairFold: Effect.fn("UsageRepository.commitRepairFold")(
        function* (turnId, token, expectedRevision, foldJson, totals) {
          validate(totals)
          const now = yield* Clock.currentTimeMillis
          const activeIntervalsJson =
            totals.activeIntervals === undefined
              ? null
              : yield* Schema.encodeEffect(ActiveIntervalsJson)(totals.activeIntervals).pipe(Effect.mapError(error))
          const changed = yield* sql`UPDATE rika_turn_usage SET revision = revision + 1, fold_json = ${foldJson},
        cost_nano_usd = ${totals.costNanoUsd ?? null}, tokens = ${totals.tokens ?? null}, active_millis = ${totals.activeMillis ?? null},
        active_intervals_json = ${activeIntervalsJson},
        priced_attempts = ${totals.pricedAttempts}, unpriced_attempts = ${totals.unpricedAttempts}, counted_attempts = ${totals.countedAttempts},
        uncounted_attempts = ${totals.uncountedAttempts}, source_complete = ${totals.sourceComplete ? 1 : 0}, updated_at = ${now}
        WHERE turn_id = ${turnId} AND revision = ${expectedRevision} AND projection_version = ${projectionVersion}
          AND EXISTS (SELECT 1 FROM rika_usage_repairs WHERE turn_id = ${turnId} AND claim_token = ${token}
            AND updated_at >= ${now - repairLeaseMillis})
        RETURNING *`.pipe(Effect.mapError(error))
          if (changed.length === 0) return { _tag: "Conflict" } as const
          return { _tag: "Applied", value: yield* decodeRow(changed[0]) } as const
        },
      ),
      claimRepair: Effect.fn("UsageRepository.claimRepair")(function* (turnId, token) {
        const now = yield* Clock.currentTimeMillis
        yield* sql`INSERT OR IGNORE INTO rika_usage_repairs (turn_id, claim_token, updated_at) VALUES (${turnId}, ${token}, ${now})`.pipe(
          Effect.mapError(error),
        )
        yield* sql`UPDATE rika_usage_repairs SET checkpoint_json = CASE WHEN claim_token = ${token} THEN checkpoint_json ELSE NULL END,
          claim_token = ${token}, updated_at = ${now}
          WHERE turn_id = ${turnId} AND (claim_token = ${token} OR updated_at < ${now - repairLeaseMillis})`.pipe(
          Effect.mapError(error),
        )
        const rows =
          yield* sql`SELECT claim_token, checkpoint_json FROM rika_usage_repairs WHERE turn_id = ${turnId}`.pipe(
            Effect.mapError(error),
          )
        const row = rows[0] as { claim_token: string | null; checkpoint_json: string | null }
        return row.claim_token === token
          ? { _tag: "Claimed", ...(row.checkpoint_json === null ? {} : { checkpoint: row.checkpoint_json }) }
          : { _tag: "Busy" }
      }),
      checkpointRepair: Effect.fn("UsageRepository.checkpointRepair")(function* (turnId, token, checkpoint) {
        const now = yield* Clock.currentTimeMillis
        const rows = yield* sql`UPDATE rika_usage_repairs SET checkpoint_json = ${checkpoint}, updated_at = ${now}
            WHERE turn_id = ${turnId} AND claim_token = ${token} AND updated_at >= ${now - repairLeaseMillis}
            RETURNING turn_id`.pipe(Effect.mapError(error))
        return rows.length === 1
      }),
      finishRepair: Effect.fn("UsageRepository.finishRepair")(function* (turnId, token) {
        const rows =
          yield* sql`DELETE FROM rika_usage_repairs WHERE turn_id = ${turnId} AND claim_token = ${token} RETURNING turn_id`.pipe(
            Effect.mapError(error),
          )
        return rows.length === 1
      }),
    })
  }),
)
