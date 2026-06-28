import { Client } from "@rika/sdk"
import { Context, Effect, Layer, Schema } from "effect"
import * as Args from "./args"
import * as Output from "./output"

export const defaultServerUrl = "http://127.0.0.1:4587"

export class IdeError extends Schema.TaggedErrorClass<IdeError>()("IdeError", {
  message: Schema.String,
  action: Args.IdeAction,
}) {}

export type RunError = Client.SdkError | IdeError

export interface Interface {
  readonly executeCommand: (command: Args.IdeCommand) => Effect.Effect<number, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/cli/Ide") {}

export const layer = layerFromClientFactory((command) =>
  Client.make(
    Client.fetchTransport({
      base_url: command.server_url ?? defaultServerUrl,
      ...(command.token === undefined ? {} : { token: command.token }),
    }),
  ),
)

export const layerFromClient = (client: Client.Interface): Layer.Layer<Service, never, Output.Service> =>
  layerFromClientFactory(() => client)

export function layerFromClientFactory(
  clientForCommand: (command: Args.IdeCommand) => Client.Interface,
): Layer.Layer<Service, never, Output.Service> {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const output = yield* Output.Service
      return makeService(output, clientForCommand)
    }),
  )
}

export const executeCommand = Effect.fn("Cli.Ide.executeCommand.call")(function* (command: Args.IdeCommand) {
  const service = yield* Service
  return yield* service.executeCommand(command)
})

export const formatError = (error: RunError) => {
  if (error instanceof IdeError) return error.message
  if (error instanceof Client.SdkError) return `Rika failed: ${error.message}`
  return `Rika failed: ${String(error)}`
}

const makeService = (
  output: Output.Interface,
  clientForCommand: (command: Args.IdeCommand) => Client.Interface,
): Interface =>
  Service.of({
    executeCommand: Effect.fn("Cli.Ide.executeCommand")(function* (command: Args.IdeCommand) {
      const client = clientForCommand(command)
      switch (command.action) {
        case "status": {
          const status = yield* client.ideStatus()
          yield* output.stdout(formatJson(status))
          return 0
        }
        case "connect": {
          const clientId = yield* requireClientId(command)
          const response = yield* client.connectIde({
            client_id: clientId,
            workspace_roots: command.workspace_roots ?? [],
            capabilities: command.capabilities ?? ["active-context", "diagnostics", "navigation"],
            ...(command.name === undefined ? {} : { name: command.name }),
            ...(command.initial_context === undefined ? {} : { initial_context: command.initial_context }),
          })
          yield* output.stdout(formatJson(response))
          return 0
        }
        case "disconnect": {
          const status = yield* client.disconnectIde({ client_id: yield* requireClientId(command) })
          yield* output.stdout(formatJson(status))
          return 0
        }
        case "open-file": {
          const result = yield* client.openIdeFile(yield* requireOpenFile(command))
          yield* output.stdout(formatJson(result))
          return 0
        }
      }
      return yield* new IdeError({ message: "Unsupported IDE action", action: command.action })
    }),
  })

const requireClientId = (command: Args.IdeCommand) =>
  command.client_id === undefined
    ? Effect.fail(new IdeError({ message: `IDE client id is required for ${command.action}`, action: command.action }))
    : Effect.succeed(command.client_id)

const requireOpenFile = (command: Args.IdeCommand) =>
  command.open_file === undefined
    ? Effect.fail(new IdeError({ message: "File path is required for open-file", action: command.action }))
    : Effect.succeed(command.open_file)

const formatJson = (value: unknown) => JSON.stringify(value)
