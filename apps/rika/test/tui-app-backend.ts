import * as BatonExecution from "@rika/baton-execution/baton-execution"
import type { LaneModels } from "@rika/baton-execution/baton-test-harness"
import { Catalog as CodingToolCatalog } from "@rika/coding-tools/coding-tool-catalog"
import * as ToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as ThreadQuery from "@rika/product/thread-query-service"
import * as ThreadToolAction from "@rika/product/thread-tool-action"
import { Layer } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import * as GoalRepository from "@rika/product/goal-repository"
import * as ServerKernel from "../src/server/composition/server-kernel-layer"

export interface BackendOptions {
  readonly filename: string
  readonly workspace: string
  readonly dataRoot: string
  readonly registryLayer: LaneModels["registryLayer"]
  readonly toolRuntimeLayer: Layer.Layer<ToolRuntime.Service>
  readonly queryFactoryLayer: Layer.Layer<ThreadQuery.Factory>
}

const kernelOptions = (options: BackendOptions): ServerKernel.Options => ({
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
const kernelPool = (options: BackendOptions): Layer.Layer<BatonExecution.KernelPoolServices> =>
  ServerKernel.layer(kernelOptions(options)).pipe(Layer.provide(ChildProcessSpawner.layer))

export const backendLayer = (options: BackendOptions) =>
  BatonExecution.layer({
    filename: options.filename,
    kernelPool: kernelPool(options),

    modelServices: options.registryLayer,
    agentServices: (workspace) =>
      Layer.mergeAll(
        CodingToolCatalog.handlerLayer.pipe(Layer.provide(options.toolRuntimeLayer)),
        ThreadToolAction.handlerLayerForWorkspace(workspace).pipe(Layer.provide(options.queryFactoryLayer)),
        ThreadToolAction.findHandlerLayerForWorkspace(workspace).pipe(Layer.provide(options.queryFactoryLayer)),
      ) as Layer.Layer<BatonExecution.AgentToolServices>,
  })
