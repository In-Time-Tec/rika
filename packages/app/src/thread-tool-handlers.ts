import { ThreadTools, ToolInvocation } from "@rika/tools"
import * as Turn from "@rika/persistence/turn"
import { Effect, Option } from "effect"
import * as ThreadQuery from "./thread-query"
import * as ThreadToolService from "./thread-tool-service"

const error = (tool: string, cause: { readonly _tag: string }) =>
  ThreadTools.ToolError.make({ tool, message: JSON.stringify(cause) })

const publicError = (tool: string, cause: { readonly _tag: string }) => ({
  _tag: "ThreadToolError" as const,
  tool,
  code: "operation" as const,
  message: JSON.stringify(cause).slice(0, 8_000),
  retryable: false,
})

export const handlerLayer = ThreadTools.toolkit.toLayer(
  Effect.gen(function* () {
    const query = yield* ThreadQuery.Service
    return {
      search_threads: (input) => query.search(input).pipe(Effect.mapError((cause) => error("search_threads", cause))),
      read_thread_transcript: (input) =>
        ("selection" in input
          ? query
              .readStructured({
                threadId: input.threadId,
                ...(input.includeArchived === undefined ? {} : { includeArchived: input.includeArchived }),
                selector: (() => {
                  const selection = input.selection
                  if (selection.mode === "overview") return { _tag: "overview" as const }
                  if (selection.mode === "related")
                    return {
                      _tag: "related" as const,
                      ...(selection.cursor === undefined
                        ? {}
                        : {
                            before: {
                              ...selection.cursor,
                              targetTurnId: Turn.TurnId.make(selection.cursor.targetTurnId),
                            },
                          }),
                    }
                  if (selection.mode === "subtree")
                    return {
                      _tag: "subtree" as const,
                      childExecutionId: selection.childExecutionId,
                      ...(selection.cursor === undefined
                        ? {}
                        : { before: { ...selection.cursor, turnId: Turn.TurnId.make(selection.cursor.turnId) } }),
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
              .pipe(Effect.map((result) => ({ text: JSON.stringify(result), truncated: result.truncated })))
          : query.read(input)
        ).pipe(Effect.mapError((cause) => error("read_thread_transcript", cause))),
    }
  }),
)

export const findHandlerLayer = ThreadTools.findToolkit.toLayer(
  Effect.gen(function* () {
    const query = yield* ThreadQuery.Service
    return {
      find_thread: (input) => query.find(input).pipe(Effect.mapError((cause) => publicError("find_thread", cause))),
    }
  }),
)

export const coordinationHandlerLayer = (gateway: ThreadToolService.Gateway) =>
  ThreadTools.coordinationToolkit.toLayer(
    Effect.succeed(
      (() => {
        const invocation = Effect.serviceOption(ToolInvocation.ToolInvocation).pipe(
          Effect.flatMap((value) =>
            Option.match(value, {
              onNone: () => Effect.fail({ _tag: "ToolInvocationUnavailable" } as const),
              onSome: Effect.succeed,
            }),
          ),
        )
        return {
          create_thread: (input) =>
            invocation.pipe(
              Effect.flatMap((value) => gateway.createThread(value, input)),
              Effect.mapError((cause) => publicError("create_thread", cause)),
            ),
          thread_interact: (input) =>
            invocation.pipe(
              Effect.flatMap((value) => gateway.interact(value, input)),
              Effect.mapError((cause) => publicError("thread_interact", cause)),
            ),
          wait_for_threads: (input) =>
            invocation.pipe(
              Effect.flatMap((value) => gateway.waitForThreads(value, input)),
              Effect.mapError((cause) => publicError("wait_for_threads", cause)),
            ),
        }
      })(),
    ),
  )
