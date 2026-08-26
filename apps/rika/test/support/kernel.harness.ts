import * as McpDiscovery from "@rika/extensions/mcp-discovery"
import * as SkillRegistry from "@rika/extensions/skill-registry"
import * as ExecutionPins from "@rika/kernel/execution-pins"
import { globalPaths, workspacePaths } from "@rika/configuration/configuration-paths"
import { HarnessMerge, HarnessStore } from "tenetkit/harness"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as HarnessStoreLocations from "@rika/kernel/harness-store-locations"
import * as ScopePolicy from "@rika/kernel/harness-scope-policy"
import { Crypto, Effect, Encoding, Function, Layer } from "effect"
import type { Options } from "./kernel-options.fixture"

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
const effectiveHarnessImpl = (options: Options, threadId: string | undefined) =>
  Effect.gen(function* () {
    const store = yield* HarnessStore.HarnessStore
    const digest = yield* workspaceDigest(options.workspace)
    const identity = { thread: threadId ?? "", workspaceDigest: digest }
    /**
     * A Server has no Thread yet, so it pins the global and workspace scopes only. A Thread's own
     * scope is named by its Session identity, which does not exist until a Turn starts, and naming
     * it after something else — a workspace path, say — would both fail the scope segment and
     * pin one Thread's refinements onto every Thread.
     */
    const levels = threadId === undefined ? ["global" as const, "workspace" as const] : ScopePolicy.mergeOrder
    const states = yield* Effect.forEach(levels, (level) => store.load(ScopePolicy.scopeString(level, identity)))
    return states.reduce((outer, inner) => HarnessMerge.mergeStates(outer, inner))
  })

export const effectiveHarness: {
  (threadId: string | undefined): (options: Options) => ReturnType<typeof effectiveHarnessImpl>
  (options: Options, threadId: string | undefined): ReturnType<typeof effectiveHarnessImpl>
} = Function.dual(2, effectiveHarnessImpl)

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
