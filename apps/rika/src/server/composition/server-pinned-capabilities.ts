import * as SkillFileSystem from "@rika/extensions/skill-file-system"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, Layer, Scope, SynchronizedRef } from "effect"
import * as ServerKernel from "./server-kernel-layer"
import * as ServerKernelHarness from "./server-kernel-harness"

/**
 * The harness one Execution is pinned to and the executable skills it may import, read once per
 * Server. A refinement a cell makes lands in the following Execution, which is exactly the boundary
 * the snapshot pin defines.
 */
export const pinnedCapabilities = (options: Parameters<typeof ServerKernel.effectiveHarness>[0]) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const provideScoped =
      <A, E, R>(layer: Layer.Layer<R>) =>
      (effect: Effect.Effect<A, E, R | Scope.Scope>): Effect.Effect<A, E, Scope.Scope> =>
        Effect.flatMap(Layer.buildWithScope(layer, scope), (context) => Effect.provide(effect, context))
    const harnessSnapshot = yield* ServerKernel.effectiveHarness(options, undefined).pipe(
      provideScoped(Layer.merge(ServerKernel.harnessStoreLayer(options), BunServices.layer)),
    )
    const skills = yield* ServerKernelHarness.discoverSkills(options).pipe(
      provideScoped(
        Layer.merge(SkillFileSystem.fileSystemLayer.pipe(Layer.provide(BunServices.layer)), BunServices.layer),
      ),
    )
    return { harnessSnapshot, skills }
  })

/**
 * The kernel worker pools, built on the Server's own scope. Baton builds a resolved Agent's
 * environment once per Run and a cell's scope ends with that cell, so a pool owned by either would
 * be released while later turns still needed it.
 *
 * One Server answers every workspace, and a kernel carries both the working directory its cells run
 * in and the root its `rika.workspace.*` surface is mounted on. A single Server-wide kernel made
 * those disagree with the Turn's own workspace for every Thread except whichever one happened to
 * start the Server, so the tools read one repository while the shell reached another. Keying by
 * workspace makes the two the same root by construction; a workspace that never runs a Turn never
 * builds a kernel.
 */
export const kernelPoolsFor = (
  options: Omit<Parameters<typeof ServerKernel.layer>[0], "workspace" | "toolRuntimeLayer"> & {
    readonly workspace: string
    readonly toolRuntimeLayer: (workspace: string) => Parameters<typeof ServerKernel.layer>[0]["toolRuntimeLayer"]
  },
) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    type PoolContext = Effect.Success<ReturnType<typeof ServerKernel.buildLayer>>
    const built = yield* SynchronizedRef.make(new Map<string, PoolContext>())

    const forWorkspace = (workspace: string) =>
      SynchronizedRef.modifyEffect(built, (current) => {
        const existing = current.get(workspace)
        if (existing !== undefined) return Effect.succeed([existing, current] as const)
        return ServerKernel.buildLayer(
          { ...options, workspace, toolRuntimeLayer: options.toolRuntimeLayer(workspace) },
          scope,
        ).pipe(Effect.map((context) => [context, new Map(current).set(workspace, context)] as const))
      })
    return {
      forWorkspace,
      built: SynchronizedRef.get(built).pipe(Effect.map((current) => [...current.values()])),
    }
  })
