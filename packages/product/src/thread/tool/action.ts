import * as ThreadToolkits from "@rika/coding-tools/thread-tool-contract"
import { ThreadContract } from "@rika/coding-tools/thread-tool-contract"
import * as Turn from "@rika/product/turn-record"
import { Effect } from "effect"
import * as ThreadQuery from "../query/service"
import type { Selector } from "../query/input"
import type { ReadSuccess } from "../query/result-delivery"

type PublicSelection = (typeof ThreadContract.ReadThreadInput.Type)["selection"]

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
  if (selector._tag === "recent") {
    let selection: Extract<PublicSelection, { readonly mode: "recent" }> = { mode: "recent" }
    if (selector.limit !== undefined) selection = { ...selection, limit: selector.limit }
    if (selector.before !== undefined) selection = { ...selection, cursor: selector.before }
    return selection
  }
  if (selector._tag === "relevant") {
    let selection: Extract<PublicSelection, { readonly mode: "relevant" }> = {
      mode: "relevant",
      query: selector.query,
    }
    if (selector.limit !== undefined) selection = { ...selection, limit: selector.limit }
    if (selector.before !== undefined) selection = { ...selection, cursor: selector.before }
    return selection
  }
  if (selector._tag === "subtree") {
    let selection: Extract<PublicSelection, { readonly mode: "subtree" }> = {
      mode: "subtree" as const,
      subagentId: selector.subagentId,
    }
    if (selector.offset !== undefined) {
      let cursor: NonNullable<typeof selection.cursor> = { offset: selector.offset }
      if (selector.before !== undefined) cursor = { ...cursor, before: selector.before }
      selection = { ...selection, cursor }
    } else if (selector.before !== undefined) selection = { ...selection, cursor: { before: selector.before } }
    return selection
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
            Effect.flatMap((query) => {
              const selector = (() => {
                const selection = input.selection
                if (selection.mode === "overview") return { _tag: "overview" as const }
                if (selection.mode === "subtree") {
                  let value: Extract<Selector, { readonly _tag: "subtree" }> = {
                    _tag: "subtree" as const,
                    subagentId: selection.subagentId,
                  }
                  if (selection.cursor?.before !== undefined)
                    value = {
                      ...value,
                      before: {
                        ...selection.cursor.before,
                        turnId: Turn.TurnId.make(selection.cursor.before.turnId),
                      },
                    }
                  if (selection.cursor !== undefined && "offset" in selection.cursor)
                    value = { ...value, offset: selection.cursor.offset }
                  return value
                }
                if (selection.mode === "recent") {
                  let value: Extract<Selector, { readonly _tag: "recent" }> = {
                    _tag: "recent" as const,
                  }
                  if (selection.limit !== undefined) value = { ...value, limit: selection.limit }
                  if (selection.cursor !== undefined)
                    value = { ...value, before: { ...selection.cursor, id: Turn.TurnId.make(selection.cursor.id) } }
                  return value
                }
                let value: Extract<Selector, { readonly _tag: "relevant" }> = {
                  _tag: "relevant" as const,
                  query: selection.query,
                }
                if (selection.limit !== undefined) value = { ...value, limit: selection.limit }
                if (selection.cursor !== undefined)
                  value = {
                    ...value,
                    before: { ...selection.cursor, turnId: Turn.TurnId.make(selection.cursor.turnId) },
                  }
                return value
              })()
              let request: Parameters<typeof query.read>[0] = { threadId: input.threadId, selector }
              if (input.includeArchived !== undefined) request = { ...request, includeArchived: input.includeArchived }
              return query.read(request).pipe(
                Effect.map((result) => ({
                  text: JSON.stringify(publicReadResult(result)),
                  truncated: result.truncated,
                })),
              )
            }),
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
