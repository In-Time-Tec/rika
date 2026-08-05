import type { Projection } from "@rika/product/transcript-page"
import { TurnResult } from "@rika/product/thread-result"
import { Service } from "@rika/product/transcript-repository"
import type { Interface } from "@rika/product/transcript-repository"
export { Service }
import * as TranscriptCorrelation from "@rika/transcript/child-parent-correlation"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import { Effect, Layer, Ref } from "effect"
type WriteResult = Effect.Success<ReturnType<Interface["commitDelta"]>>
import * as TurnRepository from "../turn/memory-turn-repository"
import type { Interface as TurnRepositoryInterface } from "@rika/product/turn-repository"
import { Turn, TurnId } from "@rika/product/turn-record"
import type { RunningRecordedShellTurn, TerminalRecordedShellTurn } from "@rika/product/thread-result"

import { invalidatedProjectionVersion, RepositoryError } from "@rika/product/transcript-repository"
import { support } from "./transcript-repository-support"
import { materializeMemory, memoryEntry, sameAttachment } from "./transcript-memory-state"
import type { MemoryEntry } from "./transcript-memory-state"
const {
  clone,
  sameTurn,
  refoldTurn,
  storedProjection,
  pageSize,
  cursorFor,
  withUnits,
  recordedShellProjection,
  validateRecordedShellProjection,
  before,
  after,
  compareDescending,
  validateUnits,
  validateStateScalars,
  validateProjectionVersion,
  validateCurrentProjectionVersion,
  validateCheckpoint,
  validateAttachmentSet,
  validatePageOptions,
  validateMemoryUnits,
  validateMemoryCheckpoint,
  validateDelta,
} = support
type MemoryWrite =
  | { readonly _tag: "Success"; readonly result: WriteResult }
  | { readonly _tag: "Failure"; readonly error: RepositoryError }
type MemoryRefoldProjectionWrite = { readonly _tag: "Commit"; readonly value: void } | { readonly _tag: "Stale" }
const memoryWriteResult = (write: MemoryWrite): Effect.Effect<WriteResult, RepositoryError> =>
  write._tag === "Success" ? Effect.succeed(write.result) : Effect.fail(write.error)
export interface MemoryOptions {
  readonly initial?: ReadonlyArray<Projection>
  readonly turns?: TurnRepositoryInterface
}
export const makeMemory = (memoryOptions: MemoryOptions = {}) =>
  Effect.gen(function* () {
    const initial = memoryOptions.initial ?? []
    const turns = memoryOptions.turns
    const coordinator = turns === undefined ? undefined : TurnRepository.memoryCoordinator(turns)
    if (turns !== undefined && coordinator === undefined)
      return yield* RepositoryError.make({ message: "Memory transcript repository requires a memory Turn repository" })
    const withLock = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      coordinator === undefined ? effect : coordinator.withLock(effect)
    const initialEntries = new Map<TurnId, MemoryEntry>()
    for (const projection of initial) {
      if (initialEntries.has(projection.turn.id))
        return yield* RepositoryError.make({ message: `Transcript ${projection.turn.id} is duplicated` })
      if (!Number.isSafeInteger(projection.checkpointGeneration) || projection.checkpointGeneration < 0)
        return yield* RepositoryError.make({
          message: `Transcript ${projection.turn.id} has an invalid checkpoint generation`,
        })
      yield* validateUnits(projection.units)
      yield* validateMemoryUnits(projection.units)
      const options = {
        executionCheckpoints: projection.executionCheckpoints,
        projectionVersion: projection.projectionVersion,
        expectedGeneration: undefined,
      }
      yield* validateProjectionVersion(projection.turn.id, projection.projectionVersion)
      yield* validateStateScalars(
        projection.turn.id,
        "root projection",
        TranscriptProjection.Projection.projectionState(projection),
      )
      const invalidatedEmpty =
        projection.projectionVersion === invalidatedProjectionVersion &&
        projection.units.length === 0 &&
        projection.executionCheckpoints.length === 0
      if (TurnResult.isRecordedShell(projection.turn)) {
        if (projection.executionCheckpoints.length !== 0)
          return yield* RepositoryError.make({
            message: `Recorded shell turn ${projection.turn.id} has execution checkpoints`,
          })
        yield* validateRecordedShellProjection(
          projection.turn,
          withUnits(TranscriptProjection.Projection.projectionState(projection), projection.units),
          projection.projectionVersion,
        )
      } else if (!invalidatedEmpty) {
        yield* validateCheckpoint(
          projection.turn,
          TranscriptProjection.Projection.projectionState(projection),
          options,
          true,
        )
        yield* validateMemoryCheckpoint(options)
        yield* validateAttachmentSet(projection.turn, projection.units, projection.executionCheckpoints)
      }
      initialEntries.set(
        projection.turn.id,
        memoryEntry(
          projection.turn,
          withUnits(TranscriptProjection.Projection.projectionState(projection), projection.units),
          options,
          projection.checkpointGeneration,
        ),
      )
    }
    const state = yield* Ref.make(initialEntries)
    const get = Effect.fn("TranscriptRepository.get")(function* (turnId: TurnId) {
      const found = (yield* withLock(Ref.get(state))).get(turnId)
      return found === undefined ? undefined : materializeMemory(found)
    })
    const listProjectionRecoveryCandidates = Effect.fn("TranscriptRepository.listProjectionRecoveryCandidates")(
      function* (projectionVersion: number) {
        yield* validateCurrentProjectionVersion(projectionVersion)
        if (coordinator === undefined)
          return yield* RepositoryError.make({
            message: "Projection recovery requires paired memory Turn and Transcript repositories",
          })
        return yield* withLock(
          Effect.gen(function* () {
            const [entries, agentTurns] = yield* Effect.all([Ref.get(state), coordinator.agentExecutions])
            return agentTurns
              .filter((turn) => turn.status !== "queued")
              .filter((turn) => {
                const entry = entries.get(turn.id)
                return (
                  entry === undefined ||
                  entry.projection.projectionVersion < projectionVersion ||
                  [...entry.checkpointsByKey.values()].some((checkpoint) => checkpoint.status === undefined)
                )
              })
              .toSorted((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
              .map((turn) => ({ threadId: turn.threadId, turnId: turn.id }))
          }),
        )
      },
    )
    const insertRecordedShell = Effect.fn("TranscriptRepository.insertRecordedShell")(function* (
      turn: RunningRecordedShellTurn | TerminalRecordedShellTurn,
      projectionVersion: number,
    ) {
      if (coordinator === undefined)
        return yield* RepositoryError.make({
          message: "Recorded shell writes require paired memory Turn and Transcript repositories",
        })
      const projection = recordedShellProjection(turn)
      yield* validateUnits(projection.units)
      yield* validateMemoryUnits(projection.units)
      yield* validateRecordedShellProjection(turn, projection, projectionVersion)
      const written = yield* coordinator.writeRecordedShell(undefined, turn, (storedTurn) =>
        Ref.modify(
          state,
          (entries): readonly [TurnRepository.MemoryRefoldWrite<Projection>, Map<TurnId, MemoryEntry>] => {
            if (entries.has(storedTurn.id)) return [{ _tag: "Stale" as const }, entries] as const
            const entry = memoryEntry(
              storedTurn,
              projection,
              { executionCheckpoints: [], projectionVersion, expectedGeneration: undefined },
              0,
            )
            entries.set(storedTurn.id, entry)
            return [{ _tag: "Commit" as const, value: materializeMemory(entry) }, entries] as const
          },
        ),
      )
      if (written._tag === "Stale")
        return yield* RepositoryError.make({ message: `Recorded shell turn ${turn.id} already exists` })
      return written.value.value
    })
    return Service.of({
      get,
      listProjectionRecoveryCandidates,
      commitDelta: Effect.fn("TranscriptRepository.commitDelta")(function* (turn, projectionState, delta, options) {
        yield* validateDelta(delta)
        yield* validateCheckpoint(turn, projectionState, options)
        yield* validateMemoryUnits(delta.upsert)
        yield* validateMemoryCheckpoint(options)
        const write = yield* withLock(
          Ref.modify(state, (entries): readonly [MemoryWrite, Map<TurnId, MemoryEntry>] => {
            const current = entries.get(turn.id)
            if (
              current?.projection.checkpointGeneration !== options.expectedGeneration ||
              (current !== undefined && current.projection.projectionVersion !== options.projectionVersion) ||
              (current !== undefined && current.projection.revision > projectionState.revision)
            )
              return [{ _tag: "Success", result: "stale" }, entries]
            const supplied = new Map(
              options.executionCheckpoints.map((checkpoint) => [checkpoint.executionKey, checkpoint]),
            )
            const checkpointFor = (key: string) => supplied.get(key) ?? current?.checkpointsByKey.get(key)
            const removals = new Set(delta.remove)
            const upserts = new Map(delta.upsert.map((unit) => [unit.key, unit]))
            const unitFor = (key: string) =>
              removals.has(key) ? undefined : (upserts.get(key) ?? current?.unitsByKey.get(key))
            for (const checkpoint of options.executionCheckpoints) {
              const previous = current?.checkpointsByKey.get(checkpoint.executionKey)
              if (previous !== undefined && !sameAttachment(previous, checkpoint))
                return [
                  {
                    _tag: "Failure",
                    error: RepositoryError.make({
                      message: `Execution checkpoint ${checkpoint.executionKey} changed its intrinsic identity`,
                    }),
                  },
                  entries,
                ]
              const attachment = checkpoint.attachment
              if (attachment !== undefined) {
                const parent = unitFor(attachment.parentUnitKey)
                if (
                  parent === undefined ||
                  checkpointFor(attachment.parentExecutionKey) === undefined ||
                  TranscriptCorrelation.executionKey(parent.turnId) !== attachment.parentExecutionKey ||
                  parent.content._tag !== "Block" ||
                  parent.content.block._tag !== "ToolCall" ||
                  parent.content.block.id !== attachment.parentId ||
                  TranscriptOrdering.encodeUnitOrder(parent.order) !== attachment.parentOrderKey
                )
                  return [
                    {
                      _tag: "Failure",
                      error: RepositoryError.make({
                        message: `Transcript ${turn.id} has a contradictory attachment for ${checkpoint.executionKey}`,
                      }),
                    },
                    entries,
                  ]
              }
            }
            const rootKey = TranscriptCorrelation.executionKey(turn.executionLink?.runId ?? String(turn.id))
            const root = checkpointFor(rootKey)
            if (
              root === undefined ||
              root.attachment !== undefined ||
              !TranscriptProjection.Projection.sameProjectionState(projectionState, root.state)
            )
              return [
                {
                  _tag: "Failure",
                  error: RepositoryError.make({ message: `Transcript ${turn.id} has contradictory root fold state` }),
                },
                entries,
              ]
            for (const key of removals)
              if (current !== undefined && current.attachmentsByUnit.has(key))
                return [
                  {
                    _tag: "Failure",
                    error: RepositoryError.make({ message: `Transcript unit ${key} has an attached execution` }),
                  },
                  entries,
                ]
            for (const unit of delta.upsert) {
              const previous = current?.unitsByKey.get(unit.key)
              const orderKey = TranscriptOrdering.encodeUnitOrder(unit.order)
              const previousToolId =
                previous?.content._tag === "Block" && previous.content.block._tag === "ToolCall"
                  ? previous.content.block.id
                  : undefined
              const toolId =
                unit.content._tag === "Block" && unit.content.block._tag === "ToolCall"
                  ? unit.content.block.id
                  : undefined
              if (
                previous !== undefined &&
                (previous.turnId !== unit.turnId ||
                  TranscriptOrdering.encodeUnitOrder(previous.order) !== orderKey ||
                  previousToolId !== toolId ||
                  previous.parentId !== unit.parentId)
              )
                return [
                  {
                    _tag: "Failure",
                    error: RepositoryError.make({
                      message: `Transcript unit ${unit.key} changed its intrinsic identity`,
                    }),
                  },
                  entries,
                ]
              const owner = current?.orderOwners.get(orderKey)
              if (owner !== undefined && owner !== unit.key && !removals.has(owner))
                return [
                  {
                    _tag: "Failure",
                    error: RepositoryError.make({ message: `Transcript unit order ${orderKey} is duplicated` }),
                  },
                  entries,
                ]
              const executionKey = TranscriptCorrelation.executionKey(unit.turnId)
              const checkpoint = checkpointFor(executionKey)
              if (checkpoint === undefined)
                return [
                  {
                    _tag: "Failure",
                    error: RepositoryError.make({ message: `Transcript unit ${unit.key} has no execution checkpoint` }),
                  },
                  entries,
                ]
              if (executionKey === rootKey) {
                if (unit.parentId !== undefined)
                  return [
                    {
                      _tag: "Failure",
                      error: RepositoryError.make({ message: `Transcript ${turn.id} attaches a root unit` }),
                    },
                    entries,
                  ]
              } else {
                const attachment = checkpoint.attachment
                const parent = attachment === undefined ? undefined : unitFor(attachment.parentUnitKey)
                if (
                  attachment === undefined ||
                  parent === undefined ||
                  unit.parentId !== attachment.parentId ||
                  TranscriptOrdering.encodeUnitOrder(unit.order) !==
                    TranscriptOrdering.encodeUnitOrder(
                      TranscriptOrdering.childOrder(
                        parent.order,
                        checkpoint.executionId,
                        TranscriptOrdering.localOrder(unit.order),
                      ),
                    )
                )
                  return [
                    {
                      _tag: "Failure",
                      error: RepositoryError.make({
                        message: `Transcript ${turn.id} has a contradictory unit path for ${executionKey}`,
                      }),
                    },
                    entries,
                  ]
              }
            }
            const next = current ?? memoryEntry(turn, withUnits(projectionState, []), options, -1)
            for (const key of delta.remove) {
              const previous = next.unitsByKey.get(key)
              if (previous !== undefined) next.orderOwners.delete(TranscriptOrdering.encodeUnitOrder(previous.order))
              next.unitsByKey.delete(key)
            }
            for (const unit of delta.upsert) {
              const copy = clone(unit)
              next.unitsByKey.set(unit.key, copy)
              next.orderOwners.set(TranscriptOrdering.encodeUnitOrder(unit.order), unit.key)
            }
            for (const checkpoint of options.executionCheckpoints) {
              const copy = clone(checkpoint)
              next.checkpointsByKey.set(checkpoint.executionKey, copy)
              if (copy.attachment !== undefined)
                next.attachmentsByUnit.set(copy.attachment.parentUnitKey, copy.executionKey)
            }
            next.projection = storedProjection(
              turn,
              withUnits(projectionState, []),
              { executionCheckpoints: [], projectionVersion: options.projectionVersion },
              (current?.projection.checkpointGeneration ?? -1) + 1,
            )
            entries.set(turn.id, next)
            return [{ _tag: "Success", result: "committed" }, entries]
          }),
        )
        return yield* memoryWriteResult(write)
      }),
      replaceForRefold: Effect.fn("TranscriptRepository.replaceForRefold")(function* (turn, projection, options) {
        yield* validateUnits(projection.units)
        yield* validateCheckpoint(turn, TranscriptProjection.Projection.projectionState(projection), options, true)
        yield* validateMemoryUnits(projection.units)
        yield* validateMemoryCheckpoint(options)
        yield* validateAttachmentSet(turn, projection.units, options.executionCheckpoints)
        const replacementTurn = yield* refoldTurn(turn, projection, options)
        const writeProjection = (adopted: Turn) =>
          Ref.modify(state, (entries): readonly [MemoryRefoldProjectionWrite, Map<TurnId, MemoryEntry>] => {
            const current = entries.get(turn.id)
            if (
              current === undefined ||
              current.projection.projectionVersion !== options.expectedProjectionVersion ||
              current.projection.checkpointGeneration !== options.expectedGeneration ||
              options.projectionVersion <= current.projection.projectionVersion ||
              !TurnResult.isAgentExecution(current.projection.turn) ||
              current.projection.turn.status !== turn.status
            )
              return [{ _tag: "Stale" as const }, entries] as const
            entries.set(turn.id, memoryEntry(adopted, projection, options, current.projection.checkpointGeneration + 1))
            return [{ _tag: "Commit", value: undefined }, entries]
          })
        if (coordinator === undefined) {
          const written = yield* withLock(writeProjection(replacementTurn))
          return written._tag === "Stale"
            ? { _tag: "Stale" as const }
            : { _tag: "Committed" as const, turn: replacementTurn }
        }
        const written = yield* coordinator.adoptRefold(turn, replacementTurn.status, writeProjection)
        return written._tag === "Stale"
          ? { _tag: "Stale" as const }
          : { _tag: "Committed" as const, turn: written.turn }
      }),
      createRecordedShell: insertRecordedShell,
      copyRecordedShell: insertRecordedShell,
      settleRecordedShell: Effect.fn("TranscriptRepository.settleRecordedShell")(
        function* (expected, turn, expectedGeneration, projectionVersion) {
          if (coordinator === undefined)
            return yield* RepositoryError.make({
              message: "Recorded shell writes require paired memory Turn and Transcript repositories",
            })
          const projection = recordedShellProjection(turn)
          yield* validateUnits(projection.units)
          yield* validateMemoryUnits(projection.units)
          yield* validateRecordedShellProjection(turn, projection, projectionVersion)
          const written = yield* coordinator.writeRecordedShell(expected, turn, (storedTurn) =>
            Ref.modify(
              state,
              (entries): readonly [TurnRepository.MemoryRefoldWrite<Projection>, Map<TurnId, MemoryEntry>] => {
                const current = entries.get(storedTurn.id)
                if (
                  current === undefined ||
                  current.projection.checkpointGeneration !== expectedGeneration ||
                  current.projection.projectionVersion !== projectionVersion ||
                  !TurnResult.isRecordedShell(current.projection.turn) ||
                  !sameTurn(current.projection.turn, expected)
                )
                  return [{ _tag: "Stale" as const }, entries] as const
                const entry = memoryEntry(
                  storedTurn,
                  projection,
                  { executionCheckpoints: [], projectionVersion, expectedGeneration: undefined },
                  current.projection.checkpointGeneration + 1,
                )
                entries.set(storedTurn.id, entry)
                return [{ _tag: "Commit" as const, value: materializeMemory(entry) }, entries] as const
              },
            ),
          )
          return written._tag === "Stale"
            ? { _tag: "Stale" as const }
            : { _tag: "Committed" as const, projection: written.value.value }
        },
      ),
      page: Effect.fn("TranscriptRepository.page")(function* (threadId, options = {}) {
        yield* validatePageOptions(options)
        const limit = pageSize(options.limit)
        const projections = [...(yield* withLock(Ref.get(state))).values()].map(materializeMemory)
        const descending = projections
          .filter(
            (projection) =>
              projection.turn.threadId === threadId &&
              projection.turn.status !== "queued" &&
              (options.projectionVersion === undefined || projection.projectionVersion === options.projectionVersion),
          )
          .flatMap((projection) =>
            projection.units.map((unit) => ({
              turn: projection.turn,
              unit,
              projectionRevision: projection.revision,
              projectionModelPhase: projection.modelPhase,
              ...(projection.costUsd === undefined ? {} : { projectionCostUsd: projection.costUsd }),
            })),
          )
          .filter((entry) => options.before === undefined || before(entry, options.before))
          .filter((entry) => options.after === undefined || after(entry, options.after))
          .toSorted(compareDescending)
        const selected = options.after === undefined ? descending.slice(0, limit) : descending.slice(-limit)
        const pageEntries = selected.toReversed().map(clone)
        const threadCostUsd = projections
          .filter((projection) => projection.turn.threadId === threadId)
          .reduce((total, projection) => total + (projection.costUsd ?? 0), 0)
        return {
          entries: pageEntries,
          hasOlder: options.after === undefined ? descending.length > limit : false,
          hasNewer: options.after !== undefined && descending.length > limit,
          oldestCursor: cursorFor(pageEntries[0]),
          newestCursor: cursorFor(pageEntries.at(-1)),
          threadCostUsd,
        }
      }),
      globalCostUsd: withLock(Ref.get(state)).pipe(
        Effect.map((entries) =>
          [...entries.values()].reduce((total, entry) => total + (entry.projection.costUsd ?? 0), 0),
        ),
      ),
    })
  })
export const memoryLayer = Layer.effect(Service, makeMemory())
export const memoryLayerWithTurns = Layer.effect(
  Service,
  Effect.gen(function* () {
    return yield* makeMemory({ turns: yield* TurnRepository.Service })
  }),
)
