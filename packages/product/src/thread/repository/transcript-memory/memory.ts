import * as ExecutionProjection from "@rika/product/execution-projection"
import type { Projection, PageCursor, UsageSummary } from "@rika/product/transcript-page"
import { Service, RepositoryError, type Interface } from "./contract"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import type { Unit } from "@rika/transcript/transcript-unit"
import { Effect, Layer, Ref, Schema, Semaphore } from "effect"
import type { TurnId } from "@rika/product/turn-record"
import type { Interface as TurnRepositoryInterface } from "../turn"

const clone = <A>(value: A): A => structuredClone(value)
const cursorFor = (projection: Projection, unit: Unit): PageCursor => ({
  createdAt: projection.turn.createdAt,
  turnId: projection.turn.id,
  orderKey: TranscriptOrdering.encodeUnitOrder(unit.order),
})
const compareText = (left: string, right: string) => {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
const compareCursor = (left: PageCursor, right: PageCursor) =>
  left.createdAt - right.createdAt ||
  compareText(String(left.turnId), String(right.turnId)) ||
  compareText(left.orderKey, right.orderKey)
const validateUnits = (turnId: TurnId, units: ReadonlyArray<Unit>) =>
  Effect.gen(function* () {
    const orders = new Set<string>()
    const keys = new Set<string>()
    for (const unit of units) {
      if (
        !Schema.is(TranscriptUnit.Unit)(unit) ||
        unit.turnId !== turnId ||
        !TranscriptOrdering.hasIntrinsicOrder(unit)
      )
        return yield* RepositoryError.make({ message: `Transcript unit ${unit.key} is invalid` })
      const order = TranscriptOrdering.encodeUnitOrder(unit.order)
      if (keys.has(unit.key) || orders.has(order))
        return yield* RepositoryError.make({ message: `Transcript unit ${unit.key} duplicates a durable identity` })
      keys.add(unit.key)
      orders.add(order)
    }
  })
const materialize = (projection: Projection): Projection => ({
  ...clone(projection),
  units: projection.units.toSorted((a, b) => TranscriptOrdering.compareUnitOrder(a.order, b.order)),
})

const staleChange = (current: Projection | undefined, change: ExecutionProjection.Change): boolean => {
  if (change._tag === "ProjectionPatch")
    return (
      current?.projectionVersion !== ExecutionProjection.projectionVersion || current.revision !== change.baseRevision
    )
  return (
    current !== undefined &&
    (current.projectionVersion > ExecutionProjection.projectionVersion ||
      (current.projectionVersion === ExecutionProjection.projectionVersion && current.revision > change.revision))
  )
}

const projectionUnits = (
  current: Projection | undefined,
  change: ExecutionProjection.Change,
  upsert: ReadonlyArray<Unit>,
): ReadonlyArray<Unit> => {
  const replacing = current !== undefined && current.projectionVersion < ExecutionProjection.projectionVersion
  const units = new Map((replacing ? [] : (current?.units ?? [])).map((unit) => [unit.key, unit]))
  if (change._tag === "ProjectionSnapshot" && (!change.hasOlder || replacing)) units.clear()
  for (const key of change._tag === "ProjectionPatch" ? change.remove : []) units.delete(key)
  for (const unit of upsert) units.set(unit.key, clone(unit))
  return [...units.values()]
}

export const makeMemory = Effect.fn("TranscriptRepository.makeMemory")(function* (
  initialOptions: {
    readonly initial?: ReadonlyArray<Projection>
    readonly turns?: TurnRepositoryInterface
  } = {},
) {
  const initial = new Map<TurnId, Projection>()
  for (const projection of initialOptions.initial ?? []) {
    yield* validateUnits(projection.turn.id, projection.units)
    initial.set(projection.turn.id, materialize(projection))
  }
  const state = yield* Ref.make(initial)
  const commitAdmission = yield* Semaphore.make(1)
  const get: Interface["get"] = (turnId) =>
    Ref.get(state).pipe(
      Effect.map((entries) => {
        const projection = entries.get(turnId)
        if (projection === undefined) return undefined
        const current = clone(projection)
        if (current.projectionVersion !== ExecutionProjection.projectionVersion) return undefined
        if (current.projectorCheckpoint?.version === ExecutionProjection.projectionVersion) return current
        const { projectorCheckpoint: _, ...withoutStaleCheckpoint } = current
        return withoutStaleCheckpoint
      }),
    )
  const usage = (threadId: import("@rika/product/thread-record").ThreadId): Effect.Effect<UsageSummary> =>
    Ref.get(state).pipe(
      Effect.map((entries) => {
        const projections = [...entries.values()]
          .filter(
            (projection) =>
              projection.turn.threadId === threadId &&
              projection.turn.status !== "queued" &&
              projection.projectionVersion === ExecutionProjection.projectionVersion,
          )
          .toSorted(
            (left, right) =>
              left.turn.createdAt - right.turn.createdAt || String(left.turn.id).localeCompare(String(right.turn.id)),
          )
        const contextProjection = projections
          .toReversed()
          .find((projection) => projection.state.usage.context !== undefined)
        const summary = {
          usage: ExecutionProjection.aggregateUsage(projections.map((projection) => projection.state.usage)),
        }
        return contextProjection?.turn._tag !== "AgentExecution"
          ? summary
          : {
              ...summary,
              contextCapacity: {
                contextWindow: contextProjection.turn.executionRoute.main.compaction.contextWindow,
                reserveTokens: contextProjection.turn.executionRoute.main.compaction.reserveTokens,
              },
            }
      }),
    )
  const service = Service.of({
    get,
    listProjectionRecoveryCandidates: (projectionVersion) =>
      Effect.gen(function* () {
        const candidates = new Array<import("@rika/product/transcript-repository").ProjectionRecoveryCandidate>()
        for (const projection of (yield* Ref.get(state)).values()) {
          const turn =
            initialOptions.turns === undefined
              ? projection.turn
              : yield* initialOptions.turns
                  .get(projection.turn.id)
                  .pipe(Effect.mapError((cause) => RepositoryError.make({ message: cause.message })))
          if (
            turn?._tag !== "AgentExecution" ||
            turn.executionLink === undefined ||
            projection.projectionVersion > projectionVersion
          )
            continue
          const active = turn.status === "running" || turn.status === "cancelling"
          const terminalProjectionMissing =
            (turn.status === "completed" || turn.status === "failed" || turn.status === "cancelled") &&
            projection.state.status !== turn.status
          if (projection.projectionVersion < projectionVersion || active || terminalProjectionMissing)
            candidates.push({ threadId: turn.threadId, turnId: turn.id, createdAt: turn.createdAt })
        }
        return candidates
      }),
    commitProjection: Effect.fn("TranscriptRepository.commitProjection")(function* (turn, change, withinTransaction) {
      return yield* commitAdmission.withPermits(1)(
        Effect.gen(function* () {
          const upsert = change._tag === "ProjectionSnapshot" ? change.units : change.upsert
          yield* validateUnits(turn.id, upsert)
          const previous = yield* Ref.get(state)
          const result = yield* Ref.modify(state, (entries) => {
            const current = entries.get(turn.id)
            if (staleChange(current, change)) return ["stale" as const, entries]
            const candidateBase = {
              turn: clone(turn),
              units: projectionUnits(current, change, upsert),
              checkpointGeneration: (current?.checkpointGeneration ?? -1) + 1,
              revision: change.revision,
              state: clone(change.state),
              projectionVersion: ExecutionProjection.projectionVersion,
            }
            const candidate: Projection =
              change.checkpoint === undefined
                ? candidateBase
                : { ...candidateBase, projectorCheckpoint: clone(change.checkpoint) }
            const next = new Map(entries)
            next.set(turn.id, materialize(candidate))
            return ["committed" as const, next]
          })
          if (result === "committed" && withinTransaction !== undefined)
            yield* withinTransaction.pipe(Effect.onError(() => Ref.set(state, previous)))
          return result
        }),
      )
    }),
    replaceUnits: Effect.fn("TranscriptRepository.replaceUnits")(function* (turn, units) {
      return yield* commitAdmission.withPermits(1)(
        Effect.gen(function* () {
          yield* validateUnits(turn.id, units)
          const status =
            turn.status === "queued" || turn.status === "accepted" || turn.status === "cancelling"
              ? "running"
              : turn.status
          const projection: Projection = {
            turn: clone(turn),
            units: units.map(clone),
            checkpointGeneration: ((yield* Ref.get(state)).get(turn.id)?.checkpointGeneration ?? -1) + 1,
            revision: units.reduce((maximum, unit) => Math.max(maximum, unit.revision), 0),
            state: {
              status,
              usage: {
                ...ExecutionProjection.emptyUsageState(),
                sourceComplete: status === "completed" || status === "failed" || status === "cancelled",
              },
              steering: { steeringMessages: 0, followUpMessages: 0 },
            },
            projectionVersion: ExecutionProjection.projectionVersion,
          }
          yield* Ref.update(state, (entries) => new Map(entries).set(turn.id, materialize(projection)))
          return materialize(projection)
        }),
      )
    }),
    page: Effect.fn("TranscriptRepository.page")(function* (threadId, options = {}) {
      if (options.before !== undefined && options.after !== undefined)
        return yield* RepositoryError.make({ message: "Transcript page cannot use before and after together" })
      const limit = options.limit ?? 200
      if (!Number.isInteger(limit) || limit < 1 || limit > 500)
        return yield* RepositoryError.make({ message: "Transcript page limit must be from 1 to 500" })
      const ordered = [...(yield* Ref.get(state)).values()]
        .flatMap((projection) =>
          projection.turn.threadId !== threadId ||
          projection.turn.status === "queued" ||
          (options.projectionVersion !== undefined && projection.projectionVersion !== options.projectionVersion)
            ? []
            : projection.units.map((unit) => ({ projection, unit, cursor: cursorFor(projection, unit) })),
        )
        .toSorted((left, right) => compareCursor(left.cursor, right.cursor))
      const boundaryIndex = (predicate: (cursor: PageCursor) => boolean) => {
        const index = ordered.findIndex(({ cursor }) => predicate(cursor))
        return index < 0 ? ordered.length : index
      }
      const afterStart =
        options.after === undefined ? undefined : boundaryIndex((cursor) => compareCursor(cursor, options.after!) > 0)
      let end: number
      if (afterStart !== undefined) end = Math.min(ordered.length, afterStart + limit)
      else if (options.before === undefined) end = ordered.length
      else end = boundaryIndex((cursor) => compareCursor(cursor, options.before!) >= 0)
      const start = afterStart ?? Math.max(0, end - limit)
      const selected = ordered.slice(start, end)
      const materialized = selected.map(({ projection, unit }) => ({
        turn: clone(projection.turn),
        unit: clone(unit),
        projectionRevision: projection.revision,
        projectionModelPhase: -1,
        projectionState: clone(projection.state),
      }))
      return {
        entries: materialized,
        hasOlder: start > 0,
        hasNewer: end < ordered.length,
        oldestCursor: selected[0]?.cursor,
        newestCursor: selected.at(-1)?.cursor,
        usage: yield* usage(threadId),
      }
    }),
    usage,
  })
  return service
})

export const memoryLayer = (initial?: ReadonlyArray<Projection>) =>
  Layer.effect(Service, makeMemory(initial === undefined ? {} : { initial }))
