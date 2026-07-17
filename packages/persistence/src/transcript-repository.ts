import * as Transcript from "@rika/transcript"
import { Context, Effect, Layer, Ref, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { ThreadId } from "./thread-schema"
import { ExecutionExtensionPin, ExecutionRoutePin, PromptPart, Status, Turn, TurnId } from "./turn-schema"
import { EntrySchema, PageCursor, type Entry } from "./transcript-page"

export { EntrySchema, PageCursor }
export type { Entry }

export interface Projection {
  readonly turn: Turn
  readonly units: ReadonlyArray<Transcript.Unit>
  readonly revision: number
  readonly modelPhase: number
  readonly oldestCursor: string | undefined
  readonly checkpointCursor: string | undefined
  readonly costUsd: number | undefined
}

export interface PageOptions {
  readonly before?: PageCursor | undefined
  readonly limit?: number
}

export interface Page {
  readonly entries: ReadonlyArray<Entry>
  readonly hasOlder: boolean
  readonly oldestCursor: PageCursor | undefined
  readonly threadCostUsd: number
}

export class RepositoryError extends Schema.TaggedErrorClass<RepositoryError>()("TranscriptRepositoryError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly get: (turnId: TurnId) => Effect.Effect<Projection | undefined, RepositoryError>
  readonly replace: (turn: Turn, projection: Transcript.Projection) => Effect.Effect<Projection, RepositoryError>
  readonly append: (turn: Turn, event: Transcript.SourceEvent) => Effect.Effect<Projection, RepositoryError>
  readonly appendAll: (
    turn: Turn,
    events: ReadonlyArray<Transcript.SourceEvent>,
  ) => Effect.Effect<Projection, RepositoryError>
  readonly page: (threadId: ThreadId, options?: PageOptions) => Effect.Effect<Page, RepositoryError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/persistence/transcript-repository/Service") {}

const CheckpointRow = Schema.Struct({
  turn_id: Schema.String,
  thread_id: Schema.String,
  prompt: Schema.String,
  prompt_parts_json: Schema.NullOr(Schema.String),
  execution_route_json: Schema.String,
  last_cursor: Schema.NullOr(Schema.String),
  extension_pin_json: Schema.NullOr(Schema.String),
  review_fan_out_id: Schema.NullOr(Schema.String),
  status: Schema.String,
  model_phase: Schema.Finite,
  revision: Schema.Finite,
  oldest_cursor: Schema.NullOr(Schema.String),
  checkpoint_cursor: Schema.NullOr(Schema.String),
  cost_usd: Schema.NullOr(Schema.Finite),
  created_at: Schema.Finite,
  updated_at: Schema.Finite,
})

const UnitRow = Schema.Struct({
  unit_json: Schema.String,
  projection_revision: Schema.Finite,
  model_phase: Schema.Finite,
  cost_usd: Schema.NullOr(Schema.Finite),
  prompt: Schema.String,
  prompt_parts_json: Schema.NullOr(Schema.String),
  execution_route_json: Schema.String,
  last_cursor: Schema.NullOr(Schema.String),
  extension_pin_json: Schema.NullOr(Schema.String),
  review_fan_out_id: Schema.NullOr(Schema.String),
  status: Schema.String,
  created_at: Schema.Finite,
  updated_at: Schema.Finite,
})

const UnitJson = Schema.fromJsonString(Transcript.Unit)
const PromptPartsJson = Schema.fromJsonString(Schema.Array(PromptPart))
const ExecutionRouteJson = Schema.fromJsonString(ExecutionRoutePin)
const ExtensionPinJson = Schema.fromJsonString(ExecutionExtensionPin)
const error = (cause: unknown) => RepositoryError.make({ message: String(cause) })
const clone = <A>(value: A): A => structuredClone(value)
const pageSize = (limit: number | undefined) => Math.min(200, Math.max(1, Math.floor(limit ?? 50)))
const cursorFor = (entry: Entry | undefined): PageCursor | undefined =>
  entry === undefined
    ? undefined
    : {
        createdAt: entry.turn.createdAt,
        turnId: entry.turn.id,
        sequence: entry.unit.order.sequence,
        part: entry.unit.order.part,
        key: entry.unit.key,
      }

const stored = (turn: Turn, projection: Transcript.Projection): Projection => ({
  turn: clone(turn),
  units: clone(projection.units),
  revision: projection.revision,
  modelPhase: projection.modelPhase,
  oldestCursor: projection.oldestCursor,
  checkpointCursor: projection.checkpointCursor,
  costUsd: projection.costUsd,
})

const source = (projection: Projection): Transcript.Projection => ({
  units: projection.units,
  revision: projection.revision,
  modelPhase: projection.modelPhase,
  ...(projection.oldestCursor === undefined ? {} : { oldestCursor: projection.oldestCursor }),
  ...(projection.checkpointCursor === undefined ? {} : { checkpointCursor: projection.checkpointCursor }),
  ...(projection.costUsd === undefined ? {} : { costUsd: projection.costUsd }),
})

const continueProjection = (
  turn: Turn,
  current: Projection | undefined,
  events: ReadonlyArray<Transcript.SourceEvent>,
): Transcript.Projection => {
  let projection = current === undefined ? Transcript.empty(turn.id, turn.prompt) : source(current)
  for (const event of events.toSorted((left, right) => left.sequence - right.sequence))
    projection = Transcript.applyEvent(projection, event)
  return projection
}

const before = (entry: Entry, cursor: PageCursor): boolean =>
  entry.turn.createdAt < cursor.createdAt ||
  (entry.turn.createdAt === cursor.createdAt &&
    (entry.turn.id < cursor.turnId ||
      (entry.turn.id === cursor.turnId &&
        (entry.unit.order.sequence < cursor.sequence ||
          (entry.unit.order.sequence === cursor.sequence &&
            (entry.unit.order.part < cursor.part ||
              (entry.unit.order.part === cursor.part && entry.unit.key < cursor.key)))))))

const compareDescending = (left: Entry, right: Entry): number =>
  right.turn.createdAt - left.turn.createdAt ||
  right.turn.id.localeCompare(left.turn.id) ||
  right.unit.order.sequence - left.unit.order.sequence ||
  right.unit.order.part - left.unit.order.part ||
  right.unit.key.localeCompare(left.unit.key)

const makeMemory = Effect.gen(function* () {
  const state = yield* Ref.make(new Map<TurnId, Projection>())
  const get = Effect.fn("TranscriptRepository.get")(function* (turnId: TurnId) {
    const found = (yield* Ref.get(state)).get(turnId)
    return found === undefined ? undefined : clone(found)
  })
  const appendAll = Effect.fn("TranscriptRepository.appendAll")(function* (
    turn: Turn,
    events: ReadonlyArray<Transcript.SourceEvent>,
  ) {
    return yield* Ref.modify(state, (entries) => {
      const next = stored(turn, continueProjection(turn, entries.get(turn.id), events))
      return [clone(next), new Map(entries).set(turn.id, next)]
    })
  })
  return Service.of({
    get,
    replace: Effect.fn("TranscriptRepository.replace")(function* (turn, projection) {
      const current = yield* get(turn.id)
      if (current !== undefined && current.revision > projection.revision) return current
      const next = stored(turn, projection)
      yield* Ref.update(state, (entries) => new Map(entries).set(turn.id, next))
      return clone(next)
    }),
    append: Effect.fn("TranscriptRepository.append")((turn, event) => appendAll(turn, [event])),
    appendAll,
    page: Effect.fn("TranscriptRepository.page")(function* (threadId, options = {}) {
      const limit = pageSize(options.limit)
      const descending = [...(yield* Ref.get(state)).values()]
        .filter((projection) => projection.turn.threadId === threadId)
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
        .toSorted(compareDescending)
      const entries = descending.slice(0, limit).toReversed().map(clone)
      const threadCostUsd = [...(yield* Ref.get(state)).values()]
        .filter((projection) => projection.turn.threadId === threadId)
        .reduce((total, projection) => total + (projection.costUsd ?? 0), 0)
      return { entries, hasOlder: descending.length > limit, oldestCursor: cursorFor(entries[0]), threadCostUsd }
    }),
  })
})

export const memoryLayer = Layer.effect(Service, makeMemory)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const decodeTurn = Effect.fn("TranscriptRepository.decodeTurn")(function* (row: typeof CheckpointRow.Type) {
      const status = yield* Schema.decodeUnknownEffect(Status)(row.status)
      const promptParts =
        row.prompt_parts_json === null
          ? undefined
          : yield* Schema.decodeUnknownEffect(PromptPartsJson)(row.prompt_parts_json)
      const executionRoute = yield* Schema.decodeUnknownEffect(ExecutionRouteJson)(row.execution_route_json)
      const extensionPin =
        row.extension_pin_json === null
          ? undefined
          : yield* Schema.decodeUnknownEffect(ExtensionPinJson)(row.extension_pin_json)
      return {
        id: TurnId.make(row.turn_id),
        threadId: ThreadId.make(row.thread_id),
        prompt: row.prompt,
        ...(promptParts === undefined ? {} : { promptParts }),
        status,
        ...(row.last_cursor === null ? {} : { lastCursor: row.last_cursor }),
        ...(extensionPin === undefined ? {} : { extensionPin }),
        executionRoute,
        ...(row.review_fan_out_id === null ? {} : { reviewFanOutId: row.review_fan_out_id }),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      } satisfies Turn
    })
    const get = Effect.fn("TranscriptRepository.get")(function* (turnId: TurnId) {
      const checkpointRows = yield* sql`
        SELECT c.*, t.prompt, t.prompt_parts_json, t.execution_route_json, t.last_cursor,
          t.extension_pin_json, t.review_fan_out_id, t.status, t.created_at
        FROM rika_transcript_checkpoints c
        JOIN rika_turns t ON t.id = c.turn_id
        WHERE c.turn_id = ${turnId}
      `.pipe(Effect.mapError(error))
      if (checkpointRows[0] === undefined) return undefined
      const row = yield* Schema.decodeUnknownEffect(CheckpointRow)(checkpointRows[0]).pipe(Effect.mapError(error))
      const unitRows = yield* sql`
        SELECT unit_json FROM rika_transcript_units
        WHERE turn_id = ${turnId}
        ORDER BY unit_sequence ASC, unit_part ASC, unit_key ASC
      `.pipe(Effect.mapError(error))
      const units = yield* Effect.all(
        unitRows.map((value) =>
          Schema.decodeUnknownEffect(Schema.Struct({ unit_json: Schema.String }))(value).pipe(
            Effect.flatMap((unitRow) => Schema.decodeUnknownEffect(UnitJson)(unitRow.unit_json)),
            Effect.mapError(error),
          ),
        ),
      )
      return {
        turn: yield* decodeTurn(row).pipe(Effect.mapError(error)),
        units,
        revision: row.revision,
        modelPhase: row.model_phase,
        oldestCursor: row.oldest_cursor ?? undefined,
        checkpointCursor: row.checkpoint_cursor ?? undefined,
        costUsd: row.cost_usd ?? undefined,
      } satisfies Projection
    })
    const storeUnit = Effect.fn("TranscriptRepository.storeUnit")(function* (turn: Turn, unit: Transcript.Unit) {
      const encoded = yield* Schema.encodeEffect(UnitJson)(unit)
      yield* sql`INSERT INTO rika_transcript_units (unit_key, turn_id, thread_id, unit_sequence, unit_part, revision, unit_json, created_at, updated_at)
          VALUES (${unit.key}, ${turn.id}, ${turn.threadId}, ${unit.order.sequence}, ${unit.order.part}, ${unit.revision}, ${encoded}, ${turn.createdAt}, ${turn.updatedAt})
          ON CONFLICT(unit_key) DO UPDATE SET thread_id = excluded.thread_id, unit_sequence = excluded.unit_sequence,
            unit_part = excluded.unit_part, revision = excluded.revision, unit_json = excluded.unit_json,
            created_at = excluded.created_at, updated_at = excluded.updated_at`
    }, Effect.mapError(error))
    const storeCheckpoint = Effect.fn("TranscriptRepository.storeCheckpoint")(function* (
      turn: Turn,
      projection: Transcript.Projection,
    ) {
      yield* sql`INSERT INTO rika_transcript_checkpoints (turn_id, thread_id, model_phase, revision, oldest_cursor, checkpoint_cursor, cost_usd, updated_at)
          VALUES (${turn.id}, ${turn.threadId}, ${projection.modelPhase}, ${projection.revision}, ${projection.oldestCursor ?? null}, ${projection.checkpointCursor ?? null}, ${projection.costUsd ?? null}, ${turn.updatedAt})
          ON CONFLICT(turn_id) DO UPDATE SET thread_id = excluded.thread_id, model_phase = excluded.model_phase,
            revision = excluded.revision, oldest_cursor = excluded.oldest_cursor, checkpoint_cursor = excluded.checkpoint_cursor,
            cost_usd = excluded.cost_usd, updated_at = excluded.updated_at`
    }, Effect.mapError(error))
    const storedResult = Effect.fn("TranscriptRepository.storedResult")(function* (turnId: TurnId) {
      const result = yield* get(turnId)
      if (result === undefined) return yield* RepositoryError.make({ message: `Transcript ${turnId} was not stored` })
      return result
    })
    const write = Effect.fn("TranscriptRepository.write")(function* (turn: Turn, projection: Transcript.Projection) {
      const current = yield* get(turn.id)
      if (current !== undefined && current.revision > projection.revision) return current
      yield* sql`DELETE FROM rika_transcript_units WHERE turn_id = ${turn.id}`.pipe(Effect.mapError(error))
      yield* Effect.forEach(projection.units, (unit) => storeUnit(turn, unit), { discard: true })
      yield* storeCheckpoint(turn, projection)
      return yield* storedResult(turn.id)
    })
    const appendAll = Effect.fn("TranscriptRepository.appendAll")(function* (
      turn: Turn,
      events: ReadonlyArray<Transcript.SourceEvent>,
    ) {
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const current = yield* get(turn.id)
            if (current === undefined)
              yield* sql`DELETE FROM rika_transcript_units WHERE turn_id = ${turn.id}`.pipe(Effect.mapError(error))
            const projection = continueProjection(turn, current, events)
            const revisions = new Map(current?.units.map((unit) => [unit.key, unit.revision]))
            yield* Effect.forEach(
              projection.units.filter((unit) => revisions.get(unit.key) !== unit.revision),
              (unit) => storeUnit(turn, unit),
              { discard: true },
            )
            yield* storeCheckpoint(turn, projection)
            return yield* storedResult(turn.id)
          }),
        )
        .pipe(Effect.mapError(error))
    })
    return Service.of({
      get,
      replace: Effect.fn("TranscriptRepository.replace")((turn, projection) =>
        sql.withTransaction(write(turn, projection)).pipe(Effect.mapError(error)),
      ),
      append: Effect.fn("TranscriptRepository.append")((turn, event) => appendAll(turn, [event])),
      appendAll,
      page: Effect.fn("TranscriptRepository.page")(function* (threadId, options = {}) {
        const limit = pageSize(options.limit)
        const rows =
          options.before === undefined
            ? yield* sql`SELECT u.unit_json, c.revision AS projection_revision, c.model_phase, c.cost_usd,
                  t.prompt, t.prompt_parts_json, t.execution_route_json, t.last_cursor,
                  t.extension_pin_json, t.review_fan_out_id, t.status, t.created_at, t.updated_at
                FROM rika_transcript_units u
                JOIN rika_transcript_checkpoints c ON c.turn_id = u.turn_id
                JOIN rika_turns t ON t.id = u.turn_id
                WHERE u.thread_id = ${threadId} AND t.status <> 'queued'
                ORDER BY u.created_at DESC, u.turn_id DESC, u.unit_sequence DESC, u.unit_part DESC, u.unit_key DESC
                LIMIT ${limit + 1}`.pipe(Effect.mapError(error))
            : yield* sql`SELECT u.unit_json, c.revision AS projection_revision, c.model_phase, c.cost_usd,
                  t.prompt, t.prompt_parts_json, t.execution_route_json, t.last_cursor,
                  t.extension_pin_json, t.review_fan_out_id, t.status, t.created_at, t.updated_at
                FROM rika_transcript_units u
                JOIN rika_transcript_checkpoints c ON c.turn_id = u.turn_id
                JOIN rika_turns t ON t.id = u.turn_id
                WHERE u.thread_id = ${threadId} AND t.status <> 'queued' AND
                  (u.created_at, u.turn_id, u.unit_sequence, u.unit_part, u.unit_key) <
                  (${options.before.createdAt}, ${options.before.turnId}, ${options.before.sequence}, ${options.before.part}, ${options.before.key})
                ORDER BY u.created_at DESC, u.turn_id DESC, u.unit_sequence DESC, u.unit_part DESC, u.unit_key DESC
                LIMIT ${limit + 1}`.pipe(Effect.mapError(error))
        const entries = yield* Effect.all(
          rows.slice(0, limit).map((value) =>
            Schema.decodeUnknownEffect(UnitRow)(value).pipe(
              Effect.flatMap((row) =>
                Effect.gen(function* () {
                  const unit = yield* Schema.decodeUnknownEffect(UnitJson)(row.unit_json)
                  const status = yield* Schema.decodeUnknownEffect(Status)(row.status)
                  const promptParts =
                    row.prompt_parts_json === null
                      ? undefined
                      : yield* Schema.decodeUnknownEffect(PromptPartsJson)(row.prompt_parts_json)
                  const executionRoute = yield* Schema.decodeUnknownEffect(ExecutionRouteJson)(row.execution_route_json)
                  const extensionPin =
                    row.extension_pin_json === null
                      ? undefined
                      : yield* Schema.decodeUnknownEffect(ExtensionPinJson)(row.extension_pin_json)
                  return {
                    turn: {
                      id: TurnId.make(unit.turnId),
                      threadId,
                      prompt: row.prompt,
                      ...(promptParts === undefined ? {} : { promptParts }),
                      status,
                      ...(row.last_cursor === null ? {} : { lastCursor: row.last_cursor }),
                      ...(extensionPin === undefined ? {} : { extensionPin }),
                      executionRoute,
                      ...(row.review_fan_out_id === null ? {} : { reviewFanOutId: row.review_fan_out_id }),
                      createdAt: row.created_at,
                      updatedAt: row.updated_at,
                    },
                    unit,
                    projectionRevision: row.projection_revision,
                    projectionModelPhase: row.model_phase,
                    ...(row.cost_usd === null ? {} : { projectionCostUsd: row.cost_usd }),
                  } satisfies Entry
                }),
              ),
              Effect.mapError(error),
            ),
          ),
        )
        const chronological = entries.toReversed()
        const totals = yield* sql`SELECT COALESCE(SUM(cost_usd), 0) AS thread_cost_usd
          FROM rika_transcript_checkpoints
          WHERE thread_id = ${threadId}`.pipe(Effect.mapError(error))
        const total = yield* Schema.decodeUnknownEffect(Schema.Struct({ thread_cost_usd: Schema.Finite }))(
          totals[0],
        ).pipe(Effect.mapError(error))
        return {
          entries: chronological,
          hasOlder: rows.length > limit,
          oldestCursor: cursorFor(chronological[0]),
          threadCostUsd: total.thread_cost_usd,
        }
      }),
    })
  }),
)
