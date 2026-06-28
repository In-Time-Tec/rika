import { ThreadService } from "@rika/agent"
import { Context, Effect, Layer, Schema } from "effect"
import * as Args from "./args"
import * as Output from "./output"

export class ThreadsError extends Schema.TaggedErrorClass<ThreadsError>()("ThreadsError", {
  message: Schema.String,
  action: Args.ThreadAction,
}) {}

export type RunError = ThreadService.Error | ThreadsError

export interface Interface {
  readonly executeCommand: (command: Args.ThreadCommand) => Effect.Effect<number, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/cli/Threads") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const output = yield* Output.Service
    const threads = yield* ThreadService.Service

    return Service.of({
      executeCommand: Effect.fn("Cli.Threads.executeCommand")(function* (command: Args.ThreadCommand) {
        switch (command.action) {
          case "list": {
            const summaries = yield* threads.list(listInput(command))
            yield* output.stdout(formatJson(summaries))
            return 0
          }
          case "search": {
            const results = yield* threads.search(searchInput(command))
            yield* output.stdout(formatJson(results))
            return 0
          }
          case "archive": {
            const summary = yield* threads.archive({ thread_id: yield* requireThreadId(command) })
            yield* output.stdout(formatJson(summary))
            return 0
          }
          case "unarchive": {
            const summary = yield* threads.unarchive({ thread_id: yield* requireThreadId(command) })
            yield* output.stdout(formatJson(summary))
            return 0
          }
          case "share": {
            const exported = yield* threads.share({ thread_id: yield* requireThreadId(command) })
            yield* output.stdout(formatJson(exported))
            return 0
          }
          case "reference": {
            const reference = yield* threads.reference({
              thread_id: yield* requireThreadId(command),
              ...(command.query === undefined ? {} : { query: command.query }),
            })
            yield* output.stdout(formatJson(reference))
            return 0
          }
          case "delete": {
            yield* threads.deleteThread({ thread_id: yield* requireThreadId(command) })
            return 0
          }
        }
        return yield* new ThreadsError({
          message: "Unsupported thread action",
          action: command.action,
        })
      }),
    })
  }),
)

export const executeCommand = Effect.fn("Cli.Threads.executeCommand.call")(function* (command: Args.ThreadCommand) {
  const service = yield* Service
  return yield* service.executeCommand(command)
})

export const formatError = (error: RunError) => {
  if (error instanceof ThreadsError) return error.message
  if (error instanceof Error) return `Rika failed: ${error.message}`
  return `Rika failed: ${String(error)}`
}

const requireThreadId = (command: Args.ThreadCommand) =>
  command.thread_id === undefined
    ? Effect.fail(new ThreadsError({ message: `Thread id is required for ${command.action}`, action: command.action }))
    : Effect.succeed(command.thread_id)

const listInput = (command: Args.ThreadCommand): ThreadService.ListInput => ({
  ...(command.include_archived === undefined ? {} : { include_archived: command.include_archived }),
  ...(command.limit === undefined ? {} : { limit: command.limit }),
})

const searchInput = (command: Args.ThreadCommand): ThreadService.SearchInput => ({
  ...(command.query === undefined ? {} : { query: command.query }),
  ...(command.include_archived === undefined ? {} : { include_archived: command.include_archived }),
  ...(command.limit === undefined ? {} : { limit: command.limit }),
})

const formatJson = (value: unknown) => JSON.stringify(value)
