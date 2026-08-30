import * as TranscriptUnitOrder from "@rika/transcript/transcript-unit-order"
import type * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Result } from "effect"
import { duplicateKey, limits, type ThreadViewHeader, type ThreadViewPatch, type ThreadViewSnapshot } from "./shape"
import {
  ResyncRequired,
  ThreadViewDuplicateItem,
  ThreadViewForeignThread,
  ThreadViewInvalidPatch,
  ThreadViewNonMonotonicRevision,
  type ThreadViewApplyError,
} from "./apply-error"
import type { ThreadViewTurn, ThreadViewUsage } from "./turn"

export type ThreadViewTurnState = Omit<ThreadViewTurn, "units">

export interface ThreadViewTurnDelta {
  readonly turnId: string
  readonly previous: ThreadViewTurnState | undefined
  readonly current: ThreadViewTurnState | undefined
  readonly upsert: ReadonlyArray<TranscriptUnit.Unit>
  readonly remove: ReadonlyArray<string>
}

export interface ThreadViewDelta {
  readonly revision: number
  readonly headerChanged: boolean
  readonly turns: ReadonlyArray<ThreadViewTurnDelta>
}

interface IndexedTurn {
  state: ThreadViewTurnState
  readonly units: Map<string, TranscriptUnit.Unit>
}

const duplicateError = (
  threadId: ThreadViewSnapshot["thread"]["id"],
  collection: ThreadViewDuplicateItem["collection"],
  key: string,
) =>
  ThreadViewDuplicateItem.make({
    threadId,
    collection,
    key,
  })

const invalidError = (
  threadId: ThreadViewSnapshot["thread"]["id"],
  reason: ThreadViewInvalidPatch["reason"],
  key?: string,
) =>
  key === undefined
    ? ThreadViewInvalidPatch.make({ threadId, reason })
    : ThreadViewInvalidPatch.make({ threadId, reason, key })

const headerFrom = (snapshot: ThreadViewSnapshot): ThreadViewHeader => ({
  thread: snapshot.thread,
  source: snapshot.source,
  pending: snapshot.pending,
  hasOlder: snapshot.hasOlder,
  hasNewer: snapshot.hasNewer,
  usage: snapshot.usage,
})

const turnState = (entry: ThreadViewTurn): ThreadViewTurnState => ({
  turn: entry.turn,
  projectionRevision: entry.projectionRevision,
  usage: entry.usage,
  pendingSteering: entry.pendingSteering ?? [],
  settledSteering: entry.settledSteering ?? [],
})

const changedTurnState = (
  change: Extract<ThreadViewPatch["turnChanges"][number], { readonly _tag: "UpsertTurn" }>,
): ThreadViewTurnState => ({
  turn: change.turn,
  projectionRevision: change.projectionRevision,
  usage: change.usage,
  pendingSteering: change.pendingSteering ?? [],
  settledSteering: change.settledSteering ?? [],
})

const compareTurns = (left: ThreadViewTurnState, right: ThreadViewTurnState): number => {
  const createdAt = left.turn.createdAt - right.turn.createdAt
  return createdAt === 0 ? String(left.turn.id).localeCompare(String(right.turn.id)) : createdAt
}

const compareUnits = (left: TranscriptUnit.Unit, right: TranscriptUnit.Unit): number => {
  const order = TranscriptUnitOrder.compareUnitOrder(left.order, right.order)
  return order === 0 ? left.key.localeCompare(right.key) : order
}

const active = (status: ThreadViewTurnState["turn"]["status"]): boolean =>
  status === "accepted" || status === "running" || status === "cancelling" || status === "waiting"

export class ThreadViewAccumulator {
  private currentHeader: ThreadViewHeader
  private currentRevision: number
  private readonly turnsById: Map<string, IndexedTurn>
  private readonly unitOwners: Map<string, string>
  private readonly activeTurnIds: Set<string>
  private materialized: ThreadViewSnapshot | undefined

  private constructor(
    header: ThreadViewHeader,
    revision: number,
    turnsById: Map<string, IndexedTurn>,
    unitOwners: Map<string, string>,
    activeTurnIds: Set<string>,
  ) {
    this.currentHeader = header
    this.currentRevision = revision
    this.turnsById = turnsById
    this.unitOwners = unitOwners
    this.activeTurnIds = activeTurnIds
  }

  static fromSnapshot(snapshot: ThreadViewSnapshot): Result.Result<ThreadViewAccumulator, ThreadViewApplyError> {
    const threadId = String(snapshot.thread.id)
    const duplicateTurn = duplicateKey(snapshot.turns.map((entry) => String(entry.turn.id)))
    if (duplicateTurn !== undefined)
      return Result.fail(duplicateError(snapshot.thread.id, "snapshot-turns", duplicateTurn))
    const duplicateUnit = duplicateKey(snapshot.turns.flatMap((entry) => entry.units.map((unit) => unit.key)))
    if (duplicateUnit !== undefined)
      return Result.fail(duplicateError(snapshot.thread.id, "snapshot-units", duplicateUnit))
    const duplicatePending = duplicateKey(snapshot.pending.map((entry) => String(entry.id)))
    if (duplicatePending !== undefined)
      return Result.fail(duplicateError(snapshot.thread.id, "pending", duplicatePending))
    if (snapshot.pending.length > limits.pending)
      return Result.fail(invalidError(snapshot.thread.id, "bounds-exceeded"))
    const turnsById = new Map<string, IndexedTurn>()
    const unitOwners = new Map<string, string>()
    const activeTurnIds = new Set<string>()
    for (const entry of snapshot.turns) {
      const turnId = String(entry.turn.id)
      if (String(entry.turn.threadId) !== threadId)
        return Result.fail(invalidError(snapshot.thread.id, "turn-thread-mismatch", turnId))
      const units = new Map<string, TranscriptUnit.Unit>()
      for (const unit of entry.units) {
        if (unit.turnId !== turnId) return Result.fail(invalidError(snapshot.thread.id, "unit-turn-mismatch", unit.key))
        units.set(unit.key, unit)
        unitOwners.set(unit.key, turnId)
      }
      const state = turnState(entry)
      turnsById.set(turnId, { state, units })
      if (active(state.turn.status)) activeTurnIds.add(turnId)
    }
    return Result.succeed(
      new ThreadViewAccumulator(headerFrom(snapshot), snapshot.revision, turnsById, unitOwners, activeTurnIds),
    )
  }

  get thread(): ThreadViewHeader["thread"] {
    return this.currentHeader.thread
  }

  get source(): ThreadViewHeader["source"] {
    return this.currentHeader.source
  }

  get pending(): ThreadViewHeader["pending"] {
    return this.currentHeader.pending
  }

  get hasOlder(): boolean {
    return this.currentHeader.hasOlder
  }

  get hasNewer(): boolean {
    return this.currentHeader.hasNewer
  }

  get usage(): ThreadViewUsage {
    return this.currentHeader.usage
  }

  get revision(): number {
    return this.currentRevision
  }

  get header(): ThreadViewHeader {
    return this.currentHeader
  }

  get turnCount(): number {
    return this.turnsById.size
  }

  turn(turnId: string): ThreadViewTurnState | undefined {
    return this.turnsById.get(turnId)?.state
  }

  units(turnId: string): ReadonlyArray<TranscriptUnit.Unit> {
    const indexed = this.turnsById.get(turnId)
    return indexed === undefined ? [] : [...indexed.units.values()].toSorted(compareUnits)
  }

  activeTurn(): ThreadViewTurnState | undefined {
    let selected: ThreadViewTurnState | undefined
    for (const turnId of this.activeTurnIds) {
      const candidate = this.turnsById.get(turnId)?.state
      if (candidate !== undefined && (selected === undefined || compareTurns(candidate, selected) < 0))
        selected = candidate
    }
    return selected
  }

  snapshot(): ThreadViewSnapshot {
    if (this.materialized !== undefined) return this.materialized
    const turns = [...this.turnsById.values()]
      .map((entry) => ({ ...entry.state, units: [...entry.units.values()].toSorted(compareUnits) }))
      .toSorted((left, right) => compareTurns(left, right))
    this.materialized = {
      ...this.currentHeader,
      revision: this.currentRevision,
      turns,
    }
    return this.materialized
  }

  private revisionError(patch: ThreadViewPatch): ThreadViewApplyError | undefined {
    const threadId = this.currentHeader.thread.id
    if (String(patch.threadId) !== String(threadId))
      return ThreadViewForeignThread.make({ expectedThreadId: threadId, receivedThreadId: patch.threadId })
    if (patch.revision <= patch.baseRevision)
      return ThreadViewNonMonotonicRevision.make({
        threadId,
        baseRevision: patch.baseRevision,
        revision: patch.revision,
      })
    if (patch.baseRevision !== this.currentRevision || patch.revision !== patch.baseRevision + 1)
      return ResyncRequired.make({
        threadId,
        expectedRevision: this.currentRevision + 1,
        receivedBaseRevision: patch.baseRevision,
        currentRevision: this.currentRevision,
      })
    return undefined
  }

  private collectionError(patch: ThreadViewPatch, header: ThreadViewHeader): ThreadViewApplyError | undefined {
    const threadId = this.currentHeader.thread.id
    const duplicateUpsert = duplicateKey(patch.upsert.map((unit) => unit.key))
    if (duplicateUpsert !== undefined) return duplicateError(threadId, "upsert", duplicateUpsert)
    const duplicateRemove = duplicateKey(patch.remove)
    if (duplicateRemove !== undefined) return duplicateError(threadId, "remove", duplicateRemove)
    const removeSet = new Set(patch.remove)
    const conflict = patch.upsert.find((unit) => removeSet.has(unit.key))
    if (conflict !== undefined) return invalidError(threadId, "conflicting-item-change", conflict.key)
    const duplicateTurnChange = duplicateKey(
      patch.turnChanges.map((change) => String(change._tag === "UpsertTurn" ? change.turn.id : change.turnId)),
    )
    if (duplicateTurnChange !== undefined) return duplicateError(threadId, "turn-changes", duplicateTurnChange)
    if (String(header.thread.id) !== String(threadId))
      return invalidError(threadId, "invalid-header", String(header.thread.id))
    const duplicatePending = duplicateKey(header.pending.map((entry) => String(entry.id)))
    if (duplicatePending !== undefined) return duplicateError(threadId, "pending", duplicatePending)
    if (header.pending.length > limits.pending) return invalidError(threadId, "bounds-exceeded")
    return undefined
  }

  private unitError(patch: ThreadViewPatch): ThreadViewApplyError | undefined {
    const threadId = this.currentHeader.thread.id
    for (const key of patch.remove) if (!this.unitOwners.has(key)) return invalidError(threadId, "missing-item", key)
    for (const unit of patch.upsert) {
      const owner = this.unitOwners.get(unit.key)
      if (owner !== undefined && owner !== unit.turnId) return invalidError(threadId, "unit-turn-mismatch", unit.key)
      const current = owner === undefined ? undefined : this.turnsById.get(owner)?.units.get(unit.key)
      if (current !== undefined && unit.revision < current.revision)
        return invalidError(threadId, "unit-revision-regressed", unit.key)
    }
    return undefined
  }

  private turnChangesError(
    patch: ThreadViewPatch,
    changes: Map<string, ThreadViewPatch["turnChanges"][number]>,
  ): ThreadViewApplyError | undefined {
    const threadId = this.currentHeader.thread.id
    for (const change of patch.turnChanges) {
      const key = String(change._tag === "UpsertTurn" ? change.turn.id : change.turnId)
      const current = this.turnsById.get(key)
      if (change._tag === "RemoveTurn" && current === undefined) return invalidError(threadId, "missing-turn", key)
      if (change._tag === "UpsertTurn" && String(change.turn.threadId) !== String(threadId))
        return invalidError(threadId, "turn-thread-mismatch", key)
      if (
        change._tag === "UpsertTurn" &&
        current !== undefined &&
        change.projectionRevision < current.state.projectionRevision
      )
        return invalidError(threadId, "projection-revision-regressed", key)
      changes.set(key, change)
    }
    return undefined
  }

  private upsertTurnError(
    patch: ThreadViewPatch,
    changes: Map<string, ThreadViewPatch["turnChanges"][number]>,
  ): ThreadViewApplyError | undefined {
    const threadId = this.currentHeader.thread.id
    for (const unit of patch.upsert) {
      const change = changes.get(unit.turnId)
      const exists = change?._tag === "UpsertTurn" || (change?._tag !== "RemoveTurn" && this.turnsById.has(unit.turnId))
      if (!exists) return invalidError(threadId, "missing-turn", unit.turnId)
    }
    return undefined
  }

  apply(patch: ThreadViewPatch): Result.Result<ThreadViewDelta, ThreadViewApplyError> {
    const revisionError = this.revisionError(patch)
    if (revisionError !== undefined) return Result.fail(revisionError)
    const removeSet = new Set(patch.remove)
    const header = patch.header ?? this.currentHeader
    const collectionError = this.collectionError(patch, header)
    if (collectionError !== undefined) return Result.fail(collectionError)
    const unitError = this.unitError(patch)
    if (unitError !== undefined) return Result.fail(unitError)
    const changes = new Map<string, ThreadViewPatch["turnChanges"][number]>()
    const turnChangesError = this.turnChangesError(patch, changes)
    if (turnChangesError !== undefined) return Result.fail(turnChangesError)
    const upsertTurnError = this.upsertTurnError(patch, changes)
    if (upsertTurnError !== undefined) return Result.fail(upsertTurnError)

    const deltas = new Map<
      string,
      {
        previous: ThreadViewTurnState | undefined
        current: ThreadViewTurnState | undefined
        upsert: Array<TranscriptUnit.Unit>
        remove: Array<string>
      }
    >()
    const deltaFor = (turnId: string) => {
      const existing = deltas.get(turnId)
      if (existing !== undefined) return existing
      const previous = this.turnsById.get(turnId)?.state
      const created = { previous, current: previous, upsert: [], remove: [] }
      deltas.set(turnId, created)
      return created
    }
    for (const key of patch.remove) {
      const owner = this.unitOwners.get(key)!
      const indexed = this.turnsById.get(owner)!
      indexed.units.delete(key)
      this.unitOwners.delete(key)
      deltaFor(owner).remove.push(key)
    }
    for (const change of patch.turnChanges) {
      if (change._tag === "RemoveTurn") {
        const key = String(change.turnId)
        const indexed = this.turnsById.get(key)!
        const delta = deltaFor(key)
        for (const unitKey of indexed.units.keys()) {
          this.unitOwners.delete(unitKey)
          if (!removeSet.has(unitKey)) delta.remove.push(unitKey)
        }
        delta.current = undefined
        this.turnsById.delete(key)
        this.activeTurnIds.delete(key)
      } else {
        const key = String(change.turn.id)
        const state = changedTurnState(change)
        const current = this.turnsById.get(key)
        const delta = deltaFor(key)
        if (current === undefined) this.turnsById.set(key, { state, units: new Map() })
        else current.state = state
        delta.current = state
        if (active(state.turn.status)) this.activeTurnIds.add(key)
        else this.activeTurnIds.delete(key)
      }
    }
    for (const unit of patch.upsert) {
      const indexed = this.turnsById.get(unit.turnId)!
      indexed.units.set(unit.key, unit)
      this.unitOwners.set(unit.key, unit.turnId)
      deltaFor(unit.turnId).upsert.push(unit)
    }
    this.currentHeader = header
    this.currentRevision = patch.revision
    this.materialized = undefined
    return Result.succeed({
      revision: patch.revision,
      headerChanged: patch.header !== undefined,
      turns: [...deltas].map(([turnId, delta]) => ({ turnId, ...delta })),
    })
  }
}

export const fromSnapshot = (
  snapshot: ThreadViewSnapshot,
): Result.Result<ThreadViewAccumulator, ThreadViewApplyError> => ThreadViewAccumulator.fromSnapshot(snapshot)
