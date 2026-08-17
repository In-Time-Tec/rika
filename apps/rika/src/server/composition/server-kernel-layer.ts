import { HostBindingRegistry, KernelStateStore, type KernelPool } from "@batonfx/repl"
import type { Options } from "./server-kernel-options"
import { discoverServers, discoverSkills, harnessStoreLayer, workspaceDigest } from "./server-kernel-harness"
import { NestedOperation, Session, ToolContext } from "@batonfx/core"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as CellCallContext from "@rika/baton-execution/baton-cell-call-context"
import * as ShellProcessRegistry from "@rika/coding-tools/shell-process-registry"
import * as McpRuntime from "@rika/extensions/mcp-runtime"
import * as SkillFileSystem from "@rika/extensions/skill-file-system"
import * as ArtifactStore from "@rika/kernel/artifact-store"
import * as KernelComposition from "@rika/kernel/kernel-composition"
import * as GoalService from "@rika/product/goal-service"
import { Effect, FileSystem, Function, Layer, Path, Scope } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"

export { workspaceDigest, harnessStoreLayer, effectiveHarness } from "./server-kernel-harness"
export type { Options } from "./server-kernel-options"

/** Every executable skill the Execution pins its identity to. */
/**
 * The services the mounted surface is closed over that are NOT per-call.
 *
 * ToolContext, NestedOperations, and Session are deliberately absent: they belong to one executing
 * cell and are supplied per request by `CellCallContext`, never captured here.
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
 * Placeholders for the three per-call services, present only so the surface can be MOUNTED.
 *
 * Every one of them is overridden per request by the context the executing cell captured, because
 * `HostBindingRegistry.invoke` now merges the per-call context over the build-time one. A binding
 * that reached these would be answering outside a cell, which `bindCalls` refuses instead.
 */
const mountingPlaceholders: Layer.Layer<
  ToolContext.ToolContext | NestedOperation.NestedOperations | Session.SessionStore
> = Layer.mergeAll(ToolContext.layerDefault, NestedOperation.layerDirect, Session.layerMemory)

/**
 * The Server-scoped kernel: one pool of Bun kernels, one per Session, plus the `rika.*` surface
 * every cell calls, answered under the identity of the cell that raised the request.
 */
export const layer = (
  options: Options,
): Layer.Layer<
  KernelPool.KernelPool | KernelStateStore.KernelStateStore | CellCallContext.CellCallContext,
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
      /**
       * A compiled executable has no file for the module the worker was built from, so the packaged
       * binaries ship one beside them. Reaching for it only when the resolved default is absent keeps
       * an ordinary install on the path its own package resolves.
       */
      const workerFileSystem = yield* FileSystem.FileSystem
      const workerPath = yield* Path.Path
      const shippedDirectory = workerPath.dirname(process.execPath)
      const packaged = !(yield* workerFileSystem
        .exists(KernelComposition.defaultWorkerModules.worker)
        .pipe(Effect.orDie))
      const binaries = KernelComposition.kernelBinaries({
        resolvedWorkerExists: !packaged,
        executableDirectory: shippedDirectory,
        join: (directory, name) => workerPath.join(directory, name),
      })
      const kernelOptions = {
        trustMode,
        ...binaries,
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
      /**
       * `KernelComposition.layer` merges the pool and the surface as siblings, and the pool reads
       * the registry out of its own build context, so a sibling registry is invisible to it and
       * every cell would find nothing mounted. Composing the two exported halves explicitly makes
       * the surface a DEPENDENCY of the pool, which is the only order in which a cell can call it.
       */
      const calls = CellCallContext.layer
      const registry = Layer.effect(
        HostBindingRegistry.HostBindingRegistry,
        Effect.map(
          Effect.all([HostBindingRegistry.HostBindingRegistry, CellCallContext.CellCallContext]),
          ([mounted, callContext]) => CellCallContext.bindCalls(mounted, callContext),
        ),
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            KernelComposition.bindings({ ...kernelOptions, trustMode }).pipe(
              Layer.provide(staticBindingServices(options)),
              Layer.provide(mountingPlaceholders),
              Layer.provide(BunServices.layer),
              Layer.orDie,
            ),
            calls,
          ),
        ),
      )
      const composed = KernelComposition.pool(kernelOptions).pipe(
        Layer.provide(registry),
        Layer.provide(BunServices.layer),
      )
      return Layer.mergeAll(composed, calls)
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
