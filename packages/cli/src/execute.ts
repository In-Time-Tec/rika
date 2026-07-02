import { AgentLoop, WorkspaceIdentity } from "@rika/agent"
import { Config, Diagnostics, IdGenerator } from "@rika/core"
import { Database, ProjectStore } from "@rika/persistence"
import { Codec, Event, Ids } from "@rika/schema"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { basename } from "node:path"
import * as Args from "./args"
import * as Output from "./output"
import * as Project from "./project"

export class ExecuteError extends Schema.TaggedErrorClass<ExecuteError>()("ExecuteError", {
  message: Schema.String,
  exit_code: Schema.Int,
}) {}

export interface Interface {
  readonly execute: (argv: ReadonlyArray<string>) => Effect.Effect<number>
  readonly executeCommand: (
    command: Args.ExecuteCommand,
  ) => Effect.Effect<number, AgentLoop.RunError | Database.DatabaseError | ProjectStore.ProjectStoreError>
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
    const diagnostics = yield* Diagnostics.Service
    const projects = yield* ProjectStore.Service

    const executeCommand = Effect.fn("Cli.Execute.executeCommand")(function* (command: Args.ExecuteCommand) {
      const threadId = command.thread_id ?? Ids.ThreadId.make(yield* idGenerator.next("thread"))
      const workspaceRoot = command.workspace_root ?? configValues.workspace_root
      const projectId = yield* Project.resolveCurrentProjectId(workspaceRoot).pipe(
        Effect.provideService(ProjectStore.Service, projects),
      )
      const workspaceId = WorkspaceIdentity.resolveWorkspaceId({
        workspace_root: workspaceRoot,
        ...(projectId === undefined ? {} : { project_id: projectId }),
      })
      const input: AgentLoop.RunTurnInput = {
        thread_id: threadId,
        workspace_id: workspaceId,
        content: command.prompt,
        ...(command.mode === undefined ? {} : { mode: command.mode }),
      }

      return yield* Diagnostics.event(
        "cli.execute",
        (fields) =>
          Effect.gen(function* () {
            fields.thread_id = threadId
            let toolCount = 0
            let turnCount = 0
            yield* agentLoop.streamTurn(input).pipe(
              Stream.runForEach((event) =>
                Effect.gen(function* () {
                  if (event.type === "tool.call.completed") toolCount += 1
                  if (event.type === "turn.completed") turnCount += 1
                  yield* output.stdout(encodeEvent(event))
                }),
              ),
            )
            fields.tool_count = toolCount
            fields.turn_count = turnCount
            fields.exit_code = 0
            return 0
          }),
        {
          mode: command.mode ?? configValues.default_mode,
          workspace_root: basename(workspaceRoot),
          ephemeral: command.ephemeral,
        },
      ).pipe(Effect.provideService(Diagnostics.Service, diagnostics))
    })

    return Service.of({
      execute: Effect.fn("Cli.Execute.execute")(function* (argv: ReadonlyArray<string>) {
        return yield* Args.parse(argv).pipe(
          Effect.flatMap(
            (
              command,
            ): Effect.Effect<
              number,
              AgentLoop.RunError | Database.DatabaseError | ProjectStore.ProjectStoreError | ExecuteError
            > =>
              command.type === "execute"
                ? executeCommand(command)
                : Effect.fail(new ExecuteError({ message: "Expected run or --execute", exit_code: 2 })),
          ),
          Effect.matchEffect({
            onFailure: (
              error:
                | Args.ArgsError
                | AgentLoop.RunError
                | Database.DatabaseError
                | ProjectStore.ProjectStoreError
                | ExecuteError,
            ) => output.stderr(formatError(error)).pipe(Effect.as(exitCode(error))),
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

export const formatError = (
  error: Args.ArgsError | AgentLoop.RunError | Database.DatabaseError | ProjectStore.ProjectStoreError | ExecuteError,
) => {
  if (error instanceof Args.ArgsError && error.usage !== undefined) return `${error.message}\n${error.usage}`
  if (error instanceof Args.ArgsError || error instanceof ExecuteError) return error.message
  if (error instanceof Error) return `Rika failed: ${error.message}`
  return `Rika failed: ${String(error)}`
}

const exitCode = (
  error: Args.ArgsError | AgentLoop.RunError | Database.DatabaseError | ProjectStore.ProjectStoreError | ExecuteError,
) => {
  if (error instanceof Args.ArgsError || error instanceof ExecuteError) return error.exit_code
  return 1
}
