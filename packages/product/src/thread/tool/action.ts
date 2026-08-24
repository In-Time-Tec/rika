import * as ThreadToolkits from "@rika/coding-tools/thread-tool-contract"
import { ThreadContract } from "@rika/coding-tools/thread-tool-contract"
import * as Turn from "@rika/product/turn-record"
import { Effect } from "effect"
import * as ThreadQuery from "../query/service"
import type { Selector } from "../query/input"
import type { ReadSuccess } from "../query/result-delivery"

const error = (tool: string, cause: { readonly _tag: string }) =>
  ThreadContract.ReadToolError.make({ tool, message: JSON.stringify(cause) })

const publicError = (tool: string, cause: { readonly _tag: string }) => ({
  _tag: "ThreadToolError" as const,
  tool,
  code: "operation" as const,
  message: JSON.stringify(cause).slice(0, 8_000),
  retryable: false,
})

const publicSelection = (selector: Selector) => {
  if (selector._tag === "overview") return { mode: "overview" as const }
  if (selector._tag === "recent")
    return {
      mode: "recent" as const,
      ...(selector.limit === undefined ? {} : { limit: selector.limit }),
      ...(selector.before === undefined ? {} : { cursor: selector.before }),
    }
  if (selector._tag === "relevant")
    return {
      mode: "relevant" as const,
      query: selector.query,
      ...(selector.limit === undefined ? {} : { limit: selector.limit }),
      ...(selector.before === undefined ? {} : { cursor: selector.before }),
    }
  if (selector._tag === "subtree") {
    const cursor = (() => {
      if (selector.offset !== undefined)
        return {
          cursor: {
            offset: selector.offset,
            ...(selector.before === undefined ? {} : { before: selector.before }),
          },
        }
      if (selector.before !== undefined) return { cursor: { before: selector.before } }
      return {}
    })()
    return {
      mode: "subtree" as const,
      subagentId: selector.subagentId,
      ...cursor,
    }
  }
  return { mode: "overview" as const }
}

export const publicReadResult = (result: ReadSuccess) => ({
  ...result,
  selector: publicSelection(result.selector),
  omissions: result.omissions.map((omission) => ({
    ...omission,
    continuation: publicSelection(omission.continuation),
  })),
})

export const handlerLayerForWorkspace = (workspace: string) =>
  ThreadToolkits.ThreadContract.toolkit.toLayer(
    Effect.gen(function* () {
      const factory = yield* ThreadQuery.Factory
      return {
        search_threads: (input) =>
          factory.forWorkspace(workspace).pipe(
            Effect.flatMap((query) => query.search(input)),
            Effect.mapError((cause) => error("search_threads", cause)),
          ),
        read_thread_transcript: (input) =>
          factory.forWorkspace(workspace).pipe(
            Effect.flatMap((query) =>
              query
                .read({
                  threadId: input.threadId,
                  ...(input.includeArchived === undefined ? {} : { includeArchived: input.includeArchived }),
                  selector: (() => {
                    const selection = input.selection
                    if (selection.mode === "overview") return { _tag: "overview" as const }
                    if (selection.mode === "subtree")
                      return {
                        _tag: "subtree" as const,
                        subagentId: selection.subagentId,
                        ...(selection.cursor?.before === undefined
                          ? {}
                          : {
                              before: {
                                ...selection.cursor.before,
                                turnId: Turn.TurnId.make(selection.cursor.before.turnId),
                              },
                            }),
                        ...(selection.cursor !== undefined && "offset" in selection.cursor
                          ? { offset: selection.cursor.offset }
                          : {}),
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
                  })(),
                })
                .pipe(
                  Effect.map((result) => ({
                    text: JSON.stringify(publicReadResult(result)),
                    truncated: result.truncated,
                  })),
                ),
            ),
            Effect.mapError((cause) => error("read_thread_transcript", cause)),
          ),
      }
    }),
  )

export const findHandlerLayerForWorkspace = (workspace: string) =>
  ThreadToolkits.ThreadContract.findToolkit.toLayer(
    Effect.gen(function* () {
      const factory = yield* ThreadQuery.Factory
      return {
        find_thread: (input) =>
          factory.forWorkspace(workspace).pipe(
            Effect.flatMap((query) => query.find(input)),
            Effect.mapError((cause) => publicError("find_thread", cause)),
          ),
      }
    }),
  )

export const findHandlerLayer = ThreadToolkits.ThreadContract.findToolkit.toLayer(
  Effect.gen(function* () {
    const query = yield* ThreadQuery.Service
    return {
      find_thread: (input) => query.find(input).pipe(Effect.mapError((cause) => publicError("find_thread", cause))),
    }
  }),
)
