import { ThreadContract } from "@rika/product/thread-tool-contract"
import { Effect } from "effect"
import * as ThreadQuery from "../query/service"

const publicError = (tool: string, cause: { readonly _tag: string }) => ({
  _tag: "ThreadToolError" as const,
  tool,
  code: "operation" as const,
  message: JSON.stringify(cause).slice(0, 8_000),
  retryable: false,
})

export const findHandlerLayerForWorkspace = (workspace: string) =>
  ThreadContract.findToolkit.toLayer(
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

export const findHandlerLayer = ThreadContract.findToolkit.toLayer(
  Effect.gen(function* () {
    const query = yield* ThreadQuery.Service
    return {
      find_thread: (input) => query.find(input).pipe(Effect.mapError((cause) => publicError("find_thread", cause))),
    }
  }),
)
