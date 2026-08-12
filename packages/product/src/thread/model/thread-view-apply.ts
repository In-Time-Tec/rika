import * as TranscriptUnitOrder from "@rika/transcript/transcript-unit-order"
import { Function, Result } from "effect"
import { duplicateKey, limits, type ThreadViewPatch, type ThreadViewSnapshot } from "./thread-view-shape"
import {
  ResyncRequired,
  ThreadViewDuplicateItem,
  ThreadViewForeignThread,
  ThreadViewInvalidPatch,
  ThreadViewNonMonotonicRevision,
  type ThreadViewApplyError,
} from "./thread-view-apply-error"

const duplicateError = (snapshot: ThreadViewSnapshot, collection: ThreadViewDuplicateItem["collection"], key: string) =>
  ThreadViewDuplicateItem.make({
    threadId: snapshot.thread.id,
    collection,
    key,
  })

const invalidError = (snapshot: ThreadViewSnapshot, reason: ThreadViewInvalidPatch["reason"], key?: string) =>
  ThreadViewInvalidPatch.make({
    threadId: snapshot.thread.id,
    reason,
    ...(key === undefined ? {} : { key }),
  })

const validateCurrent = (snapshot: ThreadViewSnapshot): ThreadViewApplyError | undefined => {
  const threadId = String(snapshot.thread.id)
  const duplicateTurn = duplicateKey(snapshot.turns.map((entry) => String(entry.turn.id)))
  if (duplicateTurn !== undefined) return duplicateError(snapshot, "snapshot-turns", duplicateTurn)
  const units = snapshot.turns.flatMap((entry) => entry.units)
  const duplicateUnit = duplicateKey(units.map((unit) => unit.key))
  if (duplicateUnit !== undefined) return duplicateError(snapshot, "snapshot-units", duplicateUnit)
  const duplicatePending = duplicateKey(snapshot.pending.map((pending) => String(pending.id)))
  if (duplicatePending !== undefined) return duplicateError(snapshot, "pending", duplicatePending)
  if (snapshot.pending.length > limits.pending) return invalidError(snapshot, "bounds-exceeded")
  for (const entry of snapshot.turns) {
    if (String(entry.turn.threadId) !== threadId)
      return invalidError(snapshot, "turn-thread-mismatch", String(entry.turn.id))
    for (const unit of entry.units)
      if (unit.turnId !== String(entry.turn.id)) return invalidError(snapshot, "unit-turn-mismatch", unit.key)
  }
  return undefined
}

const applyImpl = (
  snapshot: ThreadViewSnapshot,
  patch: ThreadViewPatch,
): Result.Result<ThreadViewSnapshot, ThreadViewApplyError> => {
  if (String(patch.threadId) !== String(snapshot.thread.id))
    return Result.fail(
      ThreadViewForeignThread.make({
        expectedThreadId: snapshot.thread.id,
        receivedThreadId: patch.threadId,
      }),
    )
  if (patch.revision <= patch.baseRevision)
    return Result.fail(
      ThreadViewNonMonotonicRevision.make({
        threadId: snapshot.thread.id,
        baseRevision: patch.baseRevision,
        revision: patch.revision,
      }),
    )
  if (patch.baseRevision !== snapshot.revision || patch.revision !== patch.baseRevision + 1)
    return Result.fail(
      ResyncRequired.make({
        threadId: snapshot.thread.id,
        expectedRevision: snapshot.revision + 1,
        receivedBaseRevision: patch.baseRevision,
        currentRevision: snapshot.revision,
      }),
    )
  const currentFailure = validateCurrent(snapshot)
  if (currentFailure !== undefined) return Result.fail(currentFailure)
  const duplicateUpsert = duplicateKey(patch.upsert.map((unit) => unit.key))
  if (duplicateUpsert !== undefined) return Result.fail(duplicateError(snapshot, "upsert", duplicateUpsert))
  const duplicateRemove = duplicateKey(patch.remove)
  if (duplicateRemove !== undefined) return Result.fail(duplicateError(snapshot, "remove", duplicateRemove))
  const remove = new Set(patch.remove)
  const conflict = patch.upsert.find((unit) => remove.has(unit.key))
  if (conflict !== undefined) return Result.fail(invalidError(snapshot, "conflicting-item-change", conflict.key))
  const turnChangeIds = patch.turnChanges.map((change) =>
    String(change._tag === "UpsertTurn" ? change.turn.id : change.turnId),
  )
  const duplicateTurnChange = duplicateKey(turnChangeIds)
  if (duplicateTurnChange !== undefined)
    return Result.fail(duplicateError(snapshot, "turn-changes", duplicateTurnChange))
  const header = patch.header ?? {
    thread: snapshot.thread,
    source: snapshot.source,
    pending: snapshot.pending,
    hasOlder: snapshot.hasOlder,
    hasNewer: snapshot.hasNewer,
    usage: snapshot.usage,
  }
  if (String(header.thread.id) !== String(snapshot.thread.id))
    return Result.fail(invalidError(snapshot, "invalid-header", String(header.thread.id)))
  const duplicatePending = duplicateKey(header.pending.map((pending) => String(pending.id)))
  if (duplicatePending !== undefined) return Result.fail(duplicateError(snapshot, "pending", duplicatePending))
  const entries = snapshot.turns.map((entry) => ({
    turn: entry.turn,
    units: [...entry.units],
    projectionRevision: entry.projectionRevision,
    usage: entry.usage,
    pendingSteering: entry.pendingSteering ?? [],
    settledSteering: entry.settledSteering ?? [],
  }))
  const currentUnits = new Map(entries.flatMap((entry) => entry.units.map((unit) => [unit.key, unit] as const)))
  const currentOwners = new Map(
    entries.flatMap((entry) => entry.units.map((unit) => [unit.key, String(entry.turn.id)] as const)),
  )
  for (const key of patch.remove)
    if (!currentUnits.has(key)) return Result.fail(invalidError(snapshot, "missing-item", key))
  for (const unit of patch.upsert) {
    const current = currentUnits.get(unit.key)
    if (current !== undefined && currentOwners.get(unit.key) !== unit.turnId)
      return Result.fail(invalidError(snapshot, "unit-turn-mismatch", unit.key))
    if (current !== undefined && unit.revision < current.revision)
      return Result.fail(invalidError(snapshot, "unit-revision-regressed", unit.key))
  }
  for (const entry of entries) entry.units = entry.units.filter((unit) => !remove.has(unit.key))
  const turns = new Map(entries.map((entry) => [String(entry.turn.id), entry] as const))
  for (const change of patch.turnChanges) {
    if (change._tag === "RemoveTurn") {
      const key = String(change.turnId)
      if (!turns.has(key)) return Result.fail(invalidError(snapshot, "missing-turn", key))
      turns.delete(key)
      continue
    }
    const key = String(change.turn.id)
    if (String(change.turn.threadId) !== String(snapshot.thread.id))
      return Result.fail(invalidError(snapshot, "turn-thread-mismatch", key))
    const current = turns.get(key)
    if (current !== undefined && change.projectionRevision < current.projectionRevision)
      return Result.fail(invalidError(snapshot, "projection-revision-regressed", key))
    turns.set(key, {
      turn: change.turn,
      units: current?.units ?? [],
      projectionRevision: change.projectionRevision,
      usage: change.usage,
      pendingSteering: change.pendingSteering ?? [],
      settledSteering: change.settledSteering ?? [],
    })
  }
  const unitOwners = new Map<string, string>()
  for (const [turnId, entry] of turns) for (const unit of entry.units) unitOwners.set(unit.key, turnId)
  for (const unit of patch.upsert) {
    const turnId = unit.turnId
    const entry = turns.get(turnId)
    if (entry === undefined) return Result.fail(invalidError(snapshot, "missing-turn", turnId))
    const previousOwner = unitOwners.get(unit.key)
    if (previousOwner !== undefined && previousOwner !== turnId)
      return Result.fail(invalidError(snapshot, "unit-turn-mismatch", unit.key))
    const index = entry.units.findIndex((candidate) => candidate.key === unit.key)
    if (index === -1) entry.units.push(unit)
    else entry.units[index] = unit
    unitOwners.set(unit.key, turnId)
  }
  const nextTurns = [...turns.values()]
    .map((entry) => ({
      turn: entry.turn,
      projectionRevision: entry.projectionRevision,
      usage: entry.usage,
      pendingSteering: entry.pendingSteering ?? [],
      settledSteering: entry.settledSteering ?? [],
      units: entry.units.toSorted((left, right) => {
        const order = TranscriptUnitOrder.compareUnitOrder(left.order, right.order)
        return order === 0 ? left.key.localeCompare(right.key) : order
      }),
    }))
    .toSorted((left, right) => {
      const createdAt = left.turn.createdAt - right.turn.createdAt
      return createdAt === 0 ? String(left.turn.id).localeCompare(String(right.turn.id)) : createdAt
    })
  if (header.pending.length > limits.pending) return Result.fail(invalidError(snapshot, "bounds-exceeded"))
  return Result.succeed({
    ...header,
    revision: patch.revision,
    turns: nextTurns,
  })
}

export const apply: {
  (patch: ThreadViewPatch): (snapshot: ThreadViewSnapshot) => Result.Result<ThreadViewSnapshot, ThreadViewApplyError>
  (snapshot: ThreadViewSnapshot, patch: ThreadViewPatch): Result.Result<ThreadViewSnapshot, ThreadViewApplyError>
} = Function.dual(2, applyImpl)
