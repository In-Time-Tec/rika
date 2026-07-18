import { Context, Effect, Layer, Ref, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { ThreadId } from "./thread-schema"
import { ExecutionExtensionPin, ExecutionRoutePin, PromptPart, Status, Turn, TurnId } from "./turn-schema"

export class RepositoryError extends Schema.TaggedErrorClass<RepositoryError>()("TurnRepositoryError", {
  message: Schema.String,
}) {}

export class QueueFull extends Schema.TaggedErrorClass<QueueFull>()("TurnQueueFull", {
  threadId: ThreadId,
  capacity: Schema.Int,
  count: Schema.Int,
}) {}

export class QueuedTurnUnavailable extends Schema.TaggedErrorClass<QueuedTurnUnavailable>()("QueuedTurnUnavailable", {
  turnId: TurnId,
  message: Schema.String,
}) {}

export interface CreateInput {
  readonly id: TurnId
  readonly threadId: ThreadId
  readonly prompt: string
  readonly promptParts?: ReadonlyArray<PromptPart>
  readonly executionRoute: ExecutionRoutePin
  readonly reviewFanOutId?: string
  readonly queueCapacity: number
  readonly now: number
}

export const PageCursor = Schema.Struct({ createdAt: Schema.Finite, id: TurnId })
export interface PageCursor extends Schema.Schema.Type<typeof PageCursor> {}

export interface PageOptions {
  readonly before?: PageCursor | undefined
  readonly limit?: number
}

export interface PageResult {
  readonly turns: ReadonlyArray<Turn>
  readonly hasOlder: boolean
  readonly oldestCursor: PageCursor | undefined
  readonly newestCursor: PageCursor | undefined
}

export interface QueueItemChange {
  readonly threadId: ThreadId
  readonly revision: number
  readonly queuedCount: number
  readonly becameNonempty: boolean
  readonly change:
    | { readonly _tag: "Added"; readonly turn: Turn }
    | { readonly _tag: "Updated"; readonly turn: Turn }
    | { readonly _tag: "Removed"; readonly turnId: TurnId }
}

export interface QueueSnapshot {
  readonly threadId: ThreadId
  readonly revision: number
  readonly queuedCount: number
  readonly turns: ReadonlyArray<Turn>
}

export type Submission = Turn & { readonly queue?: QueueItemChange }

export interface QueueClaim {
  readonly turn: Turn
  readonly token: string
}

export type QueueClaimFinish =
  | { readonly _tag: "Transitioned"; readonly turn: Turn; readonly queue: QueueItemChange }
  | { readonly _tag: "Unavailable" }

export interface QueuedTurnTake {
  readonly turn: Turn
  readonly queue: QueueItemChange
}

export interface QueueWake {
  readonly threadId: ThreadId
  readonly generation: number
  readonly queueRevision: number
}

export const defaultPageSize = 50
export const maximumPageSize = 200

export interface Interface {
  readonly createForSubmission: (input: CreateInput) => Effect.Effect<Submission, RepositoryError | QueueFull>
  readonly copy: (turn: Turn, queueCapacity: number) => Effect.Effect<Submission, RepositoryError | QueueFull>
  readonly get: (id: TurnId) => Effect.Effect<Turn | undefined, RepositoryError>
  readonly list: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<Turn>, RepositoryError>
  readonly page: (threadId: ThreadId, options?: PageOptions) => Effect.Effect<PageResult, RepositoryError>
  readonly findActive: (threadId: ThreadId) => Effect.Effect<Turn | undefined, RepositoryError>
  readonly readQueue: (threadId: ThreadId) => Effect.Effect<QueueSnapshot, RepositoryError>
  readonly listNonterminal: Effect.Effect<ReadonlyArray<Turn>, RepositoryError>
  readonly claimNextQueued: (threadId: ThreadId, now: number) => Effect.Effect<QueueClaim | undefined, RepositoryError>
  readonly finishQueuedClaim: (
    claim: QueueClaim,
    status: "running" | "failed",
    lastCursor: string | undefined,
    extensionPin: ExecutionExtensionPin | undefined,
    now: number,
  ) => Effect.Effect<QueueClaimFinish, RepositoryError>
  readonly releaseQueuedClaim: (claim: QueueClaim) => Effect.Effect<void, RepositoryError>
  readonly resetQueueClaims: Effect.Effect<void, RepositoryError>
  readonly editQueued: (
    id: TurnId,
    prompt: string,
    now: number,
  ) => Effect.Effect<Turn & { readonly queue: QueueItemChange }, RepositoryError>
  readonly takeQueued: (id: TurnId) => Effect.Effect<QueuedTurnTake, RepositoryError | QueuedTurnUnavailable>
  readonly dequeue: (id: TurnId) => Effect.Effect<QueueItemChange, RepositoryError>
  readonly requeueAccepted: (
    id: TurnId,
    queueCapacity: number,
    now: number,
  ) => Effect.Effect<Turn & { readonly queue: QueueItemChange }, RepositoryError | QueueFull>
  readonly requestQueueWake: (threadId: ThreadId) => Effect.Effect<QueueWake | undefined, RepositoryError>
  readonly consumeQueueWake: (threadId: ThreadId, generation: number) => Effect.Effect<boolean, RepositoryError>
  readonly setExtensionPin: (id: TurnId, pin: ExecutionExtensionPin) => Effect.Effect<Turn, RepositoryError>
  readonly setStatus: (
    id: TurnId,
    status: Status,
    lastCursor: string | undefined,
    now: number,
  ) => Effect.Effect<Turn, RepositoryError>
  readonly repairCursor: (
    id: TurnId,
    status: Status,
    expectedCursor: string | undefined,
    cursor: string | undefined,
  ) => Effect.Effect<boolean, RepositoryError>
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
  execution_route_json: Schema.String,
  review_fan_out_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  prompt_parts_json: Schema.optionalKey(Schema.NullOr(Schema.String)),
  created_at: Schema.Finite,
  updated_at: Schema.Finite,
})

const QueueStateRow = Schema.Struct({
  thread_id: Schema.String,
  revision: Schema.Finite,
  queued_count: Schema.Finite,
  wake_generation: Schema.Finite,
  wake_pending: Schema.Finite,
})

const ExtensionPinJson = Schema.fromJsonString(ExecutionExtensionPin)
const PromptPartsJson = Schema.fromJsonString(Schema.Array(PromptPart))
const ExecutionRouteJson = Schema.fromJsonString(ExecutionRoutePin)
const repositoryError = (error: unknown) => RepositoryError.make({ message: String(error) })
const submissionError = (error: unknown) => (Schema.is(QueueFull)(error) ? error : repositoryError(error))
const takeQueuedError = (error: unknown) => (Schema.is(QueuedTurnUnavailable)(error) ? error : repositoryError(error))
const missing = (id: TurnId) => RepositoryError.make({ message: `Turn ${id} does not exist` })
const queuedTurnUnavailable = (id: TurnId) =>
  QueuedTurnUnavailable.make({ turnId: id, message: `Turn ${id} is not queued` })
const clone = (turn: Turn): Turn => structuredClone(turn)
const pageSize = (limit: number | undefined) =>
  Math.min(maximumPageSize, Math.max(1, Math.floor(limit ?? defaultPageSize)))
const cursorFor = (turn: Turn | undefined): PageCursor | undefined =>
  turn === undefined ? undefined : { createdAt: turn.createdAt, id: turn.id }
const decodeQueueState = (row: unknown) =>
  Schema.decodeUnknownEffect(QueueStateRow)(row).pipe(Effect.mapError(repositoryError))
interface MemoryQueueState {
  readonly revision: number
  readonly queuedCount: number
  readonly wakeGeneration: number
  readonly wakePending: boolean
}

interface MemoryState {
  readonly turns: ReadonlyMap<TurnId, Turn>
  readonly queues: ReadonlyMap<ThreadId, MemoryQueueState>
  readonly claims: ReadonlyMap<TurnId, string>
  readonly nextClaimToken: number
}

type MemorySubmissionResult =
  | { readonly _tag: "Duplicate" }
  | { readonly _tag: "Full"; readonly error: QueueFull }
  | { readonly _tag: "Created"; readonly submission: Submission }

type MemoryRequeueResult =
  | { readonly _tag: "Unavailable" }
  | { readonly _tag: "Full"; readonly error: QueueFull }
  | { readonly _tag: "Queued"; readonly value: Turn & { readonly queue: QueueItemChange } }

const emptyQueueState: MemoryQueueState = {
  revision: 0,
  queuedCount: 0,
  wakeGeneration: 0,
  wakePending: false,
}

const queueState = (state: MemoryState, threadId: ThreadId): MemoryQueueState =>
  state.queues.get(threadId) ?? emptyQueueState

const withQueueState = (state: MemoryState, threadId: ThreadId, queue: MemoryQueueState): MemoryState => ({
  ...state,
  queues: new Map(state.queues).set(threadId, queue),
})
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
    const executionRoute = yield* Schema.decodeUnknownEffect(ExecutionRouteJson)(value.execution_route_json)
    return {
      id: TurnId.make(value.id),
      threadId: ThreadId.make(value.thread_id),
      prompt: value.prompt,
      ...(promptParts === undefined ? {} : { promptParts }),
      status,
      ...(value.last_cursor === null ? {} : { lastCursor: value.last_cursor }),
      ...(extensionPin === undefined ? {} : { extensionPin }),
      executionRoute,
      ...(value.review_fan_out_id == null ? {} : { reviewFanOutId: value.review_fan_out_id }),
      createdAt: value.created_at,
      updatedAt: value.updated_at,
    }
  }).pipe(Effect.mapError(repositoryError))

const encodeExtensionPin = (pin: ExecutionExtensionPin) =>
  Schema.encodeEffect(ExtensionPinJson)(pin).pipe(Effect.mapError(repositoryError))

export const makeMemory = (initial: ReadonlyArray<Turn> = []) =>
  Effect.gen(function* () {
    const initialTurns = new Map(initial.map((turn) => [turn.id, clone(turn)]))
    const initialQueues = new Map<ThreadId, MemoryQueueState>()
    for (const turn of initialTurns.values()) {
      if (turn.status !== "queued") continue
      const current = initialQueues.get(turn.threadId) ?? emptyQueueState
      initialQueues.set(turn.threadId, {
        ...current,
        queuedCount: current.queuedCount + 1,
        revision: current.revision + 1,
      })
    }
    const state = yield* Ref.make<MemoryState>({
      turns: initialTurns,
      queues: initialQueues,
      claims: new Map(),
      nextClaimToken: 1,
    })
    const get = Effect.fn("TurnRepository.get")(function* (id: TurnId) {
      const turn = (yield* Ref.get(state)).turns.get(id)
      return turn === undefined ? undefined : clone(turn)
    })
    return Service.of({
      createForSubmission: Effect.fn("TurnRepository.createForSubmission")(function* (input) {
        const result = yield* Ref.modify(state, (current): readonly [MemorySubmissionResult, MemoryState] => {
          if (current.turns.has(input.id)) return [{ _tag: "Duplicate" as const }, current] as const
          const active = [...current.turns.values()].some(
            (turn) =>
              turn.threadId === input.threadId && ["queued", "accepted", "running", "waiting"].includes(turn.status),
          )
          const previousQueue = queueState(current, input.threadId)
          if (active && previousQueue.queuedCount >= input.queueCapacity)
            return [
              {
                _tag: "Full" as const,
                error: QueueFull.make({
                  threadId: input.threadId,
                  capacity: input.queueCapacity,
                  count: previousQueue.queuedCount,
                }),
              },
              current,
            ] as const
          const { queueCapacity, now, ...submission } = input
          void queueCapacity
          const turn: Turn = {
            ...submission,
            status: active ? "queued" : "accepted",
            createdAt: now,
            updatedAt: now,
          }
          const withTurn: MemoryState = { ...current, turns: new Map(current.turns).set(turn.id, clone(turn)) }
          if (turn.status !== "queued")
            return [{ _tag: "Created" as const, submission: clone(turn) }, withTurn] as const
          const nextQueue = {
            ...previousQueue,
            revision: previousQueue.revision + 1,
            queuedCount: previousQueue.queuedCount + 1,
          }
          const queue: QueueItemChange = {
            threadId: input.threadId,
            revision: nextQueue.revision,
            queuedCount: nextQueue.queuedCount,
            becameNonempty: nextQueue.queuedCount === 1,
            change: { _tag: "Added", turn: clone(turn) },
          }
          return [
            { _tag: "Created" as const, submission: { ...clone(turn), queue } },
            withQueueState(withTurn, input.threadId, nextQueue),
          ] as const
        })
        if (result._tag === "Duplicate") return yield* RepositoryError.make({ message: `Turn ${input.id} exists` })
        if (result._tag === "Full") return yield* result.error
        return result.submission
      }),
      copy: Effect.fn("TurnRepository.copy")(function* (turn, queueCapacity) {
        const result = yield* Ref.modify(state, (current): readonly [MemorySubmissionResult, MemoryState] => {
          if (current.turns.has(turn.id)) return [{ _tag: "Duplicate" as const }, current]
          const previousQueue = queueState(current, turn.threadId)
          if (turn.status === "queued" && previousQueue.queuedCount >= queueCapacity)
            return [
              {
                _tag: "Full" as const,
                error: QueueFull.make({
                  threadId: turn.threadId,
                  capacity: queueCapacity,
                  count: previousQueue.queuedCount,
                }),
              },
              current,
            ] as const
          const copied = clone(turn)
          const withTurn: MemoryState = { ...current, turns: new Map(current.turns).set(copied.id, copied) }
          if (copied.status !== "queued")
            return [{ _tag: "Created" as const, submission: clone(copied) }, withTurn] as const
          const nextQueue = {
            ...previousQueue,
            revision: previousQueue.revision + 1,
            queuedCount: previousQueue.queuedCount + 1,
          }
          const queue: QueueItemChange = {
            threadId: copied.threadId,
            revision: nextQueue.revision,
            queuedCount: nextQueue.queuedCount,
            becameNonempty: nextQueue.queuedCount === 1,
            change: { _tag: "Added", turn: clone(copied) },
          }
          return [
            { _tag: "Created" as const, submission: { ...clone(copied), queue } },
            withQueueState(withTurn, copied.threadId, nextQueue),
          ] as const
        })
        if (result._tag === "Duplicate") return yield* RepositoryError.make({ message: `Turn ${turn.id} exists` })
        if (result._tag === "Full") return yield* result.error
        return result.submission
      }),
      get,
      list: Effect.fn("TurnRepository.list")(function* (threadId) {
        return [...(yield* Ref.get(state)).turns.values()]
          .filter((turn) => turn.threadId === threadId)
          .toSorted((left, right) => left.createdAt - right.createdAt)
          .map(clone)
      }),
      page: Effect.fn("TurnRepository.page")(function* (threadId, options = {}) {
        const limit = pageSize(options.limit)
        const descending = [...(yield* Ref.get(state)).turns.values()]
          .filter(
            (turn) =>
              turn.threadId === threadId &&
              (options.before === undefined ||
                turn.createdAt < options.before.createdAt ||
                (turn.createdAt === options.before.createdAt && turn.id < options.before.id)),
          )
          .toSorted((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
        const hasOlder = descending.length > limit
        const turns = descending.slice(0, limit).toReversed().map(clone)
        return {
          turns,
          hasOlder,
          oldestCursor: cursorFor(turns[0]),
          newestCursor: cursorFor(turns.at(-1)),
        }
      }),
      findActive: Effect.fn("TurnRepository.findActive")(function* (threadId) {
        return [...(yield* Ref.get(state)).turns.values()]
          .filter((turn) => turn.threadId === threadId && ["accepted", "running", "waiting"].includes(turn.status))
          .toSorted((left, right) => left.createdAt - right.createdAt)[0]
      }),
      readQueue: Effect.fn("TurnRepository.readQueue")(function* (threadId) {
        const current = yield* Ref.get(state)
        const queue = queueState(current, threadId)
        const turns = [...current.turns.values()]
          .filter((turn) => turn.threadId === threadId && turn.status === "queued")
          .toSorted((left, right) => left.createdAt - right.createdAt)
          .map(clone)
        return { threadId, revision: queue.revision, queuedCount: queue.queuedCount, turns }
      }),
      listNonterminal: Effect.gen(function* () {
        return [...(yield* Ref.get(state)).turns.values()]
          .filter((turn) => ["queued", "accepted", "running", "waiting"].includes(turn.status))
          .toSorted((left, right) => left.createdAt - right.createdAt)
          .map(clone)
      }).pipe(Effect.withSpan("TurnRepository.listNonterminal")),
      claimNextQueued: Effect.fn("TurnRepository.claimNextQueued")(function* (threadId, _now) {
        return yield* Ref.modify(state, (current) => {
          const hasActive = [...current.turns.values()].some(
            (turn) => turn.threadId === threadId && ["accepted", "running", "waiting"].includes(turn.status),
          )
          const queued = [...current.turns.values()]
            .filter((turn) => turn.threadId === threadId && turn.status === "queued" && !current.claims.has(turn.id))
            .toSorted((left, right) => left.createdAt - right.createdAt)[0]
          const hasClaim = [...current.claims.keys()].some((id) => current.turns.get(id)?.threadId === threadId)
          if (hasActive || hasClaim || queued === undefined) return [undefined, current]
          const token = String(current.nextClaimToken)
          return [
            { turn: clone(queued), token },
            {
              ...current,
              claims: new Map(current.claims).set(queued.id, token),
              nextClaimToken: current.nextClaimToken + 1,
            },
          ]
        })
      }),
      finishQueuedClaim: Effect.fn("TurnRepository.finishQueuedClaim")(
        function* (claim, status, lastCursor, extensionPin, now) {
          return yield* Ref.modify(state, (current): readonly [QueueClaimFinish, MemoryState] => {
            const existing = current.turns.get(claim.turn.id)
            if (existing?.status !== "queued" || current.claims.get(claim.turn.id) !== claim.token)
              return [{ _tag: "Unavailable" }, current]
            const { lastCursor: previousCursor, ...withoutCursor } = existing
            void previousCursor
            const nextTurn: Turn = {
              ...withoutCursor,
              status,
              ...(lastCursor === undefined ? {} : { lastCursor }),
              ...(extensionPin === undefined ? {} : { extensionPin: structuredClone(extensionPin) }),
              updatedAt: now,
            }
            const previousQueue = queueState(current, existing.threadId)
            const nextQueue = {
              ...previousQueue,
              revision: previousQueue.revision + 1,
              queuedCount: Math.max(0, previousQueue.queuedCount - 1),
            }
            const queue: QueueItemChange = {
              threadId: existing.threadId,
              revision: nextQueue.revision,
              queuedCount: nextQueue.queuedCount,
              becameNonempty: false,
              change: { _tag: "Removed", turnId: existing.id },
            }
            const claims = new Map(current.claims)
            claims.delete(existing.id)
            return [
              { _tag: "Transitioned", turn: clone(nextTurn), queue },
              withQueueState(
                { ...current, turns: new Map(current.turns).set(existing.id, nextTurn), claims },
                existing.threadId,
                nextQueue,
              ),
            ]
          })
        },
      ),
      releaseQueuedClaim: Effect.fn("TurnRepository.releaseQueuedClaim")(function* (claim) {
        yield* Ref.update(state, (current) => {
          if (current.claims.get(claim.turn.id) !== claim.token) return current
          const claims = new Map(current.claims)
          claims.delete(claim.turn.id)
          return { ...current, claims }
        })
      }),
      resetQueueClaims: Ref.update(state, (current) => ({ ...current, claims: new Map() })),
      editQueued: Effect.fn("TurnRepository.editQueued")(function* (id, prompt, now) {
        const result = yield* Ref.modify(state, (current) => {
          const turn = current.turns.get(id)
          if (turn === undefined || turn.status !== "queued") return [undefined, current]
          const { promptParts: _promptParts, ...withoutParts } = turn
          void _promptParts
          const nextTurn = { ...withoutParts, prompt, updatedAt: now }
          const claims = new Map(current.claims)
          claims.delete(id)
          const previousQueue = queueState(current, turn.threadId)
          const nextQueue = { ...previousQueue, revision: previousQueue.revision + 1 }
          const queue: QueueItemChange = {
            threadId: turn.threadId,
            revision: nextQueue.revision,
            queuedCount: nextQueue.queuedCount,
            becameNonempty: false,
            change: { _tag: "Updated", turn: clone(nextTurn) },
          }
          return [
            { ...clone(nextTurn), queue },
            withQueueState(
              { ...current, turns: new Map(current.turns).set(id, nextTurn), claims },
              turn.threadId,
              nextQueue,
            ),
          ]
        })
        if (result === undefined) return yield* RepositoryError.make({ message: `Turn ${id} is not queued` })
        return result
      }),
      takeQueued: Effect.fn("TurnRepository.takeQueued")(function* (id) {
        const result = yield* Ref.modify(state, (current) => {
          const turn = current.turns.get(id)
          if (turn === undefined || turn.status !== "queued") return [undefined, current]
          const turns = new Map(current.turns)
          turns.delete(id)
          const claims = new Map(current.claims)
          claims.delete(id)
          const previousQueue = queueState(current, turn.threadId)
          const nextQueue = {
            ...previousQueue,
            revision: previousQueue.revision + 1,
            queuedCount: Math.max(0, previousQueue.queuedCount - 1),
          }
          const queue: QueueItemChange = {
            threadId: turn.threadId,
            revision: nextQueue.revision,
            queuedCount: nextQueue.queuedCount,
            becameNonempty: false,
            change: { _tag: "Removed", turnId: id },
          }
          return [{ turn: clone(turn), queue }, withQueueState({ ...current, turns, claims }, turn.threadId, nextQueue)]
        })
        if (result === undefined) return yield* queuedTurnUnavailable(id)
        return result
      }),
      dequeue: Effect.fn("TurnRepository.dequeue")(function* (id) {
        const result = yield* Ref.modify(state, (current) => {
          const turn = current.turns.get(id)
          if (turn === undefined || turn.status !== "queued") return [undefined, current]
          const turns = new Map(current.turns)
          turns.delete(id)
          const claims = new Map(current.claims)
          claims.delete(id)
          const previousQueue = queueState(current, turn.threadId)
          const nextQueue = {
            ...previousQueue,
            revision: previousQueue.revision + 1,
            queuedCount: Math.max(0, previousQueue.queuedCount - 1),
          }
          const queue: QueueItemChange = {
            threadId: turn.threadId,
            revision: nextQueue.revision,
            queuedCount: nextQueue.queuedCount,
            becameNonempty: false,
            change: { _tag: "Removed", turnId: id },
          }
          return [queue, withQueueState({ ...current, turns, claims }, turn.threadId, nextQueue)]
        })
        if (result === undefined) return yield* RepositoryError.make({ message: `Turn ${id} is not queued` })
        return result
      }),
      requeueAccepted: Effect.fn("TurnRepository.requeueAccepted")(function* (id, queueCapacity, now) {
        const result = yield* Ref.modify(state, (current): readonly [MemoryRequeueResult, MemoryState] => {
          const turn = current.turns.get(id)
          if (turn === undefined || turn.status !== "accepted") return [{ _tag: "Unavailable" as const }, current]
          const hasOtherActive = [...current.turns.values()].some(
            (candidate) =>
              candidate.id !== id &&
              candidate.threadId === turn.threadId &&
              ["accepted", "running", "waiting"].includes(candidate.status),
          )
          if (hasOtherActive) return [{ _tag: "Unavailable" as const }, current]
          const previousQueue = queueState(current, turn.threadId)
          if (previousQueue.queuedCount >= queueCapacity)
            return [
              {
                _tag: "Full" as const,
                error: QueueFull.make({
                  threadId: turn.threadId,
                  capacity: queueCapacity,
                  count: previousQueue.queuedCount,
                }),
              },
              current,
            ]
          const queued = { ...turn, status: "queued" as const, updatedAt: now }
          const nextQueue = {
            ...previousQueue,
            revision: previousQueue.revision + 1,
            queuedCount: previousQueue.queuedCount + 1,
          }
          const queue: QueueItemChange = {
            threadId: turn.threadId,
            revision: nextQueue.revision,
            queuedCount: nextQueue.queuedCount,
            becameNonempty: nextQueue.queuedCount === 1,
            change: { _tag: "Added", turn: clone(queued) },
          }
          return [
            { _tag: "Queued" as const, value: { ...clone(queued), queue } },
            withQueueState({ ...current, turns: new Map(current.turns).set(id, queued) }, turn.threadId, nextQueue),
          ]
        })
        if (result._tag === "Unavailable")
          return yield* RepositoryError.make({ message: `Turn ${id} is not an unowned accepted turn` })
        if (result._tag === "Full") return yield* result.error
        return result.value
      }),
      requestQueueWake: Effect.fn("TurnRepository.requestQueueWake")(function* (threadId) {
        return yield* Ref.modify(state, (current) => {
          const queue = queueState(current, threadId)
          if (queue.queuedCount === 0) return [undefined, current]
          if (queue.wakePending)
            return [{ threadId, generation: queue.wakeGeneration, queueRevision: queue.revision }, current]
          const next = { ...queue, wakeGeneration: queue.wakeGeneration + 1, wakePending: true }
          return [
            { threadId, generation: next.wakeGeneration, queueRevision: next.revision },
            withQueueState(current, threadId, next),
          ]
        })
      }),
      consumeQueueWake: Effect.fn("TurnRepository.consumeQueueWake")(function* (threadId, generation) {
        return yield* Ref.modify(state, (current) => {
          const queue = queueState(current, threadId)
          if (!queue.wakePending || queue.wakeGeneration !== generation) return [false, current]
          return [true, withQueueState(current, threadId, { ...queue, wakePending: false })]
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
        yield* Ref.update(state, (currentState) => ({
          ...currentState,
          turns: new Map(currentState.turns).set(id, next),
        }))
        return clone(next)
      }),
      setStatus: Effect.fn("TurnRepository.setStatus")(function* (id, status, lastCursor, now) {
        const updated = yield* Ref.modify(
          state,
          (
            currentState,
          ): readonly [
            { readonly _tag: "Missing" } | { readonly _tag: "Queued" } | { readonly _tag: "Ok"; readonly turn: Turn },
            MemoryState,
          ] => {
            const current = currentState.turns.get(id)
            if (current === undefined) return [{ _tag: "Missing" }, currentState]
            if (status === "queued" || current.status === "queued") return [{ _tag: "Queued" }, currentState]
            if (isTerminalStatus(current.status)) return [{ _tag: "Ok", turn: clone(current) }, currentState]
            const { lastCursor: previousCursor, ...withoutCursor } = current
            void previousCursor
            const next: Turn = {
              ...withoutCursor,
              status,
              ...(lastCursor === undefined ? {} : { lastCursor }),
              updatedAt: now,
            }
            const withTurn: MemoryState = {
              ...currentState,
              turns: new Map(currentState.turns).set(id, next),
            }
            return [{ _tag: "Ok", turn: clone(next) }, withTurn]
          },
        )
        if (updated._tag === "Missing") return yield* missing(id)
        if (updated._tag === "Queued")
          return yield* RepositoryError.make({
            message: `Turn ${id} cannot transition into or out of 'queued' via setStatus`,
          })
        return updated.turn
      }),
      repairCursor: Effect.fn("TurnRepository.repairCursor")(function* (id, status, expectedCursor, cursor) {
        return yield* Ref.modify(state, (currentState) => {
          const current = currentState.turns.get(id)
          if (current === undefined || current.status !== status || current.lastCursor !== expectedCursor)
            return [false, currentState]
          const { lastCursor: previousCursor, ...withoutCursor } = current
          void previousCursor
          const next: Turn = { ...withoutCursor, ...(cursor === undefined ? {} : { lastCursor: cursor }) }
          return [true, { ...currentState, turns: new Map(currentState.turns).set(id, next) }]
        })
      }),
    })
  })

export const memoryLayer = (initial: ReadonlyArray<Turn> = []) => Layer.effect(Service, makeMemory(initial))

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
        const executionRoute = yield* Schema.encodeEffect(ExecutionRouteJson)(input.executionRoute).pipe(
          Effect.mapError(repositoryError),
        )
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO rika_turns (id, thread_id, prompt, prompt_parts_json, execution_route_json, review_fan_out_id, status, created_at, updated_at)
                VALUES (${input.id}, ${input.threadId}, ${input.prompt}, ${promptParts}, ${executionRoute}, ${input.reviewFanOutId ?? null},
                  CASE WHEN EXISTS (SELECT 1 FROM rika_turns WHERE thread_id = ${input.threadId} AND status IN ('queued', 'accepted', 'running', 'waiting')) THEN 'queued' ELSE 'accepted' END,
                  ${input.now}, ${input.now})`
              const rows = yield* sql`SELECT * FROM rika_turns WHERE id = ${input.id}`
              if (rows[0] === undefined) return yield* missing(input.id)
              const turn = yield* decode(rows[0])
              if (turn.status !== "queued") return turn
              yield* sql`INSERT INTO rika_thread_queue_state (thread_id) VALUES (${input.threadId}) ON CONFLICT (thread_id) DO NOTHING`
              const queueRows = yield* sql`UPDATE rika_thread_queue_state
                SET revision = revision + 1, queued_count = queued_count + 1
                WHERE thread_id = ${input.threadId} AND queued_count < ${input.queueCapacity}
                RETURNING *`
              if (queueRows[0] === undefined) {
                const stateRows = yield* sql`SELECT * FROM rika_thread_queue_state WHERE thread_id = ${input.threadId}`
                if (stateRows[0] === undefined)
                  return yield* repositoryError(`Queue state ${input.threadId} does not exist`)
                const state = yield* decodeQueueState(stateRows[0])
                return yield* QueueFull.make({
                  threadId: input.threadId,
                  capacity: input.queueCapacity,
                  count: state.queued_count,
                })
              }
              const state = yield* decodeQueueState(queueRows[0])
              return {
                ...turn,
                queue: {
                  threadId: input.threadId,
                  revision: state.revision,
                  queuedCount: state.queued_count,
                  becameNonempty: state.queued_count === 1,
                  change: { _tag: "Added" as const, turn },
                },
              }
            }),
          )
          .pipe(Effect.mapError(submissionError))
      }),
      copy: Effect.fn("TurnRepository.copy")(function* (turn, queueCapacity) {
        const promptParts =
          turn.promptParts === undefined
            ? null
            : yield* Schema.encodeEffect(PromptPartsJson)(turn.promptParts).pipe(Effect.mapError(repositoryError))
        const extensionPin =
          turn.extensionPin === undefined
            ? null
            : yield* Schema.encodeEffect(ExtensionPinJson)(turn.extensionPin).pipe(Effect.mapError(repositoryError))
        const executionRoute = yield* Schema.encodeEffect(ExecutionRouteJson)(turn.executionRoute).pipe(
          Effect.mapError(repositoryError),
        )
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO rika_turns (id, thread_id, prompt, prompt_parts_json, status, last_cursor, extension_pin_json, execution_route_json, review_fan_out_id, created_at, updated_at)
                VALUES (${turn.id}, ${turn.threadId}, ${turn.prompt}, ${promptParts}, ${turn.status}, ${turn.lastCursor ?? null}, ${extensionPin}, ${executionRoute}, ${turn.reviewFanOutId ?? null}, ${turn.createdAt}, ${turn.updatedAt})`
              if (turn.status !== "queued") return turn
              yield* sql`INSERT INTO rika_thread_queue_state (thread_id) VALUES (${turn.threadId}) ON CONFLICT (thread_id) DO NOTHING`
              const queueRows = yield* sql`UPDATE rika_thread_queue_state
                SET revision = revision + 1, queued_count = queued_count + 1
                WHERE thread_id = ${turn.threadId} AND queued_count < ${queueCapacity}
                RETURNING *`
              if (queueRows[0] === undefined) {
                const stateRows = yield* sql`SELECT * FROM rika_thread_queue_state WHERE thread_id = ${turn.threadId}`
                if (stateRows[0] === undefined)
                  return yield* repositoryError(`Queue state ${turn.threadId} does not exist`)
                const state = yield* decodeQueueState(stateRows[0])
                return yield* QueueFull.make({
                  threadId: turn.threadId,
                  capacity: queueCapacity,
                  count: state.queued_count,
                })
              }
              const state = yield* decodeQueueState(queueRows[0])
              return {
                ...turn,
                queue: {
                  threadId: turn.threadId,
                  revision: state.revision,
                  queuedCount: state.queued_count,
                  becameNonempty: state.queued_count === 1,
                  change: { _tag: "Added" as const, turn },
                },
              }
            }),
          )
          .pipe(Effect.mapError(submissionError))
      }),
      get,
      list: Effect.fn("TurnRepository.list")(function* (threadId) {
        const rows =
          yield* sql`SELECT * FROM rika_turns WHERE thread_id = ${threadId} ORDER BY created_at ASC, rowid ASC`.pipe(
            Effect.mapError(repositoryError),
          )
        return yield* Effect.all(rows.map(decode))
      }),
      page: Effect.fn("TurnRepository.page")(function* (threadId, options = {}) {
        const limit = pageSize(options.limit)
        const rows =
          options.before === undefined
            ? yield* sql`SELECT * FROM rika_turns WHERE thread_id = ${threadId} ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`.pipe(
                Effect.mapError(repositoryError),
              )
            : yield* sql`SELECT * FROM rika_turns WHERE thread_id = ${threadId} AND (created_at < ${options.before.createdAt} OR (created_at = ${options.before.createdAt} AND id < ${options.before.id})) ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`.pipe(
                Effect.mapError(repositoryError),
              )
        const turns = (yield* Effect.all(rows.slice(0, limit).map(decode))).toReversed()
        return {
          turns,
          hasOlder: rows.length > limit,
          oldestCursor: cursorFor(turns[0]),
          newestCursor: cursorFor(turns.at(-1)),
        }
      }),
      findActive: Effect.fn("TurnRepository.findActive")(function* (threadId) {
        const rows =
          yield* sql`SELECT * FROM rika_turns WHERE thread_id = ${threadId} AND status IN ('accepted', 'running', 'waiting') ORDER BY created_at ASC, rowid ASC LIMIT 1`.pipe(
            Effect.mapError(repositoryError),
          )
        return rows[0] === undefined ? undefined : yield* decode(rows[0])
      }),
      readQueue: Effect.fn("TurnRepository.readQueue")(function* (threadId) {
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const stateRows = yield* sql`SELECT * FROM rika_thread_queue_state WHERE thread_id = ${threadId}`
              const state = stateRows[0] === undefined ? undefined : yield* decodeQueueState(stateRows[0])
              const rows =
                yield* sql`SELECT * FROM rika_turns WHERE thread_id = ${threadId} AND status = 'queued' ORDER BY created_at ASC, rowid ASC`
              const turns = yield* Effect.all(rows.map(decode))
              return {
                threadId,
                revision: state?.revision ?? 0,
                queuedCount: state?.queued_count ?? 0,
                turns,
              }
            }),
          )
          .pipe(Effect.mapError(repositoryError))
      }),
      listNonterminal: Effect.gen(function* () {
        const rows =
          yield* sql`SELECT * FROM rika_turns WHERE status IN ('queued', 'accepted', 'running', 'waiting') ORDER BY created_at ASC, rowid ASC`.pipe(
            Effect.mapError(repositoryError),
          )
        return yield* Effect.all(rows.map(decode))
      }).pipe(Effect.withSpan("TurnRepository.listNonterminal")),
      claimNextQueued: Effect.fn("TurnRepository.claimNextQueued")(function* (threadId, _now) {
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const rows = yield* sql`UPDATE rika_turns SET queue_claim_token = hex(randomblob(16))
                WHERE id = (SELECT id FROM rika_turns WHERE thread_id = ${threadId} AND status = 'queued' AND queue_claim_token IS NULL ORDER BY created_at ASC, rowid ASC LIMIT 1)
                AND NOT EXISTS (SELECT 1 FROM rika_turns WHERE thread_id = ${threadId} AND status IN ('accepted', 'running', 'waiting'))
                AND NOT EXISTS (SELECT 1 FROM rika_turns WHERE thread_id = ${threadId} AND queue_claim_token IS NOT NULL)
                RETURNING *`
              if (rows[0] === undefined) return undefined
              const turn = yield* decode(rows[0])
              return { turn, token: String((rows[0] as { queue_claim_token: unknown }).queue_claim_token) }
            }),
          )
          .pipe(Effect.mapError(repositoryError))
      }),
      finishQueuedClaim: Effect.fn("TurnRepository.finishQueuedClaim")(
        function* (claim, status, lastCursor, extensionPin, now) {
          const encodedPin = extensionPin === undefined ? undefined : yield* encodeExtensionPin(extensionPin)
          return yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const rows = yield* sql`UPDATE rika_turns
            SET status = ${status}, last_cursor = ${lastCursor ?? null}, extension_pin_json = COALESCE(extension_pin_json, ${encodedPin ?? null}), updated_at = ${now}, queue_claim_token = NULL
            WHERE id = ${claim.turn.id} AND status = 'queued' AND queue_claim_token = ${claim.token} RETURNING *`
                if (rows[0] === undefined) return { _tag: "Unavailable" as const }
                const turn = yield* decode(rows[0])
                const queueRows = yield* sql`UPDATE rika_thread_queue_state
            SET revision = revision + 1, queued_count = MAX(queued_count - 1, 0)
            WHERE thread_id = ${turn.threadId} RETURNING *`
                if (queueRows[0] === undefined)
                  return yield* repositoryError(`Queue state ${turn.threadId} does not exist`)
                const state = yield* decodeQueueState(queueRows[0])
                return {
                  _tag: "Transitioned" as const,
                  turn,
                  queue: {
                    threadId: turn.threadId,
                    revision: state.revision,
                    queuedCount: state.queued_count,
                    becameNonempty: false,
                    change: { _tag: "Removed" as const, turnId: turn.id },
                  },
                }
              }),
            )
            .pipe(Effect.mapError(repositoryError))
        },
      ),
      releaseQueuedClaim: Effect.fn("TurnRepository.releaseQueuedClaim")(function* (claim) {
        yield* sql`UPDATE rika_turns SET queue_claim_token = NULL
          WHERE id = ${claim.turn.id} AND status = 'queued' AND queue_claim_token = ${claim.token}`.pipe(
          Effect.asVoid,
          Effect.mapError(repositoryError),
        )
      }),
      resetQueueClaims: sql`UPDATE rika_turns SET queue_claim_token = NULL WHERE queue_claim_token IS NOT NULL`.pipe(
        Effect.asVoid,
        Effect.mapError(repositoryError),
      ),
      editQueued: Effect.fn("TurnRepository.editQueued")(function* (id, prompt, now) {
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const rows =
                yield* sql`UPDATE rika_turns SET prompt = ${prompt}, prompt_parts_json = NULL, updated_at = ${now}, queue_claim_token = NULL WHERE id = ${id} AND status = 'queued' RETURNING *`
              if (rows[0] === undefined) return yield* RepositoryError.make({ message: `Turn ${id} is not queued` })
              const turn = yield* decode(rows[0])
              const queueRows = yield* sql`UPDATE rika_thread_queue_state
                SET revision = revision + 1
                WHERE thread_id = ${turn.threadId}
                RETURNING *`
              if (queueRows[0] === undefined)
                return yield* repositoryError(`Queue state ${turn.threadId} does not exist`)
              const state = yield* decodeQueueState(queueRows[0])
              return {
                ...turn,
                queue: {
                  threadId: turn.threadId,
                  revision: state.revision,
                  queuedCount: state.queued_count,
                  becameNonempty: false,
                  change: { _tag: "Updated" as const, turn },
                },
              }
            }),
          )
          .pipe(Effect.mapError(repositoryError))
      }),
      takeQueued: Effect.fn("TurnRepository.takeQueued")(function* (id) {
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const rows = yield* sql`DELETE FROM rika_turns WHERE id = ${id} AND status = 'queued' RETURNING *`
              if (rows[0] === undefined) return yield* queuedTurnUnavailable(id)
              const turn = yield* decode(rows[0])
              const queueRows = yield* sql`UPDATE rika_thread_queue_state
                SET revision = revision + 1, queued_count = MAX(queued_count - 1, 0)
                WHERE thread_id = ${turn.threadId}
                RETURNING *`
              if (queueRows[0] === undefined)
                return yield* repositoryError(`Queue state ${turn.threadId} does not exist`)
              const state = yield* decodeQueueState(queueRows[0])
              return {
                turn,
                queue: {
                  threadId: turn.threadId,
                  revision: state.revision,
                  queuedCount: state.queued_count,
                  becameNonempty: false,
                  change: { _tag: "Removed" as const, turnId: turn.id },
                },
              }
            }),
          )
          .pipe(Effect.mapError(takeQueuedError))
      }),
      dequeue: Effect.fn("TurnRepository.dequeue")(function* (id) {
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const rows = yield* sql`DELETE FROM rika_turns WHERE id = ${id} AND status = 'queued' RETURNING *`
              if (rows[0] === undefined) return yield* RepositoryError.make({ message: `Turn ${id} is not queued` })
              const turn = yield* decode(rows[0])
              const queueRows = yield* sql`UPDATE rika_thread_queue_state
                SET revision = revision + 1, queued_count = MAX(queued_count - 1, 0)
                WHERE thread_id = ${turn.threadId}
                RETURNING *`
              if (queueRows[0] === undefined)
                return yield* repositoryError(`Queue state ${turn.threadId} does not exist`)
              const state = yield* decodeQueueState(queueRows[0])
              return {
                threadId: turn.threadId,
                revision: state.revision,
                queuedCount: state.queued_count,
                becameNonempty: false,
                change: { _tag: "Removed" as const, turnId: turn.id },
              }
            }),
          )
          .pipe(Effect.mapError(repositoryError))
      }),
      requeueAccepted: Effect.fn("TurnRepository.requeueAccepted")(function* (id, queueCapacity, now) {
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const currentRows = yield* sql`SELECT * FROM rika_turns WHERE id = ${id} AND status = 'accepted'`
              if (currentRows[0] === undefined)
                return yield* RepositoryError.make({ message: `Turn ${id} is not an unowned accepted turn` })
              const current = yield* decode(currentRows[0])
              const otherActive = yield* sql`SELECT id FROM rika_turns
                WHERE thread_id = ${current.threadId} AND id != ${id} AND status IN ('accepted', 'running', 'waiting') LIMIT 1`
              if (otherActive[0] !== undefined)
                return yield* RepositoryError.make({ message: `Turn ${id} is not an unowned accepted turn` })
              yield* sql`INSERT INTO rika_thread_queue_state (thread_id) VALUES (${current.threadId}) ON CONFLICT (thread_id) DO NOTHING`
              const queueRows = yield* sql`UPDATE rika_thread_queue_state
                SET revision = revision + 1, queued_count = queued_count + 1
                WHERE thread_id = ${current.threadId} AND queued_count < ${queueCapacity}
                RETURNING *`
              if (queueRows[0] === undefined) {
                const stateRows =
                  yield* sql`SELECT * FROM rika_thread_queue_state WHERE thread_id = ${current.threadId}`
                if (stateRows[0] === undefined)
                  return yield* repositoryError(`Queue state ${current.threadId} does not exist`)
                const state = yield* decodeQueueState(stateRows[0])
                return yield* QueueFull.make({
                  threadId: current.threadId,
                  capacity: queueCapacity,
                  count: state.queued_count,
                })
              }
              const updatedRows = yield* sql`UPDATE rika_turns SET status = 'queued', updated_at = ${now}
                WHERE id = ${id} AND status = 'accepted' RETURNING *`
              if (updatedRows[0] === undefined)
                return yield* RepositoryError.make({ message: `Turn ${id} is not an unowned accepted turn` })
              const turn = yield* decode(updatedRows[0])
              const state = yield* decodeQueueState(queueRows[0])
              return {
                ...turn,
                queue: {
                  threadId: turn.threadId,
                  revision: state.revision,
                  queuedCount: state.queued_count,
                  becameNonempty: state.queued_count === 1,
                  change: { _tag: "Added" as const, turn },
                },
              }
            }),
          )
          .pipe(Effect.mapError(submissionError))
      }),
      requestQueueWake: Effect.fn("TurnRepository.requestQueueWake")(function* (threadId) {
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO rika_thread_queue_state (thread_id) VALUES (${threadId}) ON CONFLICT (thread_id) DO NOTHING`
              const existingRows = yield* sql`SELECT * FROM rika_thread_queue_state WHERE thread_id = ${threadId}`
              if (existingRows[0] === undefined) return yield* repositoryError(`Queue state ${threadId} does not exist`)
              const existing = yield* decodeQueueState(existingRows[0])
              if (existing.queued_count === 0) return undefined
              if (existing.wake_pending === 1)
                return { threadId, generation: existing.wake_generation, queueRevision: existing.revision }
              const rows = yield* sql`UPDATE rika_thread_queue_state
                SET wake_generation = wake_generation + 1, wake_pending = 1
                WHERE thread_id = ${threadId} AND queued_count > 0 AND wake_pending = 0
                RETURNING *`
              if (rows[0] === undefined) return undefined
              const state = yield* decodeQueueState(rows[0])
              return { threadId, generation: state.wake_generation, queueRevision: state.revision }
            }),
          )
          .pipe(Effect.mapError(repositoryError))
      }),
      consumeQueueWake: Effect.fn("TurnRepository.consumeQueueWake")(function* (threadId, generation) {
        const rows = yield* sql`UPDATE rika_thread_queue_state SET wake_pending = 0
          WHERE thread_id = ${threadId} AND wake_pending = 1 AND wake_generation = ${generation}
          RETURNING thread_id`.pipe(Effect.mapError(repositoryError))
        return rows[0] !== undefined
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
      setStatus: Effect.fn("TurnRepository.setStatus")(function* (id, status, lastCursor, now) {
        if (status === "queued")
          return yield* RepositoryError.make({
            message: `Turn ${id} cannot transition into 'queued' via setStatus`,
          })
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const before = yield* sql`SELECT * FROM rika_turns WHERE id = ${id}`
              if (before[0] === undefined) return yield* missing(id)
              const wasQueued = String((before[0] as { status?: unknown }).status) === "queued"
              if (wasQueued)
                return yield* RepositoryError.make({
                  message: `Turn ${id} cannot transition into or out of 'queued' via setStatus`,
                })
              const rows =
                yield* sql`UPDATE rika_turns SET status = ${status}, last_cursor = ${lastCursor ?? null}, updated_at = ${now}
                WHERE id = ${id} AND status NOT IN ('completed', 'failed', 'cancelled')
                RETURNING *`
              if (rows[0] === undefined) return yield* decode(before[0])
              const turn = yield* decode(rows[0])
              return turn
            }),
          )
          .pipe(Effect.mapError(repositoryError))
      }),
      repairCursor: Effect.fn("TurnRepository.repairCursor")(function* (id, status, expectedCursor, cursor) {
        const rows = yield* sql`UPDATE rika_turns SET last_cursor = ${cursor ?? null}
          WHERE id = ${id}
            AND status = ${status}
            AND (last_cursor = ${expectedCursor ?? null} OR (last_cursor IS NULL AND ${expectedCursor ?? null} IS NULL))
          RETURNING id`.pipe(Effect.mapError(repositoryError))
        return rows[0] !== undefined
      }),
    })
  }),
)
