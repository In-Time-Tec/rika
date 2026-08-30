import { Effect, Schema } from "effect"
import { TurnResult } from "@rika/product/thread-result"
import { ThreadId } from "@rika/product/thread-record"
import { Turn, TurnId } from "@rika/product/turn-record"
import { Status } from "@rika/product/execution-status"
import { turnRowJson } from "./row-json-codec"
import { RepositoryError } from "@rika/product/turn-repository"

const Row = Schema.Struct({
  id: Schema.String,
  thread_id: Schema.String,
  turn_kind: Schema.String,
  prompt: Schema.String,
  status: Schema.String,
  execution_route_json: Schema.NullOr(Schema.String),
  execution_link_json: Schema.optionalKey(Schema.NullOr(Schema.String)),
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
})

const {
  promptParts: PromptPartsJson,
  executionRoute: ExecutionRouteJson,
  executionLink: ExecutionLinkJson,
  author: AuthorJson,
  lineage: LineageJson,
} = turnRowJson

const repositoryError = (error: string | { readonly message: string }) =>
  Schema.is(RepositoryError)(error)
    ? error
    : RepositoryError.make({ message: Schema.is(Schema.String)(error) ? error : error.message })

const shellResultIsMissing = (value: typeof Row.Type) =>
  value.shell_result_text === null || (value.shell_result_truncated !== 0 && value.shell_result_truncated !== 1)

export const decodeQueueState = <Row>(row: Row) =>
  Schema.decodeUnknownEffect(QueueStateRow)(row).pipe(Effect.mapError(repositoryError))

export const decode = <Row>(row: Row) =>
  Effect.gen(function* () {
    const value = yield* Schema.decodeUnknownEffect(Row)(row)
    const author = yield* Schema.decodeEffect(AuthorJson)(value.author_json)
    const lineage = yield* Schema.decodeEffect(LineageJson)(value.lineage_json)
    const id = yield* Schema.decodeEffect(TurnId)(value.id)
    const threadId = yield* Schema.decodeEffect(ThreadId)(value.thread_id)
    if (value.turn_kind === "RecordedShell") {
      if (value.shell_command === null)
        return yield* RepositoryError.make({ message: `Recorded shell turn ${id} has no command` })
      const terminal = value.status !== "running"
      if (terminal && shellResultIsMissing(value))
        return yield* RepositoryError.make({ message: `Recorded shell turn ${id} has no terminal result` })
      const recordedShell = {
        _tag: "RecordedShell",
        id,
        threadId,
        prompt: value.prompt,
        command: value.shell_command,
        status: value.status,
        author,
        lineage,
        createdAt: value.created_at,
        updatedAt: value.updated_at,
      }
      if (!terminal) return yield* Schema.decodeUnknownEffect(Turn)(recordedShell)
      const result =
        value.shell_result_exit_code === null
          ? { text: value.shell_result_text, truncated: value.shell_result_truncated === 1 }
          : {
              text: value.shell_result_text,
              truncated: value.shell_result_truncated === 1,
              exitCode: value.shell_result_exit_code,
            }
      return yield* Schema.decodeUnknownEffect(Turn)({ ...recordedShell, result })
    }
    if (value.turn_kind !== "AgentExecution")
      return yield* RepositoryError.make({ message: `Turn ${id} has unknown kind ${value.turn_kind}` })
    if (value.execution_route_json === null)
      return yield* RepositoryError.make({ message: `Agent execution turn ${id} has no execution route` })
    const status = yield* Schema.decodeUnknownEffect(Status)(value.status)
    const promptParts =
      value.prompt_parts_json == null ? undefined : yield* Schema.decodeEffect(PromptPartsJson)(value.prompt_parts_json)
    const executionRoute = yield* Schema.decodeEffect(ExecutionRouteJson)(value.execution_route_json)
    const executionLink =
      value.execution_link_json == null
        ? undefined
        : yield* Schema.decodeEffect(ExecutionLinkJson)(value.execution_link_json)
    const agent = {
      _tag: "AgentExecution" as const,
      id,
      threadId,
      prompt: value.prompt,
      status,
      executionRoute,
      author,
      lineage,
      createdAt: value.created_at,
      updatedAt: value.updated_at,
    }
    if (promptParts === undefined) return executionLink === undefined ? agent : { ...agent, executionLink }
    return executionLink === undefined ? { ...agent, promptParts } : { ...agent, promptParts, executionLink }
  }).pipe(Effect.mapError(repositoryError))

export const decodeAgent = <Row>(row: Row) =>
  decode(row).pipe(
    Effect.filterOrFail(TurnResult.isAgentExecution, () => repositoryError("Expected an AgentExecution turn")),
  )
