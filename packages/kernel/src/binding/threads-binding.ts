import { Effect, Schema } from "effect"
import type { HostBindingRegistry } from "tenetkit/repl"
import { ThreadContract } from "@rika/coding-tools/thread-tool-contract"
import * as ThreadQuery from "@rika/product/thread-query-service"
import * as ThreadToolAction from "@rika/product/thread-tool-action"
import * as Turn from "@rika/product/turn-record"
import { operation } from "./nested-operation-envelope"

export const name = "threads"

const Failure = ThreadContract.ReadToolFailure

const Text = Schema.Struct({ text: Schema.String, truncated: Schema.Boolean })

const failure = (tool: string, cause: { readonly _tag: string }) => ({
  _tag: "ThreadToolError" as const,
  tool,
  code: cause._tag === "ThreadNotFoundError" ? ("not_found" as const) : ("operation" as const),
  message: JSON.stringify(cause).slice(0, 8_000),
  retryable: false,
})

const selector = (selection: typeof ThreadContract.ReadThreadInput.Type.selection) => {
  if (selection.mode === "overview") return { _tag: "overview" as const }
  if (selection.mode === "subtree")
    return {
      _tag: "subtree" as const,
      subagentId: selection.subagentId,
      ...(selection.cursor?.before === undefined
        ? {}
        : { before: { ...selection.cursor.before, turnId: Turn.TurnId.make(selection.cursor.before.turnId) } }),
      ...(selection.cursor !== undefined && "offset" in selection.cursor ? { offset: selection.cursor.offset } : {}),
    }
  if (selection.mode === "recent")
    return {
      _tag: "recent" as const,
      ...(selection.limit === undefined ? {} : { limit: selection.limit }),
      ...(selection.cursor === undefined
        ? {}
        : { before: { ...selection.cursor, id: Turn.TurnId.make(selection.cursor.id) } }),
    }
  return {
    _tag: "relevant" as const,
    query: selection.query,
    ...(selection.limit === undefined ? {} : { limit: selection.limit }),
    ...(selection.cursor === undefined
      ? {}
      : { before: { ...selection.cursor, turnId: Turn.TurnId.make(selection.cursor.turnId) } }),
  }
}

export const make = (workspace: string): HostBindingRegistry.Module<ThreadQuery.Factory> => {
  const query = Effect.flatMap(ThreadQuery.Factory, (factory) => factory.forWorkspace(workspace))
  return {
    name,
    operations: [
      operation({
        name: "search",
        input: ThreadContract.FindThreadInput,
        output: Text,
        failure: Failure,
        handle: (input) =>
          Effect.flatMap(query, (thread) => thread.search(input)).pipe(
            Effect.mapError((cause) => failure("threads.search", cause)),
          ),
      }),
      operation({
        name: "find",
        input: ThreadContract.FindThreadInput,
        output: ThreadContract.FindThreadSuccess,
        failure: Failure,
        handle: (input) =>
          Effect.flatMap(query, (thread) => thread.find(input)).pipe(
            Effect.mapError((cause) => failure("threads.find", cause)),
          ),
      }),
      operation({
        name: "read",
        input: ThreadContract.ReadThreadInput,
        output: Text,
        failure: Failure,
        handle: (input) =>
          Effect.flatMap(query, (thread) =>
            thread.read({
              threadId: input.threadId,
              ...(input.includeArchived === undefined ? {} : { includeArchived: input.includeArchived }),
              selector: selector(input.selection),
            }),
          ).pipe(
            Effect.map((result) => ({
              text: JSON.stringify(ThreadToolAction.publicReadResult(result)),
              truncated: result.truncated,
            })),
            Effect.mapError((cause) => failure("threads.read", cause)),
          ),
      }),
    ],
  }
}
