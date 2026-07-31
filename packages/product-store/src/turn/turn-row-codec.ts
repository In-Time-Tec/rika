import { Effect, Schema } from "effect"
import { ThreadId } from "@rika/product/thread-record"
import {
  AgentExecutionTurn,
  ExecutionExtensionPin,
  ExecutionRoutePin,
  PromptPart,
  Status,
  StopIntent,
  Turn,
  TurnAuthor,
  TurnId,
  TurnLineage,
  isAgentExecution,
} from "@rika/product/turn-record"
import {
  QueuedTurnUnavailable,
  QueueFull,
  RepositoryError,
  defaultPageSize,
  maximumPageSize,
} from "@rika/product/turn-repository"
import type { PageCursor, Submission, QueueItemChange } from "@rika/product/turn-repository"
const Row = Schema.Struct({
  id: Schema.String,
  thread_id: Schema.String,
  turn_kind: Schema.String,
  prompt: Schema.String,
  status: Schema.String,
  stop_intent: Schema.optionalKey(Schema.NullOr(Schema.String)),
  last_cursor: Schema.NullOr(Schema.String),
  extension_pin_json: Schema.optionalKey(Schema.NullOr(Schema.String)),
  execution_route_json: Schema.NullOr(Schema.String),
  review_fan_out_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  prompt_parts_json: Schema.optionalKey(Schema.NullOr(Schema.String)),
  shell_command: Schema.NullOr(Schema.String),
  shell_result_text: Schema.NullOr(Schema.String),
  shell_result_truncated: Schema.NullOr(Schema.Finite),
  shell_result_exit_code: Schema.NullOr(Schema.Finite),
  author_json: Schema.String,
  lineage_json: Schema.String,
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

export const ExtensionPinJson = Schema.fromJsonString(ExecutionExtensionPin)
export const PromptPartsJson = Schema.fromJsonString(Schema.Array(PromptPart))
export const ExecutionRouteJson = Schema.fromJsonString(ExecutionRoutePin)
export const AuthorJson = Schema.fromJsonString(TurnAuthor)
export const LineageJson = Schema.fromJsonString(TurnLineage)
const repositoryError = (error: unknown) =>
  Schema.is(RepositoryError)(error) ? error : RepositoryError.make({ message: String(error) })
const submissionError = (error: unknown) => (Schema.is(QueueFull)(error) ? error : repositoryError(error))
const takeQueuedError = (error: unknown) => (Schema.is(QueuedTurnUnavailable)(error) ? error : repositoryError(error))
const missing = (id: TurnId) => RepositoryError.make({ message: `Turn ${id} does not exist` })
const queuedTurnUnavailable = (id: TurnId) =>
  QueuedTurnUnavailable.make({ turnId: id, message: `Turn ${id} is not queued` })
const clone = <T extends Turn>(turn: T): T => structuredClone(turn)
const sameTurn = Schema.toEquivalence(Turn)
const pageSize = (limit: number | undefined) =>
  Math.min(maximumPageSize, Math.max(1, Math.floor(limit ?? defaultPageSize)))
const cursorFor = (turn: Turn | undefined): PageCursor | undefined =>
  turn === undefined ? undefined : { createdAt: turn.createdAt, id: turn.id }
export const decodeQueueState = (row: unknown) =>
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
  | { readonly _tag: "Queued"; readonly value: AgentExecutionTurn & { readonly queue: QueueItemChange } }

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
export const decode = (row: unknown) =>
  Effect.gen(function* () {
    const value = yield* Schema.decodeUnknownEffect(Row)(row)
    const author = yield* Schema.decodeUnknownEffect(AuthorJson)(value.author_json)
    const lineage = yield* Schema.decodeUnknownEffect(LineageJson)(value.lineage_json)
    const id = yield* Schema.decodeUnknownEffect(TurnId)(value.id)
    const threadId = yield* Schema.decodeUnknownEffect(ThreadId)(value.thread_id)
    if (value.turn_kind === "RecordedShell") {
      if (value.shell_command === null)
        return yield* RepositoryError.make({ message: `Recorded shell turn ${id} has no command` })
      const terminal = value.status !== "running"
      if (
        terminal &&
        (value.shell_result_text === null || (value.shell_result_truncated !== 0 && value.shell_result_truncated !== 1))
      )
        return yield* RepositoryError.make({ message: `Recorded shell turn ${id} has no terminal result` })
      return yield* Schema.decodeUnknownEffect(Turn)({
        _tag: "RecordedShell",
        id,
        threadId,
        prompt: value.prompt,
        command: value.shell_command,
        status: value.status,
        stopIntent: "none",
        author,
        lineage,
        createdAt: value.created_at,
        updatedAt: value.updated_at,
        ...(terminal
          ? {
              result: {
                text: value.shell_result_text,
                truncated: value.shell_result_truncated === 1,
                ...(value.shell_result_exit_code === null ? {} : { exitCode: value.shell_result_exit_code }),
              },
            }
          : {}),
      })
    }
    if (value.turn_kind !== "AgentExecution")
      return yield* RepositoryError.make({ message: `Turn ${id} has unknown kind ${value.turn_kind}` })
    if (value.execution_route_json === null)
      return yield* RepositoryError.make({ message: `Agent execution turn ${id} has no execution route` })
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
      _tag: "AgentExecution" as const,
      id,
      threadId,
      prompt: value.prompt,
      ...(promptParts === undefined ? {} : { promptParts }),
      status,
      stopIntent: (value.stop_intent === "requested" ? "requested" : "none") satisfies StopIntent as StopIntent,
      ...(value.last_cursor === null ? {} : { lastCursor: value.last_cursor }),
      ...(extensionPin === undefined ? {} : { extensionPin }),
      executionRoute,
      ...(value.review_fan_out_id == null ? {} : { reviewFanOutId: value.review_fan_out_id }),
      author,
      lineage,
      createdAt: value.created_at,
      updatedAt: value.updated_at,
    }
  }).pipe(Effect.mapError(repositoryError))

export const decodeAgent = (row: unknown) =>
  decode(row).pipe(Effect.filterOrFail(isAgentExecution, () => repositoryError("Expected an AgentExecution turn")))

export const StoredTurnRow = Row

export const decodeStoredTurn = decode
export const encodeExtensionPin = (pin: ExecutionExtensionPin) =>
  Schema.encodeEffect(ExtensionPinJson)(pin).pipe(Effect.mapError(repositoryError))
