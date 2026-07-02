import { AgentLoop, WorkspaceIdentity } from "@rika/agent"
import { Config, Diagnostics, IdGenerator } from "@rika/core"
import { Database, ProjectStore } from "@rika/persistence"
import { Codec, Event, Ids, Message } from "@rika/schema"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { basename } from "node:path"
import * as Args from "./args"
import * as Input from "./input"
import * as Output from "./output"
import * as Project from "./project"

export class ExecuteError extends Schema.TaggedErrorClass<ExecuteError>()("ExecuteError", {
  message: Schema.String,
  exit_code: Schema.Int,
}) {}

const StreamJsonInputMessage = Schema.Struct({
  type: Schema.Literal("user"),
  message: Schema.Struct({
    role: Schema.Literal("user"),
    content: Schema.Array(Message.TextPart),
  }),
}).annotate({ identifier: "Rika.Cli.Execute.StreamJsonInputMessage" })

interface StreamJsonInputMessage extends Schema.Schema.Type<typeof StreamJsonInputMessage> {}

export interface Interface {
  readonly execute: (argv: ReadonlyArray<string>) => Effect.Effect<number>
  readonly executeCommand: (
    command: Args.ExecuteCommand,
  ) => Effect.Effect<
    number,
    AgentLoop.RunError | Database.DatabaseError | ProjectStore.ProjectStoreError | ExecuteError
  >
}

export class Service extends Context.Service<Service, Interface>()("@rika/cli/Execute") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const output = yield* Output.Service
    const inputService = yield* Input.Service
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
      const isTty = yield* inputService.isTty
      const stdin = !command.stream_json_input && !isTty ? yield* inputService.readAll : ""

      return yield* Diagnostics.event(
        "cli.execute",
        (fields) =>
          Effect.gen(function* () {
            fields.thread_id = threadId
            let toolCount = 0
            let turnCount = 0
            let failed = false
            const runInput = (turnInput: AgentLoop.RunTurnInput) =>
              agentLoop.streamTurn(turnInput).pipe(
                Stream.runForEach((event) =>
                  Effect.gen(function* () {
                    if (event.type === "tool.call.completed") toolCount += 1
                    if (event.type === "turn.completed") turnCount += 1
                    if (event.type === "turn.failed") failed = true
                    yield* output.stdout(encodeEvent(event))
                  }),
                ),
              )

            if (command.stream_json_input) {
              yield* inputService.lines.pipe(
                Stream.map((line) => line.trim()),
                Stream.filter((line) => line.length > 0),
                Stream.mapEffect(parseStreamJsonInputLine),
                Stream.mapError((error) =>
                  error instanceof ExecuteError
                    ? error
                    : new ExecuteError({
                        message: `Failed to read --stream-json-input: ${error.message}`,
                        exit_code: 2,
                      }),
                ),
                Stream.runForEach((message) =>
                  runInput({
                    thread_id: threadId,
                    workspace_id: workspaceId,
                    content: Message.displayText({ content: message.message.content }),
                    content_parts: message.message.content,
                    ...(command.mode === undefined ? {} : { mode: command.mode }),
                  }),
                ),
              )
            } else {
              const content = promptFromSources(stdin, command.prompt)
              if (content.length === 0) {
                return yield* new ExecuteError({ message: "Prompt is required for --execute", exit_code: 2 })
              }
              yield* runInput({
                thread_id: threadId,
                workspace_id: workspaceId,
                content,
                ...(command.mode === undefined ? {} : { mode: command.mode }),
              })
            }

            fields.tool_count = toolCount
            fields.turn_count = turnCount
            fields.exit_code = failed ? 1 : 0
            return failed ? 1 : 0
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

const promptFromSources = (stdin: string, prompt: string) => {
  const stdinPrompt = stdin.trimEnd()
  const argPrompt = prompt.trim()
  if (stdinPrompt.length > 0 && argPrompt.length > 0) return `${stdinPrompt}\n\n${argPrompt}`
  return stdinPrompt.length > 0 ? stdinPrompt : argPrompt
}

const parseStreamJsonInputLine = (line: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(StreamJsonInputMessage)(JSON.parse(line)),
    catch: (cause) =>
      new ExecuteError({
        message: `Invalid --stream-json-input line: ${cause instanceof Error ? cause.message : String(cause)}`,
        exit_code: 2,
      }),
  })

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
