import { Effect, Schema } from "effect"
import type { HostModules } from "tenetkit/repl"
import { ThreadContract } from "@rika/coding-tools/thread-tool-contract"
import * as ThreadQuery from "@rika/product/thread-query-service"
import * as ThreadToolAction from "@rika/product/thread-tool-action"
import * as Turn from "@rika/product/turn-record"
import { operation } from "../envelope"

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

type ReadRequest = Parameters<ThreadQuery.Interface["read"]>[0]

const selector = (selection: typeof ThreadContract.ReadThreadInput.Type.selection): ReadRequest["selector"] => {
  if (selection.mode === "overview") return { _tag: "overview" as const }
  if (selection.mode === "subtree") {
    let value: ReadRequest["selector"] = {
      _tag: "subtree" as const,
      subagentId: selection.subagentId,
    }
    if (selection.cursor?.before !== undefined)
      value = {
        ...value,
        before: { ...selection.cursor.before, turnId: Turn.TurnId.make(selection.cursor.before.turnId) },
      }
    if (selection.cursor !== undefined && "offset" in selection.cursor)
      value = { ...value, offset: selection.cursor.offset }
    return value
  }
  if (selection.mode === "recent") {
    let value: ReadRequest["selector"] = {
      _tag: "recent" as const,
    }
    if (selection.limit !== undefined) value = { ...value, limit: selection.limit }
    if (selection.cursor !== undefined)
      value = { ...value, before: { ...selection.cursor, id: Turn.TurnId.make(selection.cursor.id) } }
    return value
  }
  let value: ReadRequest["selector"] = {
    _tag: "relevant" as const,
    query: selection.query,
  }
  if (selection.limit !== undefined) value = { ...value, limit: selection.limit }
  if (selection.cursor !== undefined)
    value = { ...value, before: { ...selection.cursor, turnId: Turn.TurnId.make(selection.cursor.turnId) } }
  return value
}

export const make = (workspace: string): HostModules.Module<ThreadQuery.Factory> => {
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
            thread.read(
              input.includeArchived === undefined
                ? {
                    threadId: input.threadId,
                    selector: selector(input.selection),
                  }
                : {
                    threadId: input.threadId,
                    includeArchived: input.includeArchived,
                    selector: selector(input.selection),
                  },
            ),
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
