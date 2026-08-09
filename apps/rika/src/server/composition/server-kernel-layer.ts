import { NestedOperation, Session, ToolContext } from "@batonfx/core"
import { HarnessStore } from "@batonfx/harness"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as CellCallContext from "@rika/baton-execution/baton-cell-call-context"
import * as ShellProcessRegistry from "@rika/coding-tools/shell-process-registry"
import { globalPaths, workspacePaths } from "@rika/configuration/configuration-paths"
import * as McpDiscovery from "@rika/extensions/mcp-discovery"
import * as McpRuntime from "@rika/extensions/mcp-runtime"
import * as SkillRegistry from "@rika/extensions/skill-registry"
import * as SkillFileSystem from "@rika/extensions/skill-file-system"
import * as ArtifactStore from "@rika/kernel/artifact-store"
import * as ExecutionPins from "@rika/kernel/execution-pins"
import { HostBindingRegistry } from "@batonfx/repl"
import * as KernelComposition from "@rika/kernel/kernel-composition"
import * as HarnessStoreLocations from "@rika/kernel/harness-store-locations"
import * as ScopePolicy from "@rika/kernel/harness-scope-policy"
import { HarnessMerge } from "@batonfx/harness"
import * as GoalService from "@rika/product/goal-service"
import * as ThreadQuery from "@rika/product/thread-query-service"
import { Crypto, Effect, Encoding, Function, Layer } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { runtimeAgentPortLayer } from "./server-agent-port"

/**
 * The workspace identity a harness `workspace` scope is keyed by. It must be a single path-safe
 * segment, so the digest of the absolute path is used rather than the path itself.
 */
export const workspaceDigest = (workspace: string): Effect.Effect<string, never, Crypto.Crypto> =>
  Crypto.Crypto.pipe(
    Effect.flatMap((crypto) => crypto.digest("SHA-256", new TextEncoder().encode(workspace))),
    Effect.map((bytes) => Encoding.encodeHex(bytes).slice(0, 32)),
    Effect.orDie,
  )

export interface Options {
  readonly workspace: string
  readonly home: string
  readonly dataRoot: string
  readonly runtimeVersion: string
  readonly goalRepositoryLayer: Layer.Layer<import("@rika/product/goal-repository").Service>
  readonly queryFactory: Layer.Layer<ThreadQuery.Factory>
  readonly toolRuntimeLayer: Layer.Layer<import("@rika/coding-tools/coding-tool-runtime").Service>
}

const harnessRoots = (options: Options): HarnessStoreLocations.Roots => ({
  home: options.home,
  workspace: options.workspace,
  dataRoot: options.dataRoot,
})

/** The durable per-scope harness store every Thread refines through. */
export const harnessStoreLayer = (options: Options): Layer.Layer<HarnessStore.HarnessStore> =>
  HarnessStoreLocations.layer(harnessRoots(options)).pipe(Layer.provide(BunServices.layer))

/**
 * The harness one Execution is pinned to: global under workspace under thread, merged outer to
 * inner exactly as the scope policy orders them.
 *
 * A Turn reads this BEFORE it starts, so a refinement a cell makes during the Turn lands in the
 * NEXT Execution rather than rewriting the running model's prompt.
 */
const effectiveHarnessImpl = (options: Options, threadId: string) =>
  Effect.gen(function* () {
    const store = yield* HarnessStore.HarnessStore
    const digest = yield* workspaceDigest(options.workspace)
    const identity = { thread: threadId, workspaceDigest: digest }
    const states = yield* Effect.forEach(ScopePolicy.mergeOrder, (level) =>
      store.load(ScopePolicy.scopeString(level, identity)),
    )
    return states.reduce((outer, inner) => HarnessMerge.mergeStates(outer, inner))
  })

export const effectiveHarness: {
  (threadId: string): (options: Options) => ReturnType<typeof effectiveHarnessImpl>
  (options: Options, threadId: string): ReturnType<typeof effectiveHarnessImpl>
} = Function.dual(2, effectiveHarnessImpl)

/** Every executable skill the Execution pins its identity to. */
export const discoverSkills = (options: Options) =>
  SkillRegistry.discover({
    globalRoot: globalPaths(options.home).skills,
    workspaceRoot: workspacePaths(options.workspace).skills,
  }).pipe(
    Effect.map((discovered) =>
      discovered.executable.map(
        (entry): ExecutionPins.SkillPin => ({
          name: entry.name,
          digest: entry.digest,
          importName: entry.importName,
        }),
      ),
    ),
    Effect.orElseSucceed((): ReadonlyArray<ExecutionPins.SkillPin> => []),
  )

/** Every MCP server the `mcp` binding can reach, read from the Workspace configuration. */
export const discoverServers = (options: Options) =>
  McpDiscovery.discover({ configPath: workspacePaths(options.workspace).mcpConfig }).pipe(
    Effect.map((discovered) => discovered.servers),
    Effect.orElseSucceed((): ReadonlyArray<McpDiscovery.ConfiguredServer> => []),
  )

/**
 * The services the mounted surface is closed over that are NOT per-call.
 *
 * ToolContext, NestedOperations, and Session are deliberately absent: they belong to one executing
 * cell and are supplied per request by `CellCallContext`, never captured here.
 */
const staticBindingServices = (options: Options) =>
  Layer.mergeAll(
    options.toolRuntimeLayer,
    ShellProcessRegistry.layer,
    options.queryFactory,
    McpRuntime.layer,
    harnessStoreLayer(options),
    GoalService.layer.pipe(Layer.provide(options.goalRepositoryLayer)),
    runtimeAgentPortLayer,
    ArtifactStore.layer(options.dataRoot),
  ).pipe(Layer.provide(SkillFileSystem.fileSystemLayer), Layer.provide(BunServices.layer))

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
  import("@batonfx/repl").KernelPool.KernelPool | CellCallContext.CellCallContext,
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
