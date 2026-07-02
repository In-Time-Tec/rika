import { Config, IdGenerator } from "@rika/core"
import { OrbManager } from "@rika/orb"
import { Database, OrbStore, ProjectStore } from "@rika/persistence"
import { Client } from "@rika/sdk"
import { Ids, Orb } from "@rika/schema"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import * as Args from "./args"
import * as Execute from "./execute"
import * as Output from "./output"
import * as Project from "./project"

export class OrbExecuteError extends Schema.TaggedErrorClass<OrbExecuteError>()("OrbExecuteError", {
  message: Schema.String,
  exit_code: Schema.Int,
}) {}

export type RunError =
  | Client.SdkError
  | Database.DatabaseError
  | OrbExecuteError
  | OrbManager.OrbProvisionError
  | OrbStore.OrbStoreError
  | ProjectStore.ProjectStoreError

export interface Interface {
  readonly execute: (argv: ReadonlyArray<string>) => Effect.Effect<number>
  readonly executeCommand: (command: Args.ExecuteCommand) => Effect.Effect<number, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/cli/OrbExecute") {}

export type ClientFactory = (threadId: Ids.ThreadId, endpointUrl: string, token: string) => Client.Interface

export const layerWithFetch = (fetch?: Client.FetchTransportInput["fetch"]) =>
  layerWithClientFactory((_threadId, endpointUrl, token) =>
    Client.make(
      Client.fetchTransport({
        base_url: endpointUrl,
        token,
        ...(fetch === undefined ? {} : { fetch }),
      }),
    ),
  )

export const layerWithClientFactory = (clientFactory: ClientFactory) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const output = yield* Output.Service
      const config = yield* Config.Service
      const configValues = yield* config.get
      const idGenerator = yield* IdGenerator.Service
      const projects = yield* ProjectStore.Service
      const orbs = yield* OrbStore.Service
      const manager = yield* OrbManager.Service

      const executeCommand = Effect.fn("Cli.OrbExecute.executeCommand")(function* (command: Args.ExecuteCommand) {
        if (!command.orb) {
          return yield* new OrbExecuteError({ message: "Expected --orb execute command", exit_code: 2 })
        }
        if (command.ephemeral) {
          return yield* new OrbExecuteError({ message: "orb execute does not support --ephemeral", exit_code: 2 })
        }
        if (command.stream_json_input) {
          return yield* new OrbExecuteError({
            message: "orb execute does not support --stream-json-input yet",
            exit_code: 2,
          })
        }

        const content = command.prompt.trim()
        if (content.length === 0) {
          return yield* new OrbExecuteError({ message: "Prompt is required for --execute", exit_code: 2 })
        }

        const workspaceRoot = command.workspace_root ?? configValues.workspace_root
        const project = yield* resolveProject(projects, command, workspaceRoot)
        const threadId = command.thread_id ?? Ids.ThreadId.make(yield* idGenerator.next("thread"))

        yield* output.stderr("provisioning orb...")
        yield* output.stderr("running .agents/setup...")
        const orb = yield* manager.provisionForThread({
          thread_id: threadId,
          project_id: project.project_id,
          workspace_root: workspaceRoot,
        })
        const endpoint = yield* endpointCredentials(orbs, orb)
        yield* output.stderr(`orb ready: ${endpoint.endpoint_url}`)

        const client = clientFactory(threadId, endpoint.endpoint_url, endpoint.token)
        yield* client.createThread({ thread_id: threadId, project_id: project.project_id })
        yield* client.startTurn({
          thread_id: threadId,
          project_id: project.project_id,
          content,
          ...(command.mode === undefined ? {} : { mode: command.mode }),
        })

        let terminal: "completed" | "failed" | undefined
        yield* client.subscribeThreadEvents({ thread_id: threadId }).pipe(
          Stream.takeUntil((event) => event.type === "turn.completed" || event.type === "turn.failed"),
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (event.type === "turn.completed") terminal = "completed"
              if (event.type === "turn.failed") terminal = "failed"
              yield* output.stdout(Execute.encodeEvent(event))
            }),
          ),
        )

        if (terminal === undefined) {
          return yield* new OrbExecuteError({ message: "Orb event stream ended before turn completed", exit_code: 1 })
        }
        return terminal === "failed" ? 1 : 0
      })

      return Service.of({
        execute: Effect.fn("Cli.OrbExecute.execute")(function* (argv: ReadonlyArray<string>) {
          return yield* Args.parse(argv).pipe(
            Effect.flatMap((command) =>
              command.type === "execute"
                ? executeCommand(command)
                : Effect.fail(new OrbExecuteError({ message: "Expected --orb execute command", exit_code: 2 })),
            ),
            Effect.matchEffect({
              onFailure: (error: Args.ArgsError | RunError) =>
                output.stderr(formatError(error)).pipe(Effect.as(exitCode(error))),
              onSuccess: (code) => Effect.succeed(code),
            }),
          )
        }),
        executeCommand,
      })
    }),
  )

export const layer = layerWithFetch()

export const execute = Effect.fn("Cli.OrbExecute.execute.call")(function* (argv: ReadonlyArray<string>) {
  const service = yield* Service
  return yield* service.execute(argv)
})

export const executeCommand = Effect.fn("Cli.OrbExecute.executeCommand.call")(function* (command: Args.ExecuteCommand) {
  const service = yield* Service
  return yield* service.executeCommand(command)
})

export const formatError = (error: Args.ArgsError | RunError) => {
  if (error instanceof Args.ArgsError && error.usage !== undefined) return `${error.message}\n${error.usage}`
  if (error instanceof Args.ArgsError || error instanceof OrbExecuteError) return error.message
  if (error instanceof Error) return `Rika failed: ${error.message}`
  return `Rika failed: ${String(error)}`
}

const exitCode = (error: Args.ArgsError | RunError) => {
  if (error instanceof Args.ArgsError || error instanceof OrbExecuteError) return error.exit_code
  return 1
}

const resolveProject = Effect.fn("Cli.OrbExecute.resolveProject")(function* (
  projects: ProjectStore.Interface,
  command: Args.ExecuteCommand,
  workspaceRoot: string,
) {
  if (command.project_name !== undefined) {
    const project = yield* projects.getByName(command.project_name)
    if (project !== undefined) return project
    return yield* new OrbExecuteError({ message: `Project ${command.project_name} not found`, exit_code: 2 })
  }

  const origin = yield* Project.currentGitRemoteOrigin(workspaceRoot).pipe(Effect.option)
  if (Option.isSome(origin)) {
    const project = yield* projects.getByRepoOrigin(origin.value)
    if (project !== undefined) return project
  }

  return yield* new OrbExecuteError({
    message: "no project for this repo; run: rika project create <name> --repo <origin>",
    exit_code: 2,
  })
})

const endpointCredentials = Effect.fn("Cli.OrbExecute.endpointCredentials")(function* (
  orbs: OrbStore.Interface,
  orb: Orb.OrbRecord,
) {
  const endpoint = yield* orbs.endpointCredentials(orb.orb_id)
  if (endpoint === undefined) {
    return yield* new OrbExecuteError({ message: `Orb ${orb.orb_id} has no endpoint`, exit_code: 1 })
  }
  return endpoint
})
