import * as Execution from "@rika/execution"
import type { LaneModels } from "@rika/execution/test-harness"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import { Context, Effect } from "effect"

export interface BackendOptions {
  readonly registryLayer: LaneModels["registryLayer"]
}

export const backendLayer = (options: BackendOptions) =>
  Execution.layerMemory({
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
