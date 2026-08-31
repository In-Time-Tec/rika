import { KernelStateStore, type KernelPool } from "tenetkit/repl"
import type { Options } from "./kernel-options.fixture"
import { discoverServers, discoverSkills, harnessStoreLayer, workspaceDigest } from "./kernel.harness"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as ShellProcessRegistry from "@rika/coding-tools/shell-process-registry"
import * as McpRuntime from "@rika/extensions/mcp-runtime"
import * as SkillFileSystem from "@rika/extensions/skill-file-system"
import * as ArtifactStore from "@rika/kernel/artifact-store"
import * as ExecutorRuntime from "@rika/kernel/executor-runtime"
import * as GoalService from "@rika/product/goal-service"
import { Effect, Function, Layer, Scope } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"

export { workspaceDigest, harnessStoreLayer, effectiveHarness } from "./kernel.harness"
export type { Options } from "./kernel-options.fixture"

/** Every executable skill the Execution pins its identity to. */
/**
 * The services the mounted surface is closed over that are NOT per-call.
 *
 * ToolContext, Operations, and Session are deliberately absent: they belong to one executing
 * cell and are supplied per request by `CellContext`, never captured here.
 */
const staticBindingServices = (options: Options) => {
  const artifacts = ArtifactStore.layer(options.dataRoot)
  return Layer.mergeAll(
    options.toolRuntimeLayer,
    ShellProcessRegistry.layer,
    options.queryFactory,
    McpRuntime.layer,
    harnessStoreLayer(options),
    GoalService.layer.pipe(Layer.provide(options.goalRepositoryLayer)),
    artifacts,
  ).pipe(Layer.provide(SkillFileSystem.fileSystemLayer), Layer.provide(BunServices.layer))
}

/**
 * The Server-scoped kernel: one pool of Bun kernels, one per Session, plus the `rika.*` surface
 * every cell calls, answered under the identity of the cell that raised the request.
 */
export const layer = (
  options: Options,
): Layer.Layer<
  KernelPool.KernelPool | KernelStateStore.KernelStateStore | ExecutorRuntime.CellContext,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const digest = yield* workspaceDigest(options.workspace)
      const servers = yield* discoverServers(options)
      const skills = yield* discoverSkills(options)
      /**
       * The kernel is a lifecycle boundary, not a sandbox: it runs with the Server user's
       * authority. This is the same value `kernel-profile-registration` defaults to, named
       * explicitly here so the mounted surface and the pinned profile can never disagree.
       */
      const trustMode = "trusted-local" as const
      const kernelOptions = {
        trustMode,
        workspace: options.workspace,
        workspaceDigest: digest,
        dataRoot: options.dataRoot,
        runtimeVersion: options.runtimeVersion,
        servers,
        skills: skills.map((skill) => ({
          name: skill.name,
          importName: skill.importName ?? skill.name,
          digest: skill.digest,
          importable: true,
        })),
      }
      return ExecutorRuntime.layer({
        ...kernelOptions,
        bindingServices: staticBindingServices(options),
      }).pipe(Layer.provide(BunServices.layer))
    }),
  ).pipe(Layer.provide(SkillFileSystem.fileSystemLayer), Layer.provide(BunServices.layer))

/**
 * One kernel context, built on a caller-owned scope. The Server keys these by workspace, so the
 * type of a built pool is named here rather than restated where the map that holds them is made.
 */
export const buildLayer: {
  (scope: Scope.Scope): (options: Options) => ReturnType<typeof buildLayerImpl>
  (options: Options, scope: Scope.Scope): ReturnType<typeof buildLayerImpl>
} = Function.dual(2, (options: Options, scope: Scope.Scope) => buildLayerImpl(options, scope))

const buildLayerImpl = (options: Options, scope: Scope.Scope) =>
  Layer.buildWithScope(layer(options).pipe(Layer.provide(BunServices.layer)), scope)
