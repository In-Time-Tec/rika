import { HttpServer } from "@rika/server"
import { Context, Effect, Layer, Schema } from "effect"
import * as Args from "./args"
import * as Output from "./output"

export class ServerError extends Schema.TaggedErrorClass<ServerError>()("ServerError", {
  message: Schema.String,
}) {}

export type RunError = HttpServer.HttpServerError | ServerError

export interface Interface {
  readonly executeCommand: (command: Args.ServerCommand) => Effect.Effect<number, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/cli/Server") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const output = yield* Output.Service
    const httpServer = yield* HttpServer.Service

    return Service.of({
      executeCommand: Effect.fn("Cli.Server.executeCommand")(function* (command: Args.ServerCommand) {
        const handle = yield* httpServer.serve({
          ...(command.host === undefined ? {} : { host: command.host }),
          ...(command.port === undefined ? {} : { port: command.port }),
          ...(command.token === undefined ? {} : { token: command.token }),
        })
        yield* output.stdout(JSON.stringify({ url: handle.url }))
        return yield* Effect.never.pipe(Effect.ensuring(handle.close()))
      }),
    })
  }),
)

export const executeCommand = Effect.fn("Cli.Server.executeCommand.call")(function* (command: Args.ServerCommand) {
  const service = yield* Service
  return yield* service.executeCommand(command)
})

export const formatError = (error: RunError) => {
  if (error instanceof Error) return `Rika failed: ${error.message}`
  return `Rika failed: ${String(error)}`
}
