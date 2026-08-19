import { Effect, Schema } from "effect"
import { TurnResult } from "@rika/product/thread-result"
import { ThreadId } from "@rika/product/thread-record"
import { Turn, TurnId } from "@rika/product/turn-record"
import { Status } from "@rika/product/execution-status"
import { turnRowJson } from "./turn-row-json-codec"
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

const repositoryError = (error: unknown) =>
  Schema.is(RepositoryError)(error) ? error : RepositoryError.make({ message: String(error) })

export const decodeQueueState = (row: unknown) =>
  Schema.decodeUnknownEffect(QueueStateRow)(row).pipe(Effect.mapError(repositoryError))

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
    const promptParts =
      value.prompt_parts_json == null
        ? undefined
        : yield* Schema.decodeUnknownEffect(PromptPartsJson)(value.prompt_parts_json)
    const executionRoute = yield* Schema.decodeUnknownEffect(ExecutionRouteJson)(value.execution_route_json)
    const executionLink =
      value.execution_link_json == null
        ? undefined
        : yield* Schema.decodeUnknownEffect(ExecutionLinkJson)(value.execution_link_json)
    return {
      _tag: "AgentExecution" as const,
      id,
      threadId,
      prompt: value.prompt,
      ...(promptParts === undefined ? {} : { promptParts }),
      status,
      executionRoute,
      ...(executionLink === undefined ? {} : { executionLink }),
      author,
      lineage,
      createdAt: value.created_at,
      updatedAt: value.updated_at,
    }
  }).pipe(Effect.mapError(repositoryError))

export const decodeAgent = (row: unknown) =>
  decode(row).pipe(
    Effect.filterOrFail(TurnResult.isAgentExecution, () => repositoryError("Expected an AgentExecution turn")),
  )
