import * as BatonExecution from "@rika/baton-execution/baton-execution"
import type { LaneModels } from "@rika/baton-execution/baton-test-harness"
import * as ToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as ThreadQuery from "@rika/product/thread-query-service"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Context, Layer } from "effect"
import * as GoalRepository from "@rika/product/goal-repository"
import * as ServerKernel from "../src/server/composition/server-kernel-layer"

export interface BackendOptions {
  readonly filename: string
  readonly kernelPool: Context.Context<BatonExecution.KernelPoolServices>
  readonly registryLayer: LaneModels["registryLayer"]
  readonly toolRuntimeLayer: Layer.Layer<ToolRuntime.Service>
  readonly queryFactoryLayer: Layer.Layer<ThreadQuery.Factory>
}

const kernelOptions = (options: {
  readonly workspace: string
  readonly dataRoot: string
  readonly queryFactoryLayer: Layer.Layer<ThreadQuery.Factory>
  readonly toolRuntimeLayer: Layer.Layer<ToolRuntime.Service>
}): ServerKernel.Options => ({
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
}) => Layer.build(ServerKernel.layer(kernelOptions(options)).pipe(Layer.provide(BunServices.layer)))

export const backendLayer = (options: BackendOptions) =>
  BatonExecution.layer({
    filename: options.filename,
    kernelPool: options.kernelPool,

    modelServices: options.registryLayer,
  })
