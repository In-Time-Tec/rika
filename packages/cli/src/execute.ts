import { AgentLoop, WorkspaceIdentity } from "@rika/agent"
import { Config, Diagnostics, IdGenerator } from "@rika/core"
import { Database, ProjectStore } from "@rika/persistence"
import { Client } from "@rika/sdk"
import { Codec, Event, Ids, Message } from "@rika/schema"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { basename } from "node:path"
import * as Args from "./args"
import * as BackendEndpoint from "./backend-endpoint"
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
  readonly executeCommand: (command: Args.ExecuteCommand) => Effect.Effect<number, RunError>
}

export type RunError =
  | AgentLoop.RunError
  | BackendEndpoint.ResolveError
  | Client.SdkError
  | Database.DatabaseError
  | ProjectStore.ProjectStoreError
  | ExecuteError

export class Service extends Context.Service<Service, Interface>()("@rika/cli/Execute") {}

export type ClientFactory = (endpoint: BackendEndpoint.BackendEndpoint) => Client.Interface

const defaultClientFactory: ClientFactory = (endpoint) =>
  Client.make(Client.fetchTransport({ base_url: endpoint.url, token: endpoint.token }))

interface Dependencies {
  readonly output: Output.Interface
  readonly inputService: Input.Interface
  readonly configValues: Config.Values
  readonly idGenerator: IdGenerator.Interface
  readonly diagnostics: Diagnostics.Interface
  readonly projects: ProjectStore.Interface
  readonly runInput: (
    command: Args.ExecuteCommand,
    threadId: Ids.ThreadId,
    workspaceRoot: string,
    turnInput: AgentLoop.RunTurnInput,
    observe: (event: Event.Event) => Effect.Effect<void>,
  ) => Effect.Effect<void, RunError>
}

const makeService = (dependencies: Dependencies): Interface => {
  const executeCommand: Interface["executeCommand"] = Effect.fn("Cli.Execute.executeCommand")(function* (
    command: Args.ExecuteCommand,
  ) {
    const threadId = command.thread_id ?? Ids.ThreadId.make(yield* dependencies.idGenerator.next("thread"))
    const workspaceRoot = command.workspace_root ?? dependencies.configValues.workspace_root
    const projectId = yield* Project.resolveCurrentProjectId(workspaceRoot).pipe(
      Effect.provideService(ProjectStore.Service, dependencies.projects),
    )
    const workspaceId = WorkspaceIdentity.resolveWorkspaceId({
      workspace_root: workspaceRoot,
      ...(projectId === undefined ? {} : { project_id: projectId }),
    })
    const isTty = yield* dependencies.inputService.isTty
    const stdin = !command.stream_json_input && !isTty ? yield* dependencies.inputService.readAll : ""

    return yield* Diagnostics.event(
      "cli.execute",
      (fields) =>
        Effect.gen(function* () {
          fields.thread_id = threadId
          let toolCount = 0
          let turnCount = 0
          let failed = false
          const runInput = (turnInput: AgentLoop.RunTurnInput): Effect.Effect<void, RunError> =>
            dependencies.runInput(command, threadId, workspaceRoot, turnInput, (event) =>
              observeEvent(event, {
                incrementToolCount: () => {
                  toolCount += 1
                },
                incrementTurnCount: () => {
                  turnCount += 1
                },
                markFailed: () => {
                  failed = true
                },
                output: dependencies.output,
              }),
            )

          if (command.stream_json_input) {
            yield* dependencies.inputService.lines.pipe(
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
        mode: command.mode ?? dependencies.configValues.default_mode,
        workspace_root: basename(workspaceRoot),
        ephemeral: command.ephemeral,
      },
    ).pipe(Effect.provideService(Diagnostics.Service, dependencies.diagnostics))
  })

  return Service.of({
    execute: Effect.fn("Cli.Execute.execute")(function* (argv: ReadonlyArray<string>) {
      return yield* Args.parse(argv).pipe(
        Effect.flatMap(
          (command): Effect.Effect<number, RunError> =>
            command.type === "execute"
              ? executeCommand(command)
              : Effect.fail(new ExecuteError({ message: "Expected run or --execute", exit_code: 2 })),
        ),
        Effect.matchEffect({
          onFailure: (error: Args.ArgsError | RunError) =>
            dependencies.output.stderr(formatError(error)).pipe(Effect.as(exitCode(error))),
          onSuccess: (code) => Effect.succeed(code),
        }),
      )
    }),
    executeCommand,
  })
}

const commonDependencies = Effect.gen(function* () {
  const output = yield* Output.Service
  const inputService = yield* Input.Service
  const config = yield* Config.Service
  const configValues = yield* config.get
  const idGenerator = yield* IdGenerator.Service
  const diagnostics = yield* Diagnostics.Service
  const projects = yield* ProjectStore.Service
  return { output, inputService, configValues, idGenerator, diagnostics, projects }
})

export const layerWithClientFactory = (clientFactory: ClientFactory = defaultClientFactory) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const dependencies = yield* commonDependencies
      const resolver = yield* BackendEndpoint.Resolver
      return makeService({
        ...dependencies,
        runInput: Effect.fn("Cli.Execute.runRemoteInput")(
          function* (command, threadId, workspaceRoot, turnInput, observe) {
            if (command.ephemeral) {
              return yield* new ExecuteError({
                message: "Ephemeral execute requires the in-process layer",
                exit_code: 2,
              })
            }
            const endpoint = yield* resolver.resolveEndpoint({
              thread_id: threadId,
              workspace_root: workspaceRoot,
              data_dir: dependencies.configValues.data_dir,
              mode: command.mode ?? dependencies.configValues.default_mode,
              env: {},
            })
            return yield* runRemoteInput(clientFactory(endpoint), turnInput, observe)
          },
        ),
      })
    }),
  )

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const dependencies = yield* commonDependencies
    const agentLoop = yield* AgentLoop.Service
    return makeService({
      ...dependencies,
      runInput: (_command, _threadId, _workspaceRoot, turnInput, observe) =>
        runLocalInput(agentLoop, turnInput, observe),
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

interface EventObserver {
  readonly incrementToolCount: () => void
  readonly incrementTurnCount: () => void
  readonly markFailed: () => void
  readonly output: Output.Interface
}

const observeEvent = (event: Event.Event, observer: EventObserver) =>
  Effect.gen(function* () {
    if (event.type === "tool.call.completed") observer.incrementToolCount()
    if (event.type === "turn.completed") observer.incrementTurnCount()
    if (event.type === "turn.failed") observer.markFailed()
    yield* observer.output.stdout(encodeEvent(event))
  })

const runLocalInput = (
  agentLoop: AgentLoop.Interface,
  turnInput: AgentLoop.RunTurnInput,
  observe: (event: Event.Event) => Effect.Effect<void>,
) => agentLoop.streamTurn(turnInput).pipe(Stream.runForEach(observe))

const runRemoteInput = (
  client: Client.Interface,
  turnInput: AgentLoop.RunTurnInput,
  observe: (event: Event.Event) => Effect.Effect<void>,
): Effect.Effect<void, Client.SdkError | ExecuteError> =>
  Effect.gen(function* () {
    const afterSequence = yield* ensureRemoteThread(client, turnInput)
    yield* client.startTurn({
      thread_id: turnInput.thread_id,
      workspace_id: turnInput.workspace_id,
      content: turnInput.content,
      ...(turnInput.content_parts === undefined ? {} : { content_parts: turnInput.content_parts }),
      ...(turnInput.user_id === undefined ? {} : { user_id: turnInput.user_id }),
      ...(turnInput.mode === undefined ? {} : { mode: turnInput.mode }),
      ...(turnInput.fast_mode === undefined ? {} : { fast_mode: turnInput.fast_mode }),
      ...(turnInput.cancelled === undefined ? {} : { cancelled: turnInput.cancelled }),
      ...(turnInput.ide_context === undefined ? {} : { ide_context: turnInput.ide_context }),
    })

    let terminal = false
    yield* client.subscribeThreadEvents({ thread_id: turnInput.thread_id, after_sequence: afterSequence }).pipe(
      Stream.takeUntil((event) => event.type === "turn.completed" || event.type === "turn.failed"),
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (event.type === "turn.completed" || event.type === "turn.failed") terminal = true
          yield* observe(event)
        }),
      ),
    )
    if (!terminal) {
      return yield* new ExecuteError({ message: "Remote event stream ended before turn completed", exit_code: 1 })
    }
    return undefined
  })

const ensureRemoteThread = (
  client: Client.Interface,
  turnInput: AgentLoop.RunTurnInput,
): Effect.Effect<number, Client.SdkError> =>
  client.openThread(turnInput.thread_id).pipe(
    Effect.map((record) => record.events.at(-1)?.sequence ?? 0),
    Effect.catchTag("SdkError", (error) =>
      error.status === 404
        ? client
            .createThread({ thread_id: turnInput.thread_id, workspace_id: turnInput.workspace_id })
            .pipe(Effect.as(0))
        : Effect.fail(error),
    ),
  )

export const formatError = (
  error:
    | Args.ArgsError
    | AgentLoop.RunError
    | BackendEndpoint.ResolveError
    | Client.SdkError
    | Database.DatabaseError
    | ProjectStore.ProjectStoreError
    | ExecuteError,
) => {
  if (error instanceof Args.ArgsError && error.usage !== undefined) return `${error.message}\n${error.usage}`
  if (error instanceof Args.ArgsError || error instanceof ExecuteError) return error.message
  if (error instanceof Error) return `Rika failed: ${error.message}`
  return `Rika failed: ${String(error)}`
}

const exitCode = (
  error:
    | Args.ArgsError
    | AgentLoop.RunError
    | BackendEndpoint.ResolveError
    | Client.SdkError
    | Database.DatabaseError
    | ProjectStore.ProjectStoreError
    | ExecuteError,
) => {
  if (error instanceof Args.ArgsError || error instanceof ExecuteError) return error.exit_code
  return 1
}
