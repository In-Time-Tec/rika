import { ThreadTools } from "@rika/tools"
import { Effect } from "effect"
import { Service } from "./thread-query"

const error = (tool: string, cause: { readonly _tag: string }) =>
  ThreadTools.ToolError.make({ tool, message: JSON.stringify(cause) })

export const handlerLayer = ThreadTools.toolkit.toLayer(
  Effect.gen(function* () {
    const query = yield* Service
    return {
      find_thread: (input) => query.find(input).pipe(Effect.mapError((cause) => error("find_thread", cause))),
      read_thread: (input) => query.read(input).pipe(Effect.mapError((cause) => error("read_thread", cause))),
    }
  }),
)
