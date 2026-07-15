import { Context, Effect, Layer, Ref, Schema } from "effect"
import { dual } from "effect/Function"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { ThreadId } from "./thread-schema"
import {
  ExecutionExtensionPin,
  ExecutionRoutePin,
  PromptPart,
  Status,
  Turn,
  TurnId,
  testExecutionRoute,
} from "./turn-schema"

export class RepositoryError extends Schema.TaggedErrorClass<RepositoryError>()("TurnRepositoryError", {
  message: Schema.String,
}) {}

export interface CreateInput {
  readonly id: TurnId
  readonly threadId: ThreadId
  readonly prompt: string
  readonly promptParts?: ReadonlyArray<PromptPart>
  readonly executionRoute?: ExecutionRoutePin
  readonly reviewFanOutId?: string
  readonly now: number
}

export interface Interface {
  readonly createForSubmission: (input: CreateInput) => Effect.Effect<Turn, RepositoryError>
  readonly get: (id: TurnId) => Effect.Effect<Turn | undefined, RepositoryError>
  readonly list: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<Turn>, RepositoryError>
  readonly findActive: (threadId: ThreadId) => Effect.Effect<Turn | undefined, RepositoryError>
  readonly listQueued: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<Turn>, RepositoryError>
  readonly listNonterminal: Effect.Effect<ReadonlyArray<Turn>, RepositoryError>
  readonly claimNextQueued: (threadId: ThreadId, now: number) => Effect.Effect<Turn | undefined, RepositoryError>
  readonly editQueued: (id: TurnId, prompt: string, now: number) => Effect.Effect<Turn, RepositoryError>
  readonly dequeue: (id: TurnId) => Effect.Effect<void, RepositoryError>
  readonly setExtensionPin: (id: TurnId, pin: ExecutionExtensionPin) => Effect.Effect<Turn, RepositoryError>
  readonly setExecutionRoute: (id: TurnId, pin: ExecutionRoutePin) => Effect.Effect<Turn, RepositoryError>
  readonly setStatus: (
    id: TurnId,
    status: Status,
    lastCursor: string | undefined,
    now: number,
  ) => Effect.Effect<Turn, RepositoryError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/persistence/turn-repository/Service") {}

const isTerminalStatus = (status: Status) => status === "completed" || status === "failed" || status === "cancelled"

const Row = Schema.Struct({
  id: Schema.String,
  thread_id: Schema.String,
  prompt: Schema.String,
  status: Schema.String,
  last_cursor: Schema.NullOr(Schema.String),
  extension_pin_json: Schema.optionalKey(Schema.NullOr(Schema.String)),
  execution_route_json: Schema.optionalKey(Schema.NullOr(Schema.String)),
  review_fan_out_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  prompt_parts_json: Schema.optionalKey(Schema.NullOr(Schema.String)),
  created_at: Schema.Finite,
  updated_at: Schema.Finite,
})

const ExtensionPinJson = Schema.fromJsonString(ExecutionExtensionPin)
const PromptPartsJson = Schema.fromJsonString(Schema.Array(PromptPart))
const ExecutionRouteJson = Schema.fromJsonString(ExecutionRoutePin)
const repositoryError = (error: unknown) => RepositoryError.make({ message: String(error) })
const missing = (id: TurnId) => RepositoryError.make({ message: `Turn ${id} does not exist` })
const clone = (turn: Turn): Turn => structuredClone(turn)
type SubmissionResult = { readonly _tag: "Duplicate" } | { readonly _tag: "Created"; readonly turn: Turn }
const decode = (row: unknown) =>
  Effect.gen(function* () {
    const value = yield* Schema.decodeUnknownEffect(Row)(row)
    const status = yield* Schema.decodeUnknownEffect(Status)(value.status)
    const extensionPin =
      value.extension_pin_json == null
        ? undefined
        : yield* Schema.decodeUnknownEffect(ExtensionPinJson)(value.extension_pin_json)
    const promptParts =
      value.prompt_parts_json == null
        ? undefined
        : yield* Schema.decodeUnknownEffect(PromptPartsJson)(value.prompt_parts_json)
    const executionRoute =
      value.execution_route_json == null
        ? undefined
        : yield* Schema.decodeUnknownEffect(ExecutionRouteJson)(value.execution_route_json)
    return {
      id: TurnId.make(value.id),
      threadId: ThreadId.make(value.thread_id),
      prompt: value.prompt,
      ...(promptParts === undefined ? {} : { promptParts }),
      status,
      ...(value.last_cursor === null ? {} : { lastCursor: value.last_cursor }),
      ...(extensionPin === undefined ? {} : { extensionPin }),
      ...(executionRoute === undefined ? {} : { executionRoute }),
      ...(value.review_fan_out_id == null ? {} : { reviewFanOutId: value.review_fan_out_id }),
      createdAt: value.created_at,
      updatedAt: value.updated_at,
    }
  }).pipe(Effect.mapError(repositoryError))

const makeMemoryImpl = (initial: ReadonlyArray<Turn> = [], preserveUnpinned = false) =>
  Effect.gen(function* () {
    const state = yield* Ref.make(
      new Map(
        initial.map((turn) => [
          turn.id,
          clone(
            turn.executionRoute === undefined && !preserveUnpinned
              ? { ...turn, executionRoute: testExecutionRoute() }
              : turn,
          ),
        ]),
      ),
    )
    const get = Effect.fn("TurnRepository.get")(function* (id: TurnId) {
      const turn = (yield* Ref.get(state)).get(id)
      return turn === undefined ? undefined : clone(turn)
    })
    return Service.of({
      createForSubmission: Effect.fn("TurnRepository.createForSubmission")(function* (input) {
        const result = yield* Ref.modify(state, (turns): readonly [SubmissionResult, Map<TurnId, Turn>] => {
          if (turns.has(input.id)) return [{ _tag: "Duplicate" as const }, turns]
          const active = [...turns.values()].some(
            (turn) =>
              turn.threadId === input.threadId && ["queued", "accepted", "running", "waiting"].includes(turn.status),
          )
          const turn: Turn = {
            ...input,
            executionRoute: input.executionRoute ?? testExecutionRoute(),
            status: active ? "queued" : "accepted",
            createdAt: input.now,
            updatedAt: input.now,
          }
          return [{ _tag: "Created" as const, turn: clone(turn) }, new Map(turns).set(turn.id, turn)]
        })
        if (result._tag === "Duplicate") return yield* RepositoryError.make({ message: `Turn ${input.id} exists` })
        return result.turn
      }),
      get,
      list: Effect.fn("TurnRepository.list")(function* (threadId) {
        return [...(yield* Ref.get(state)).values()]
          .filter((turn) => turn.threadId === threadId)
          .toSorted((left, right) => left.createdAt - right.createdAt)
          .map(clone)
      }),
      findActive: Effect.fn("TurnRepository.findActive")(function* (threadId) {
        return [...(yield* Ref.get(state)).values()]
          .filter((turn) => turn.threadId === threadId && ["accepted", "running", "waiting"].includes(turn.status))
          .toSorted((left, right) => left.createdAt - right.createdAt)[0]
      }),
      listQueued: Effect.fn("TurnRepository.listQueued")(function* (threadId) {
        return [...(yield* Ref.get(state)).values()]
          .filter((turn) => turn.threadId === threadId && turn.status === "queued")
          .toSorted((left, right) => left.createdAt - right.createdAt)
          .map(clone)
      }),
      listNonterminal: Effect.gen(function* () {
        return [...(yield* Ref.get(state)).values()]
          .filter((turn) => ["queued", "accepted", "running", "waiting"].includes(turn.status))
          .toSorted((left, right) => left.createdAt - right.createdAt)
          .map(clone)
      }).pipe(Effect.withSpan("TurnRepository.listNonterminal")),
      claimNextQueued: Effect.fn("TurnRepository.claimNextQueued")(function* (threadId, now) {
        return yield* Ref.modify(state, (turns) => {
          const hasActive = [...turns.values()].some(
            (turn) => turn.threadId === threadId && ["accepted", "running", "waiting"].includes(turn.status),
          )
          const queued = [...turns.values()]
            .filter((turn) => turn.threadId === threadId && turn.status === "queued")
            .toSorted((left, right) => left.createdAt - right.createdAt)[0]
          if (hasActive || queued === undefined) return [undefined, turns]
          const claimed: Turn = { ...queued, status: "accepted", updatedAt: now }
          return [clone(claimed), new Map(turns).set(claimed.id, claimed)]
        })
      }),
      editQueued: Effect.fn("TurnRepository.editQueued")(function* (id, prompt, now) {
        const current = yield* get(id)
        if (current === undefined || current.status !== "queued")
          return yield* RepositoryError.make({ message: `Turn ${id} is not queued` })
        const next = { ...current, prompt, updatedAt: now }
        yield* Ref.update(state, (turns) => new Map(turns).set(id, next))
        return clone(next)
      }),
      dequeue: Effect.fn("TurnRepository.dequeue")(function* (id) {
        const current = yield* get(id)
        if (current === undefined || current.status !== "queued")
          return yield* RepositoryError.make({ message: `Turn ${id} is not queued` })
        yield* Ref.update(state, (turns) => {
          const next = new Map(turns)
          next.delete(id)
          return next
        })
      }),
      setExtensionPin: Effect.fn("TurnRepository.setExtensionPin")(function* (id, pin) {
        const current = yield* get(id)
        if (current === undefined) return yield* missing(id)
        const encoded = yield* Schema.encodeEffect(ExtensionPinJson)(pin).pipe(Effect.mapError(repositoryError))
        if (
          current.extensionPin !== undefined &&
          (yield* Schema.encodeEffect(ExtensionPinJson)(current.extensionPin).pipe(
            Effect.mapError(repositoryError),
          )) !== encoded
        )
          return yield* RepositoryError.make({ message: `Turn ${id} extension pin is immutable` })
        const next = { ...current, extensionPin: structuredClone(pin) }
        yield* Ref.update(state, (turns) => new Map(turns).set(id, next))
        return clone(next)
      }),
      setExecutionRoute: Effect.fn("TurnRepository.setExecutionRoute")(function* (id, pin) {
        const current = yield* get(id)
        if (current === undefined) return yield* missing(id)
        const encoded = yield* Schema.encodeEffect(ExecutionRouteJson)(pin).pipe(Effect.mapError(repositoryError))
        if (
          current.executionRoute !== undefined &&
          (yield* Schema.encodeEffect(ExecutionRouteJson)(current.executionRoute).pipe(
            Effect.mapError(repositoryError),
          )) !== encoded
        )
          return yield* RepositoryError.make({ message: `Turn ${id} execution route is immutable` })
        const next = { ...current, executionRoute: structuredClone(pin) }
        yield* Ref.update(state, (turns) => new Map(turns).set(id, next))
        return clone(next)
      }),
      setStatus: Effect.fn("TurnRepository.setStatus")(function* (id, status, lastCursor, now) {
        const updated = yield* Ref.modify(state, (turns) => {
          const current = turns.get(id)
          if (current === undefined) return [undefined, turns]
          if (isTerminalStatus(current.status) && !isTerminalStatus(status)) return [clone(current), turns]
          const { lastCursor: previousCursor, ...withoutCursor } = current
          void previousCursor
          const next: Turn = {
            ...withoutCursor,
            status,
            ...(lastCursor === undefined ? {} : { lastCursor }),
            updatedAt: now,
          }
          return [clone(next), new Map(turns).set(id, next)]
        })
        if (updated === undefined) return yield* missing(id)
        return updated
      }),
    })
  })

export const makeMemory: {
  (initial?: ReadonlyArray<Turn>, preserveUnpinned?: boolean): Effect.Effect<Interface>
  (preserveUnpinned?: boolean): (initial?: ReadonlyArray<Turn>) => Effect.Effect<Interface>
} = dual((args) => args.length !== 1 || Array.isArray(args[0]), makeMemoryImpl)

const memoryLayerImpl = (initial: ReadonlyArray<Turn> = [], preserveUnpinned = false) =>
  Layer.effect(Service, makeMemoryImpl(initial, preserveUnpinned))

export const memoryLayer: {
  (initial?: ReadonlyArray<Turn>, preserveUnpinned?: boolean): Layer.Layer<Service>
  (preserveUnpinned?: boolean): (initial?: ReadonlyArray<Turn>) => Layer.Layer<Service>
} = dual((args) => args.length !== 1 || Array.isArray(args[0]), memoryLayerImpl)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const get = Effect.fn("TurnRepository.get")(function* (id: TurnId) {
      const rows = yield* sql`SELECT * FROM rika_turns WHERE id = ${id}`.pipe(Effect.mapError(repositoryError))
      return rows[0] === undefined ? undefined : yield* decode(rows[0])
    })
    return Service.of({
      createForSubmission: Effect.fn("TurnRepository.createForSubmission")(function* (input) {
        const promptParts =
          input.promptParts === undefined
            ? null
            : yield* Schema.encodeEffect(PromptPartsJson)(input.promptParts).pipe(Effect.mapError(repositoryError))
        const executionRoute =
          input.executionRoute === undefined
            ? null
            : yield* Schema.encodeEffect(ExecutionRouteJson)(input.executionRoute).pipe(
                Effect.mapError(repositoryError),
              )
        yield* sql`INSERT INTO rika_turns (id, thread_id, prompt, prompt_parts_json, execution_route_json, review_fan_out_id, status, created_at, updated_at)
          VALUES (${input.id}, ${input.threadId}, ${input.prompt}, ${promptParts}, ${executionRoute}, ${input.reviewFanOutId ?? null},
            CASE WHEN EXISTS (SELECT 1 FROM rika_turns WHERE thread_id = ${input.threadId} AND status IN ('queued', 'accepted', 'running', 'waiting')) THEN 'queued' ELSE 'accepted' END,
            ${input.now}, ${input.now})`.pipe(Effect.mapError(repositoryError))
        const turn = yield* get(input.id)
        if (turn === undefined) return yield* missing(input.id)
        return turn
      }),
      get,
      list: Effect.fn("TurnRepository.list")(function* (threadId) {
        const rows =
          yield* sql`SELECT * FROM rika_turns WHERE thread_id = ${threadId} ORDER BY created_at ASC, rowid ASC`.pipe(
            Effect.mapError(repositoryError),
          )
        return yield* Effect.all(rows.map(decode))
      }),
      findActive: Effect.fn("TurnRepository.findActive")(function* (threadId) {
        const rows =
          yield* sql`SELECT * FROM rika_turns WHERE thread_id = ${threadId} AND status IN ('accepted', 'running', 'waiting') ORDER BY created_at ASC, rowid ASC LIMIT 1`.pipe(
            Effect.mapError(repositoryError),
          )
        return rows[0] === undefined ? undefined : yield* decode(rows[0])
      }),
      listQueued: Effect.fn("TurnRepository.listQueued")(function* (threadId) {
        const rows =
          yield* sql`SELECT * FROM rika_turns WHERE thread_id = ${threadId} AND status = 'queued' ORDER BY created_at ASC, rowid ASC`.pipe(
            Effect.mapError(repositoryError),
          )
        return yield* Effect.all(rows.map(decode))
      }),
      listNonterminal: Effect.gen(function* () {
        const rows =
          yield* sql`SELECT * FROM rika_turns WHERE status IN ('queued', 'accepted', 'running', 'waiting') ORDER BY created_at ASC, rowid ASC`.pipe(
            Effect.mapError(repositoryError),
          )
        return yield* Effect.all(rows.map(decode))
      }).pipe(Effect.withSpan("TurnRepository.listNonterminal")),
      claimNextQueued: Effect.fn("TurnRepository.claimNextQueued")(function* (threadId, now) {
        const rows = yield* sql`UPDATE rika_turns SET status = 'accepted', updated_at = ${now}
          WHERE id = (SELECT id FROM rika_turns WHERE thread_id = ${threadId} AND status = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT 1)
          AND NOT EXISTS (SELECT 1 FROM rika_turns WHERE thread_id = ${threadId} AND status IN ('accepted', 'running', 'waiting'))
          RETURNING *`.pipe(Effect.mapError(repositoryError))
        return rows[0] === undefined ? undefined : yield* decode(rows[0])
      }),
      editQueued: Effect.fn("TurnRepository.editQueued")(function* (id, prompt, now) {
        const rows =
          yield* sql`UPDATE rika_turns SET prompt = ${prompt}, updated_at = ${now} WHERE id = ${id} AND status = 'queued' RETURNING *`.pipe(
            Effect.mapError(repositoryError),
          )
        if (rows[0] === undefined) return yield* RepositoryError.make({ message: `Turn ${id} is not queued` })
        return yield* decode(rows[0])
      }),
      dequeue: Effect.fn("TurnRepository.dequeue")(function* (id) {
        const rows = yield* sql`DELETE FROM rika_turns WHERE id = ${id} AND status = 'queued' RETURNING id`.pipe(
          Effect.mapError(repositoryError),
        )
        if (rows[0] === undefined) return yield* RepositoryError.make({ message: `Turn ${id} is not queued` })
      }),
      setExtensionPin: Effect.fn("TurnRepository.setExtensionPin")(function* (id, pin) {
        const encoded = yield* Schema.encodeEffect(ExtensionPinJson)(pin).pipe(Effect.mapError(repositoryError))
        const rows = yield* sql`UPDATE rika_turns SET extension_pin_json = ${encoded}
          WHERE id = ${id} AND (extension_pin_json IS NULL OR extension_pin_json = ${encoded}) RETURNING *`.pipe(
          Effect.mapError(repositoryError),
        )
        if (rows[0] === undefined)
          return yield* RepositoryError.make({
            message: `Turn ${id} extension pin is immutable or turn does not exist`,
          })
        return yield* decode(rows[0])
      }),
      setExecutionRoute: Effect.fn("TurnRepository.setExecutionRoute")(function* (id, pin) {
        const encoded = yield* Schema.encodeEffect(ExecutionRouteJson)(pin).pipe(Effect.mapError(repositoryError))
        const rows = yield* sql`UPDATE rika_turns SET execution_route_json = ${encoded}
          WHERE id = ${id} AND (execution_route_json IS NULL OR execution_route_json = ${encoded}) RETURNING *`.pipe(
          Effect.mapError(repositoryError),
        )
        if (rows[0] === undefined)
          return yield* RepositoryError.make({
            message: `Turn ${id} execution route is immutable or turn does not exist`,
          })
        return yield* decode(rows[0])
      }),
      setStatus: Effect.fn("TurnRepository.setStatus")(function* (id, status, lastCursor, now) {
        const rows =
          yield* sql`UPDATE rika_turns SET status = ${status}, last_cursor = ${lastCursor ?? null}, updated_at = ${now}
          WHERE id = ${id} AND (status NOT IN ('completed', 'failed', 'cancelled') OR ${status} IN ('completed', 'failed', 'cancelled'))
          RETURNING *`.pipe(Effect.mapError(repositoryError))
        if (rows[0] !== undefined) return yield* decode(rows[0])
        const turn = yield* get(id)
        if (turn === undefined) return yield* missing(id)
        return turn
      }),
    })
  }),
)
