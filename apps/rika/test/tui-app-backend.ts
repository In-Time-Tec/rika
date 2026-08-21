import * as Execution from "@rika/execution"
import type { LaneModels } from "@rika/execution/test-harness"
import * as ToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ThreadQuery from "@rika/product/thread-query-service"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Context, Effect, Layer } from "effect"
import * as GoalRepository from "@rika/product/goal-repository"
import * as Kernel from "./kernel-layer"

export interface BackendOptions {
  readonly filename: string
  readonly kernelPool: Execution.LocalCellsOptions
  readonly registryLayer: LaneModels["registryLayer"]
  readonly toolRuntimeLayer: Layer.Layer<ToolRuntime.Service>
  readonly queryFactoryLayer: Layer.Layer<ThreadQuery.Factory>
}

const kernelOptions = (options: {
  readonly workspace: string
  readonly dataRoot: string
  readonly queryFactoryLayer: Layer.Layer<ThreadQuery.Factory>
  readonly toolRuntimeLayer: Layer.Layer<ToolRuntime.Service>
}): Kernel.Options => ({
  workspace: options.workspace,
  home: options.dataRoot,
  dataRoot: options.dataRoot,
  runtimeVersion: Bun.version,
  goalRepositoryLayer: GoalRepository.memoryLayer,
  queryFactory: options.queryFactoryLayer,
  toolRuntimeLayer: options.toolRuntimeLayer,
})

/**
 * The interactive stack under test is the real one, so it needs the real kernel: the model's only
 * tool is a cell, and a backend without a pool answers every call with a framework failure rather
 * than running anything.
 */
/**
 * One pool for the whole interactive session, owned by the caller's scope. A pool built inside a
 * cell would be released when that cell ends, leaving every later cell holding a closed kernel map.
 */
export const kernelPoolFor = (options: {
  readonly workspace: string
  readonly dataRoot: string
  readonly queryFactoryLayer: Layer.Layer<ThreadQuery.Factory>
  readonly toolRuntimeLayer: Layer.Layer<ToolRuntime.Service>
}) =>
  Layer.build(Kernel.layer(kernelOptions(options)).pipe(Layer.provide(BunServices.layer))).pipe(
    Effect.map((context) => ({ forWorkspace: () => Effect.succeed(context), built: Effect.succeed([context]) })),
  )

export const backendLayer = (options: BackendOptions) =>
  Execution.layerLocal({
    filename: options.filename,
    cells: Execution.localCells(options.kernelPool),

    modelServices: options.registryLayer,
  })

export interface RuntimeStatePreparationInput {
  readonly workspace: string
  readonly backend: ExecutionGateway.Interface
  readonly threads: ThreadRepository.Interface
  readonly turns: TurnRepository.Interface
  readonly waitModelRequests: (count: number) => Effect.Effect<void>
}

export type RuntimeStatePreparation = (input: RuntimeStatePreparationInput) => Effect.Effect<void, Error>

export const prepareTuiRuntimeState = <ExecutionServices, RepositoryServices>(input: {
  readonly preparation: RuntimeStatePreparation | undefined
  readonly workspace: string
  readonly executionBackendContext: Context.Context<ExecutionGateway.Service | ExecutionServices>
  readonly repositoryContext: Context.Context<ThreadRepository.Service | TurnRepository.Service | RepositoryServices>
  readonly waitModelRequests: (count: number) => Effect.Effect<void>
}) =>
  input.preparation?.({
    workspace: input.workspace,
    backend: Context.get(input.executionBackendContext, ExecutionGateway.Service),
    threads: Context.get(input.repositoryContext, ThreadRepository.Service),
    turns: Context.get(input.repositoryContext, TurnRepository.Service),
    waitModelRequests: input.waitModelRequests,
  }) ?? Effect.void
