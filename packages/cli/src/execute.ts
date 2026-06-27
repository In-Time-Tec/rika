import { AgentLoop } from "@rika/agent"
import { Config, IdGenerator } from "@rika/core"
import { Codec, Event, Ids } from "@rika/schema"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import * as Args from "./args"
import * as Output from "./output"

export class ExecuteError extends Schema.TaggedErrorClass<ExecuteError>()("ExecuteError", {
  message: Schema.String,
  exit_code: Schema.Int,
}) {}

export interface Interface {
  readonly execute: (argv: ReadonlyArray<string>) => Effect.Effect<number>
  readonly executeCommand: (command: Args.ExecuteCommand) => Effect.Effect<number, AgentLoop.RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/cli/Execute") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const output = yield* Output.Service
    const agentLoop = yield* AgentLoop.Service
    const config = yield* Config.Service
    const configValues = yield* config.get
    const idGenerator = yield* IdGenerator.Service

    const executeCommand = Effect.fn("Cli.Execute.executeCommand")(function* (command: Args.ExecuteCommand) {
      const threadId = command.thread_id ?? Ids.ThreadId.make(yield* idGenerator.next("thread"))
      const workspaceId = Ids.WorkspaceId.make(command.workspace_root ?? configValues.workspace_root)
      const input: AgentLoop.RunTurnInput = {
        thread_id: threadId,
        workspace_id: workspaceId,
        content: command.prompt,
        ...(command.mode === undefined ? {} : { mode: command.mode }),
      }

      yield* agentLoop.streamTurn(input).pipe(Stream.runForEach((event) => output.stdout(encodeEvent(event))))
      return 0
    })

    return Service.of({
      execute: Effect.fn("Cli.Execute.execute")(function* (argv: ReadonlyArray<string>) {
        return yield* Args.parse(argv).pipe(
          Effect.flatMap(
            (command): Effect.Effect<number, AgentLoop.RunError | ExecuteError> =>
              command.type === "execute"
                ? executeCommand(command)
                : Effect.fail(new ExecuteError({ message: "Expected run or --execute", exit_code: 2 })),
          ),
          Effect.matchEffect({
            onFailure: (error: Args.ArgsError | AgentLoop.RunError | ExecuteError) =>
              output.stderr(formatError(error)).pipe(Effect.as(exitCode(error))),
            onSuccess: (code) => Effect.succeed(code),
          }),
        )
      }),
      executeCommand,
    })
  }),
)

export const execute = Effect.fn("Cli.Execute.execute.call")(function* (argv: ReadonlyArray<string>) {
  const service = yield* Service
  return yield* service.execute(argv)
})

export const executeCommand = Effect.fn("Cli.Execute.executeCommand.call")(function* (command: Args.ExecuteCommand) {
  const service = yield* Service
  return yield* service.executeCommand(command)
})

export const encodeEvent = (event: Event.Event) => JSON.stringify(Codec.encode(Event.Event)(event))

export const formatError = (error: Args.ArgsError | AgentLoop.RunError | ExecuteError) => {
  if (error instanceof Args.ArgsError && error.usage !== undefined) return `${error.message}\n${error.usage}`
  if (error instanceof Args.ArgsError || error instanceof ExecuteError) return error.message
  if (error instanceof Error) return `Rika failed: ${error.message}`
  return `Rika failed: ${String(error)}`
}

const exitCode = (error: Args.ArgsError | AgentLoop.RunError | ExecuteError) => {
  if (error instanceof Args.ArgsError || error instanceof ExecuteError) return error.exit_code
  return 1
}
