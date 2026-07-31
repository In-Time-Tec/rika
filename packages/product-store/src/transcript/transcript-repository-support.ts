import { Effect, Schema } from "effect"
import * as TranscriptProjectionModel from "@rika/transcript/transcript-projection-model"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import * as TranscriptCorrelation from "@rika/transcript/child-parent-correlation"
import * as TranscriptRecordedShell from "@rika/transcript/recorded-shell-presentation"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import { ThreadId } from "@rika/product/thread-record"
import { Turn, TurnId } from "@rika/product/turn-record"
import type { AgentExecutionTurn, RunningRecordedShellTurn, TerminalRecordedShellTurn } from "@rika/product/turn-record"
import { EntrySchema, PageCursor, type Entry } from "@rika/product/transcript-page"
import {
  ExecutionAttachment,
  ExecutionCheckpoint,
  invalidatedProjectionVersion,
  type Projection,
  type CheckpointOptions,
  type DeltaCheckpointOptions,
  type UnitDelta,
  type RefoldOptions,
  type PageOptions,
  type Page,
  type ProjectionRecoveryCandidate,
  type WriteResult,
  type RefoldWriteResult,
  type RecordedShellWriteResult,
} from "@rika/product/transcript-repository"
import { RepositoryError } from "@rika/product/transcript-repository"
class RefoldStale extends Schema.TaggedErrorClass<RefoldStale>()("TranscriptRefoldStale", {}) {}

const CheckpointRow = Schema.Struct({
  model_phase: Schema.Finite,
  checkpoint_generation: Schema.Finite,
  revision: Schema.Finite,
  usable_completion_sequence: Schema.NullOr(Schema.Finite),
  oldest_cursor: Schema.NullOr(Schema.String),
  checkpoint_cursor: Schema.NullOr(Schema.String),
  cost_usd: Schema.NullOr(Schema.Finite),
  usage_cursors_json: Schema.NullOr(Schema.String),
  pricing_version: Schema.NullOr(Schema.String),
  projection_version: Schema.Finite,
})

const ProjectionRecoveryCandidateRow = Schema.Struct({
  thread_id: ThreadId,
  turn_id: TurnId,
})

const ExecutionCheckpointRow = Schema.Struct({
  execution_key: Schema.String,
  execution_id: Schema.String,
  cursor: Schema.String,
  sequence: Schema.Finite,
  status: Schema.NullOr(Schema.String),
  revision: Schema.Finite,
  model_phase: Schema.Finite,
  usable_completion_sequence: Schema.NullOr(Schema.Finite),
  oldest_cursor: Schema.NullOr(Schema.String),
  checkpoint_cursor: Schema.NullOr(Schema.String),
  cost_usd: Schema.NullOr(Schema.Finite),
  usage_cursors_json: Schema.NullOr(Schema.String),
  pricing_version: Schema.NullOr(Schema.String),
  parent_execution_key: Schema.NullOr(Schema.String),
  parent_unit_key: Schema.NullOr(Schema.String),
  parent_id: Schema.NullOr(Schema.String),
  parent_order_key: Schema.NullOr(Schema.String),
})

const StoredUnitRow = Schema.Struct({
  unit_key: Schema.String,
  execution_key: Schema.NullOr(Schema.String),
  turn_id: Schema.String,
  parent_id: Schema.NullOr(Schema.String),
  tool_id: Schema.NullOr(Schema.String),
  unit_json: Schema.String,
  unit_order_key: Schema.String,
})

const UnitRow = Schema.Struct({
  unit_key: Schema.String,
  execution_key: Schema.NullOr(Schema.String),
  unit_json: Schema.String,
  unit_order_key: Schema.String,
  durable_parent_id: Schema.NullOr(Schema.String),
  durable_tool_id: Schema.NullOr(Schema.String),
  checkpoint_execution_id: Schema.NullOr(Schema.String),
  checkpoint_is_root: Schema.NullOr(Schema.Finite),
  attachment_parent_execution_key: Schema.NullOr(Schema.String),
  attachment_parent_unit_key: Schema.NullOr(Schema.String),
  attachment_parent_id: Schema.NullOr(Schema.String),
  attachment_parent_order_key: Schema.NullOr(Schema.String),
  attachment_unit_key: Schema.NullOr(Schema.String),
  attachment_unit_execution_key: Schema.NullOr(Schema.String),
  attachment_unit_order_key: Schema.NullOr(Schema.String),
  attachment_unit_tool_id: Schema.NullOr(Schema.String),
  attachment_unit_json: Schema.NullOr(Schema.String),
  turn_id: Schema.String,
  projection_revision: Schema.Finite,
  model_phase: Schema.Finite,
  cost_usd: Schema.NullOr(Schema.Finite),
  projection_version: Schema.Finite,
})

const UnitJson = Schema.fromJsonString(TranscriptUnit.Unit)
const UsageCursorsJson = Schema.fromJsonString(Schema.Array(Schema.String))
const error = (cause: unknown) =>
  Schema.is(RepositoryError)(cause) ? cause : RepositoryError.make({ message: String(cause) })
const clone = <A>(value: A): A => structuredClone(value)
const refoldStale = RefoldStale.make({})
const sameTurn = Schema.toEquivalence(Turn)
const sameExecutionAttachment = Schema.toEquivalence(ExecutionAttachment)
const isRefoldStale = (value: unknown): value is RefoldStale =>
  typeof value === "object" && value !== null && "_tag" in value && value._tag === "TranscriptRefoldStale"

const refoldTurn = Effect.fn("TranscriptRepository.refoldTurn")(function* (
  expected: AgentExecutionTurn,
  projection: TranscriptProjectionModel.Projection,
  options: RefoldOptions,
) {
  const rootKey = TranscriptCorrelation.executionKey(String(expected.id))
  const roots = options.executionCheckpoints.filter((checkpoint) => checkpoint.executionKey === rootKey)
  if (roots.length !== 1)
    return yield* RepositoryError.make({ message: `Transcript ${expected.id} has no unique root execution checkpoint` })
  const root = roots[0]!
  if (root.attachment !== undefined || root.status === undefined || root.cursor.length === 0)
    return yield* RepositoryError.make({ message: `Transcript ${expected.id} has no durable terminal root outcome` })
  const outcomes = projection.units.filter(
    (unit) => unit.turnId === expected.id && unit.parentId === undefined && unit.executionOutcome !== undefined,
  )
  if (outcomes.length !== 1)
    return yield* RepositoryError.make({ message: `Transcript ${expected.id} has no unique projected root outcome` })
  const projected =
    outcomes[0]!.executionOutcome!.status === "complete" ? "completed" : outcomes[0]!.executionOutcome!.status
  if (projected !== root.status)
    return yield* RepositoryError.make({
      message: `Transcript ${expected.id} has contradictory terminal root outcomes`,
    })
  return { ...expected, status: root.status, lastCursor: root.cursor }
})

const pageSize = (limit: number | undefined) => Math.min(200, Math.max(1, Math.floor(limit ?? 50)))
const cursorFor = (entry: Entry | undefined): PageCursor | undefined =>
  entry === undefined
    ? undefined
    : {
        createdAt: entry.turn.createdAt,
        turnId: entry.turn.id,
        orderKey: TranscriptOrdering.encodeUnitOrder(entry.unit.order),
      }

const storedProjection = (
  turn: Turn,
  projection: TranscriptProjectionModel.Projection,
  options: CheckpointOptions,
  checkpointGeneration: number,
): Projection => ({
  turn: clone(turn),
  units: clone(projection.units),
  checkpointGeneration,
  revision: projection.revision,
  modelPhase: projection.modelPhase,
  usableCompletionSequence: projection.usableCompletionSequence,
  oldestCursor: projection.oldestCursor,
  checkpointCursor: projection.checkpointCursor,
  costUsd: projection.costUsd,
  usageCursors: projection.usageCursors === undefined ? undefined : clone(projection.usageCursors),
  pricingVersion: projection.pricingVersion,
  executionCheckpoints: clone(options.executionCheckpoints),
  projectionVersion: options.projectionVersion,
})

const withUnits = (
  state: TranscriptProjectionModel.ProjectionState,
  units: ReadonlyArray<TranscriptUnit.Unit>,
): TranscriptProjectionModel.Projection => ({
  units,
  revision: state.revision,
  modelPhase: state.modelPhase,
  ...(state.usableCompletionSequence === undefined ? {} : { usableCompletionSequence: state.usableCompletionSequence }),
  ...(state.oldestCursor === undefined ? {} : { oldestCursor: state.oldestCursor }),
  ...(state.checkpointCursor === undefined ? {} : { checkpointCursor: state.checkpointCursor }),
  ...(state.costUsd === undefined ? {} : { costUsd: state.costUsd }),
  ...(state.usageCursors === undefined ? {} : { usageCursors: state.usageCursors }),
  ...(state.pricingVersion === undefined ? {} : { pricingVersion: state.pricingVersion }),
})

const recordedShellProjection = (turn: RunningRecordedShellTurn | TerminalRecordedShellTurn) => {
  const running = TranscriptRecordedShell.recordedShellProjection({
    id: turn.id,
    command: turn.command,
    status: "running",
  })
  return turn.status === "running" ? running : TranscriptRecordedShell.settleRecordedShellProjection(running, turn)
}

const validateRecordedShellProjection = Effect.fn("TranscriptRepository.validateRecordedShellProjection")(function* (
  turn: RunningRecordedShellTurn | TerminalRecordedShellTurn,
  projection: TranscriptProjectionModel.Projection,
  projectionVersion: number,
) {
  yield* validateProjectionVersion(turn.id, projectionVersion)
  if (turn.prompt !== `$ ${turn.command}`)
    return yield* RepositoryError.make({ message: `Recorded shell turn ${turn.id} has a contradictory prompt` })
  const expected = recordedShellProjection(turn)
  if (
    !TranscriptProjection.Projection.sameProjectionState(expected, projection) ||
    expected.units.length !== projection.units.length
  )
    return yield* RepositoryError.make({ message: `Recorded shell turn ${turn.id} has a contradictory projection` })
  const [expectedUnits, actualUnits] = yield* Effect.all([
    Effect.forEach(expected.units, (unit) => Schema.encodeEffect(UnitJson)(unit)),
    Effect.forEach(projection.units, (unit) => Schema.encodeEffect(UnitJson)(unit)),
  ]).pipe(Effect.mapError(error))
  if (expectedUnits.some((unit, index) => unit !== actualUnits[index]))
    return yield* RepositoryError.make({ message: `Recorded shell turn ${turn.id} has contradictory units` })
})

const compareText = (left: string, right: string): number => {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

const compareEntry = (left: Entry, right: Entry): number =>
  left.turn.createdAt - right.turn.createdAt ||
  compareText(left.turn.id, right.turn.id) ||
  TranscriptOrdering.compareUnitOrder(left.unit.order, right.unit.order)

const before = (entry: Entry, cursor: PageCursor): boolean =>
  entry.turn.createdAt < cursor.createdAt ||
  (entry.turn.createdAt === cursor.createdAt &&
    (entry.turn.id < cursor.turnId ||
      (entry.turn.id === cursor.turnId && TranscriptOrdering.encodeUnitOrder(entry.unit.order) < cursor.orderKey)))

const after = (entry: Entry, cursor: PageCursor): boolean =>
  entry.turn.createdAt > cursor.createdAt ||
  (entry.turn.createdAt === cursor.createdAt &&
    (entry.turn.id > cursor.turnId ||
      (entry.turn.id === cursor.turnId && TranscriptOrdering.encodeUnitOrder(entry.unit.order) > cursor.orderKey)))

const compareDescending = (left: Entry, right: Entry): number => compareEntry(right, left)

const unitSetError = (units: ReadonlyArray<TranscriptUnit.Unit>): RepositoryError | undefined => {
  const keys = new Set<string>()
  const orders = new Set<string>()
  for (const unit of units) {
    if (!TranscriptOrdering.hasIntrinsicOrder(unit))
      return RepositoryError.make({ message: `Transcript unit ${unit.key} has a non-intrinsic order` })
    if (keys.has(unit.key)) return RepositoryError.make({ message: `Transcript unit key ${unit.key} is duplicated` })
    keys.add(unit.key)
    const order = TranscriptOrdering.encodeUnitOrder(unit.order)
    if (orders.has(order)) return RepositoryError.make({ message: `Transcript unit order ${order} is duplicated` })
    orders.add(order)
  }
  return undefined
}

const validateUnits = (units: ReadonlyArray<TranscriptUnit.Unit>) => {
  const failure = unitSetError(units)
  return failure === undefined ? Effect.void : Effect.fail(failure)
}

const stateScalarError = (
  turnId: TurnId,
  owner: string,
  state: TranscriptProjectionModel.ProjectionState,
): RepositoryError | undefined => {
  if (!Number.isSafeInteger(state.revision) || state.revision < -1)
    return RepositoryError.make({ message: `Transcript ${turnId} has an invalid revision for ${owner}` })
  if (!Number.isSafeInteger(state.modelPhase) || state.modelPhase < -1)
    return RepositoryError.make({ message: `Transcript ${turnId} has an invalid model phase for ${owner}` })
  if (
    state.usableCompletionSequence !== undefined &&
    (!Number.isSafeInteger(state.usableCompletionSequence) || state.usableCompletionSequence < 0)
  )
    return RepositoryError.make({
      message: `Transcript ${turnId} has an invalid usable completion sequence for ${owner}`,
    })
  if (state.costUsd !== undefined && (!Number.isFinite(state.costUsd) || state.costUsd < 0))
    return RepositoryError.make({ message: `Transcript ${turnId} has an invalid cost for ${owner}` })
  return undefined
}

const validateStateScalars = (turnId: TurnId, owner: string, state: TranscriptProjectionModel.ProjectionState) => {
  const failure = stateScalarError(turnId, owner, state)
  return failure === undefined ? Effect.void : Effect.fail(failure)
}

const validateProjectionVersion = (turnId: TurnId, projectionVersion: number) =>
  Number.isSafeInteger(projectionVersion) && projectionVersion >= 1
    ? Effect.void
    : Effect.fail(RepositoryError.make({ message: `Transcript ${turnId} has an invalid projection version` }))

const validateCurrentProjectionVersion = (projectionVersion: number) =>
  Number.isSafeInteger(projectionVersion) && projectionVersion >= 1
    ? Effect.void
    : Effect.fail(RepositoryError.make({ message: "Transcript recovery has an invalid projection version" }))

const validateCheckpoint = (
  turn: AgentExecutionTurn,
  state: TranscriptProjectionModel.ProjectionState,
  options: CheckpointOptions,
  complete = false,
) => {
  const versionFailure =
    Number.isSafeInteger(options.projectionVersion) && options.projectionVersion >= 1
      ? undefined
      : RepositoryError.make({ message: `Transcript ${turn.id} has an invalid projection version` })
  if (versionFailure !== undefined) return Effect.fail(versionFailure)
  const rootStateFailure = stateScalarError(turn.id, "root projection", state)
  if (rootStateFailure !== undefined) return Effect.fail(rootStateFailure)
  const checkpoints = options.executionCheckpoints
  if (checkpoints.length === 0)
    return Effect.fail(RepositoryError.make({ message: `Transcript ${turn.id} has no execution checkpoint` }))
  const rootKey = TranscriptCorrelation.executionKey(String(turn.id))
  const keys = new Set<string>()
  const parents = new Map<string, string | undefined>()
  let root: ExecutionCheckpoint | undefined
  for (const checkpoint of checkpoints) {
    if (checkpoint.executionKey.length === 0)
      return Effect.fail(RepositoryError.make({ message: `Transcript ${turn.id} has an empty execution key` }))
    if (
      checkpoint.executionId.length === 0 ||
      TranscriptCorrelation.executionKey(checkpoint.executionId) !== checkpoint.executionKey
    )
      return Effect.fail(
        RepositoryError.make({
          message: `Transcript ${turn.id} has an invalid execution id for ${checkpoint.executionKey}`,
        }),
      )
    if (keys.has(checkpoint.executionKey))
      return Effect.fail(
        RepositoryError.make({ message: `Transcript ${turn.id} duplicates execution ${checkpoint.executionKey}` }),
      )
    keys.add(checkpoint.executionKey)
    parents.set(checkpoint.executionKey, checkpoint.attachment?.parentExecutionKey)
    if (!Number.isSafeInteger(checkpoint.sequence) || checkpoint.sequence < -1)
      return Effect.fail(
        RepositoryError.make({
          message: `Transcript ${turn.id} has an invalid sequence for ${checkpoint.executionKey}`,
        }),
      )
    const stateFailure = stateScalarError(turn.id, checkpoint.executionKey, checkpoint.state)
    if (stateFailure !== undefined) return Effect.fail(stateFailure)
    if (checkpoint.state.revision !== checkpoint.sequence)
      return Effect.fail(
        RepositoryError.make({
          message: `Transcript ${turn.id} has inconsistent state for ${checkpoint.executionKey}`,
        }),
      )
    if ((checkpoint.state.checkpointCursor ?? "") !== checkpoint.cursor)
      return Effect.fail(
        RepositoryError.make({
          message: `Transcript ${turn.id} has inconsistent cursor for ${checkpoint.executionKey}`,
        }),
      )
    if (checkpoint.executionKey === rootKey) {
      root = checkpoint
      if (checkpoint.attachment !== undefined)
        return Effect.fail(RepositoryError.make({ message: `Transcript ${turn.id} attaches its root execution` }))
    } else {
      const attachment = checkpoint.attachment
      if (
        attachment === undefined ||
        attachment.parentExecutionKey.length === 0 ||
        attachment.parentUnitKey.length === 0 ||
        attachment.parentId.length === 0 ||
        attachment.parentOrderKey.length === 0 ||
        attachment.parentExecutionKey === checkpoint.executionKey
      )
        return Effect.fail(
          RepositoryError.make({
            message: `Transcript ${turn.id} has an invalid attachment for ${checkpoint.executionKey}`,
          }),
        )
    }
  }
  if (complete)
    if (root === undefined)
      return Effect.fail(RepositoryError.make({ message: `Transcript ${turn.id} has no root execution checkpoint` }))
  if (complete && root !== undefined && !TranscriptProjection.Projection.sameProjectionState(state, root.state))
    return Effect.fail(RepositoryError.make({ message: `Transcript ${turn.id} has contradictory root fold state` }))
  if (complete) {
    const connected = new Set<string>([rootKey])
    for (const checkpoint of checkpoints) {
      const path: Array<string> = []
      const visiting = new Set<string>()
      let key = checkpoint.executionKey
      while (!connected.has(key)) {
        if (visiting.has(key))
          return Effect.fail(
            RepositoryError.make({
              message: `Transcript ${turn.id} has a cyclic execution attachment at ${key}`,
            }),
          )
        visiting.add(key)
        path.push(key)
        const parentKey = parents.get(key)
        if (parentKey === undefined || !keys.has(parentKey))
          return Effect.fail(
            RepositoryError.make({
              message: `Transcript ${turn.id} has no parent execution ${parentKey ?? ""} for ${key}`,
            }),
          )
        key = parentKey
      }
      for (const connectedKey of path) connected.add(connectedKey)
    }
    if (connected.size !== checkpoints.length)
      return Effect.fail(
        RepositoryError.make({ message: `Transcript ${turn.id} has executions disconnected from its root` }),
      )
  }
  return Effect.void
}

const attachmentSetError = (
  turn: AgentExecutionTurn,
  units: ReadonlyArray<TranscriptUnit.Unit>,
  checkpoints: ReadonlyArray<ExecutionCheckpoint>,
): RepositoryError | undefined => {
  if (checkpoints.length === 0 && units.length === 0) return undefined
  const rootKey = TranscriptCorrelation.executionKey(String(turn.id))
  const byExecution = new Map(checkpoints.map((checkpoint) => [checkpoint.executionKey, checkpoint]))
  const byUnit = new Map(units.map((unit) => [unit.key, unit]))
  for (const checkpoint of checkpoints) {
    const attachment = checkpoint.attachment
    if (attachment === undefined) continue
    const parent = byUnit.get(attachment.parentUnitKey)
    if (
      parent === undefined ||
      TranscriptCorrelation.executionKey(parent.turnId) !== attachment.parentExecutionKey ||
      parent.content._tag !== "Block" ||
      parent.content.block._tag !== "ToolCall" ||
      parent.content.block.id !== attachment.parentId ||
      TranscriptOrdering.encodeUnitOrder(parent.order) !== attachment.parentOrderKey
    )
      return RepositoryError.make({
        message: `Transcript ${turn.id} has a contradictory attachment for ${checkpoint.executionKey}`,
      })
  }
  for (const unit of units) {
    const executionKey = TranscriptCorrelation.executionKey(unit.turnId)
    const checkpoint = byExecution.get(executionKey)
    if (executionKey === rootKey) {
      if (unit.parentId !== undefined)
        return RepositoryError.make({ message: `Transcript ${turn.id} attaches a root unit` })
      continue
    }
    const attachment = checkpoint?.attachment
    const parent = attachment === undefined ? undefined : byUnit.get(attachment.parentUnitKey)
    if (
      checkpoint === undefined ||
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
      return RepositoryError.make({
        message: `Transcript ${turn.id} has a contradictory unit path for ${executionKey}`,
      })
  }
  return undefined
}

const validateAttachmentSet = (
  turn: AgentExecutionTurn,
  units: ReadonlyArray<TranscriptUnit.Unit>,
  checkpoints: ReadonlyArray<ExecutionCheckpoint>,
) => {
  const failure = attachmentSetError(turn, units, checkpoints)
  return failure === undefined ? Effect.void : Effect.fail(failure)
}

const validatePageOptions = (options: PageOptions) =>
  options.before !== undefined && options.after !== undefined
    ? Effect.fail(RepositoryError.make({ message: "Transcript pages cannot specify both before and after cursors" }))
    : Effect.void

const validateMemoryUnits = (units: ReadonlyArray<TranscriptUnit.Unit>) =>
  Effect.forEach(units, (unit) => Schema.encodeEffect(UnitJson)(unit).pipe(Effect.mapError(error)), { discard: true })

const validateMemoryCheckpoint = (options: CheckpointOptions) =>
  Effect.forEach(
    options.executionCheckpoints,
    (checkpoint) => Schema.encodeEffect(ExecutionCheckpoint)(checkpoint).pipe(Effect.mapError(error)),
    { discard: true },
  )

const validateDelta = (delta: UnitDelta) =>
  Effect.gen(function* () {
    yield* validateUnits(delta.upsert)
    const removed = new Set<string>()
    for (const key of delta.remove) {
      if (key.length === 0) return yield* RepositoryError.make({ message: "Transcript unit key is empty" })
      if (removed.has(key))
        return yield* RepositoryError.make({ message: `Transcript unit removal ${key} is duplicated` })
      removed.add(key)
    }
    for (const unit of delta.upsert)
      if (removed.has(unit.key))
        return yield* RepositoryError.make({
          message: `Transcript unit ${unit.key} cannot be removed and upserted together`,
        })
  })

export const support = {
  CheckpointRow,
  ProjectionRecoveryCandidateRow,
  ExecutionCheckpointRow,
  StoredUnitRow,
  UnitRow,
  UnitJson,
  UsageCursorsJson,
  error,
  clone,
  refoldStale,
  sameTurn,
  sameExecutionAttachment,
  isRefoldStale,
  refoldTurn,
  pageSize,
  cursorFor,
  storedProjection,
  withUnits,
  recordedShellProjection,
  validateRecordedShellProjection,
  compareText,
  compareEntry,
  before,
  after,
  compareDescending,
  unitSetError,
  validateUnits,
  stateScalarError,
  validateStateScalars,
  validateProjectionVersion,
  validateCurrentProjectionVersion,
  validateCheckpoint,
  attachmentSetError,
  validateAttachmentSet,
  validatePageOptions,
  validateMemoryUnits,
  validateMemoryCheckpoint,
  validateDelta,
  RefoldStale,
}
