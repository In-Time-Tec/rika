import { AgentManifest, ExecutableManifest, ModelRegistry } from "tenetkit"
import { ExecutableRegistration, ExecutableResolver } from "tenetkit/runtime"
import type { HarnessState } from "tenetkit/harness"
import { KernelPool, type KernelProfile } from "tenetkit/repl"
import * as CellCallContext from "./baton-cell-call-context"
import * as ExecutionPins from "@rika/kernel/execution-pins"
import type * as ExecutionRoute from "@rika/product/execution-route-snapshot"
import type * as OpenAiAuth from "@rika/product/openai-auth-service"
import type { ProviderCredentialStoreShape } from "@rika/product/provider-credential-store"
import { Context, Effect, Function, Layer } from "effect"
import type * as RemoteCellDispatcher from "./remote-cell-dispatcher"

type RouteSnapshot = ExecutionRoute.ExecutionRouteSnapshot

export interface KernelOptions {
  readonly runtimeVersion: string
  readonly dataRoot: string
  readonly limits?: KernelProfile.Limits
  readonly trustMode?: KernelProfile.TrustMode
}

export type LocalCellServices = KernelPool.KernelPool | CellCallContext.CellCallContext

export interface LocalCellRoute {
  readonly _tag: "Local"
  readonly services: Context.Context<LocalCellServices>
}

export interface RemoteCellRoute {
  readonly _tag: "Remote"
  readonly dispatcher: Layer.Layer<RemoteCellDispatcher.RemoteCellDispatcher>
  readonly maxRetries: number
  readonly retryDelayMillis: number
}

export type CellRoute = LocalCellRoute | RemoteCellRoute

export interface LocalCellResolver {
  readonly _tag: "Local"
  readonly forWorkspace: (workspace: string) => Effect.Effect<Context.Context<LocalCellServices>>
}

export type CellResolver = LocalCellResolver | RemoteCellRoute

export const resolveCellRoute: {
  (workspace: string): (resolver: CellResolver) => Effect.Effect<CellRoute>
  (resolver: CellResolver, workspace: string): Effect.Effect<CellRoute>
} = Function.dual(2, (resolver: CellResolver, workspace: string): Effect.Effect<CellRoute> =>
  resolver._tag === "Remote"
    ? Effect.succeed(resolver)
    : resolver.forWorkspace(workspace).pipe(Effect.map((services) => ({ _tag: "Local" as const, services }))),
)

export interface ConfigureOptions {
  readonly executionRoute: RouteSnapshot
  readonly workspace: string
  readonly kernel: KernelOptions
  readonly cell: CellRoute
  readonly skills?: ReadonlyArray<ExecutionPins.SkillPin>
  readonly harnessSnapshot?: HarnessState.HarnessState
  readonly modelServices?: Layer.Layer<ModelRegistry.ModelRegistry>
  readonly credentialStore?: ProviderCredentialStoreShape
  readonly openAiAccountAuth?: OpenAiAuth.ServiceInterface
}

export interface ConfiguredExecutable {
  readonly executable: ExecutableManifest.PinnedExecutable
  readonly titleExecutable: ExecutableManifest.PinnedExecutable
  readonly registrations: ReadonlyArray<ExecutableRegistration.ExecutableRegistration>
  readonly titleRegistrations: ReadonlyArray<ExecutableRegistration.ExecutableRegistration>
  readonly resolverEntries: ReadonlyArray<ExecutableResolver.StaticAgentExecutable>
  readonly profiles: Readonly<Record<string, AgentManifest.PinnedAgent>>
  readonly kernelProfile: KernelProfile.KernelProfile
}

export interface ResolverOptions {
  readonly kernel: KernelOptions
  readonly cell: CellResolver
  /**
   * A harness pin encodes the workspace scope it was read for, so a recovered Run resolves the
   * capabilities of the workspace its own registration pinned rather than one the Server chose.
   */
  readonly capabilities?: (workspace: string) => Effect.Effect<{
    readonly skills: ReadonlyArray<ExecutionPins.SkillPin>
    readonly harnessSnapshot: HarnessState.HarnessState
  }>
  readonly modelServices?: Layer.Layer<ModelRegistry.ModelRegistry>
  readonly credentialStore?: ProviderCredentialStoreShape
  readonly openAiAccountAuth?: OpenAiAuth.ServiceInterface
}
