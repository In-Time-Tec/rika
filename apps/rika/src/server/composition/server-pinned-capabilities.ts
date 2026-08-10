import * as SkillFileSystem from "@rika/extensions/skill-file-system"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, Layer, Scope } from "effect"
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
 * The kernel worker pool, built on the Server's own scope. Baton builds a resolved Agent's
 * environment once per Run and a cell's scope ends with that cell, so a pool owned by either would
 * be released while later turns still needed it.
 */
export const kernelPoolFor = (options: Parameters<typeof ServerKernel.layer>[0]) =>
  Layer.build(ServerKernel.layer(options).pipe(Layer.provide(BunServices.layer)))
