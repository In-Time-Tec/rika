import { AgentLoop, ContextResolver, ToolExecutor } from "@rika/agent"
import { Config, IdGenerator, Time } from "@rika/core"
import { OpenAi, Provider, Router } from "@rika/llm"
import { Database, Migration, ThreadEventLog, ThreadProjection } from "@rika/persistence"
import { BuiltInTools, FffSearch } from "@rika/tools"
import { Effect, Layer } from "effect"
import * as Args from "./args"
import * as Execute from "./execute"
import * as Output from "./output"

export interface ProcessInput {
  readonly argv: ReadonlyArray<string>
  readonly env: Record<string, string | undefined>
  readonly cwd: string
}

export const runProcess: (input: ProcessInput) => Effect.Effect<number, never, Output.Service> = Effect.fn(
  "Cli.Runtime.runProcess",
)((input) =>
  Args.parse(input.argv).pipe(
    Effect.matchEffect({
      onFailure: (error: Args.ArgsError) => Output.stderr(Execute.formatError(error)).pipe(Effect.as(error.exit_code)),
      onSuccess: (command) =>
        Execute.executeCommand(command).pipe(
          Effect.provide(liveLayer(command, input.env, input.cwd)),
          Effect.matchEffect({
            onFailure: (error: RuntimeError) => Output.stderr(formatRuntimeError(error)).pipe(Effect.as(1)),
            onSuccess: (code) => Effect.succeed(code),
          }),
        ),
    }),
  ),
)

type RuntimeError =
  | AgentLoop.RunError
  | ContextResolver.ContextResolverError
  | Config.ConfigError
  | Database.DatabaseError
  | Execute.ExecuteError
  | FffSearch.FffSearchError
  | Migration.MigrationError

const formatRuntimeError = (error: RuntimeError) => {
  if (error instanceof Migration.MigrationError) return `Rika failed: ${error.message}`
  if (error instanceof FffSearch.FffSearchError) return `Rika failed: ${error.message}`
  if (error instanceof ContextResolver.ContextResolverError) return `Rika failed: ${error.message}`
  if (error instanceof Config.ConfigError) return `Rika failed: ${error.message}`
  if (error instanceof Database.DatabaseError) return `Rika failed: ${error.message}`
  return Execute.formatError(error)
}

export const liveLayer = (
  command: Args.ExecuteCommand,
  env: Record<string, string | undefined>,
  cwd: string,
): Layer.Layer<LiveLayerOutput, LiveLayerError> => {
  const workspaceRoot = command.workspace_root ?? env.RIKA_WORKSPACE_ROOT ?? cwd
  const dataDir = env.RIKA_DATA_DIR ?? `${workspaceRoot}/.rika`
  const configLayer = Config.layerFromValues(
    {
      workspace_root: workspaceRoot,
      data_dir: dataDir,
      default_mode: command.mode ?? "smart",
      ...(env.RIKA_DATABASE_URL === undefined ? {} : { database_url: env.RIKA_DATABASE_URL }),
    },
    env,
  )
  const databaseLayer = command.ephemeral ? Database.memoryLayer : Database.layer.pipe(Layer.provideMerge(configLayer))
  const llmLayer = Router.layer.pipe(Layer.provideMerge(OpenAi.layer()), Layer.provideMerge(configLayer))
  const toolLayer = BuiltInTools.toolExecutorLayer.pipe(Layer.provideMerge(configLayer))
  const contextResolverLayer = ContextResolver.layer.pipe(Layer.provideMerge(configLayer))
  const baseLayer = Layer.mergeAll(
    configLayer,
    Output.layer,
    databaseLayer,
    Migration.layer,
    ThreadEventLog.layer,
    ThreadProjection.layer,
    Time.layer,
    IdGenerator.layer,
    contextResolverLayer,
    toolLayer,
    llmLayer,
  )

  return Execute.layer.pipe(
    Layer.provideMerge(AgentLoop.layer.pipe(Layer.provideMerge(baseLayer))),
    Layer.provideMerge(Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(baseLayer))),
  )
}

export type LiveLayerOutput =
  | AgentLoop.Service
  | Config.Service
  | ContextResolver.Service
  | Database.Service
  | Execute.Service
  | IdGenerator.Service
  | Migration.Service
  | Output.Service
  | Provider.Service
  | Router.Service
  | ThreadEventLog.Service
  | ThreadProjection.Service
  | Time.Service
  | ToolExecutor.Service

export type LiveLayerError =
  | Config.ConfigError
  | ContextResolver.ContextResolverError
  | Database.DatabaseError
  | FffSearch.FffSearchError
  | Migration.MigrationError
