import { Service } from "@rika/product/usage-repository"
export { Service }
import { Effect, Layer, Ref } from "effect"
import { RepositoryError } from "@rika/product/usage-repository"
import type { ActiveInterval, Materialized, SourceUsage, TurnUsage, Aggregate, CommitResult } from "./usage-model"
import { projectionVersion } from "./usage-model"

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
            previous !== undefined &&
            (previous.projectionVersion !== expectedVersion ||
              previous.revision !== expectedRevision ||
              (previous.projectionVersion >= projectionVersion &&
                (previous.projectionVersion !== projectionVersion || previous.sourceComplete)))
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
              sourceComplete: value.sourceComplete,
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
