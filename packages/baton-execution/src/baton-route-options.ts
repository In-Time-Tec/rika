import { AgentManifest, ExecutableManifest, ModelRegistry } from "@batonfx/core"
import { ExecutableRegistration, ExecutableResolver } from "@batonfx/runtime"
import type { HarnessState } from "@batonfx/harness"
import { KernelPool, type KernelProfile } from "@batonfx/repl"
import * as CellCallContext from "./baton-cell-call-context"
import * as ExecutionPins from "@rika/kernel/execution-pins"
import type * as ExecutionRoute from "@rika/product/execution-route-snapshot"
import type * as OpenAiAuth from "@rika/product/openai-auth-service"
import type { ProviderCredentialStoreShape } from "@rika/product/provider-credential-store"
import { Context, Effect, Layer } from "effect"

type RouteSnapshot = ExecutionRoute.ExecutionRouteSnapshot

export interface KernelOptions {
  readonly runtimeVersion: string
  readonly dataRoot: string
  readonly limits?: KernelProfile.Limits
  readonly trustMode?: KernelProfile.TrustMode
}

export interface ConfigureOptions {
  readonly executionRoute: RouteSnapshot
  readonly workspace: string
  readonly kernel: KernelOptions
  readonly kernelPool?: Context.Context<KernelPool.KernelPool | CellCallContext.CellCallContext>
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
  /**
   * A Server answers every workspace, so a Run resolves the kernel for the workspace its own
   * registration pinned rather than sharing one the Server chose at startup.
   */
  readonly kernelPool?: {
    readonly forWorkspace: (
      workspace: string,
    ) => Effect.Effect<Context.Context<KernelPool.KernelPool | CellCallContext.CellCallContext>>
  }
  readonly skills?: ReadonlyArray<ExecutionPins.SkillPin>
  readonly harnessSnapshot?: HarnessState.HarnessState
  readonly modelServices?: Layer.Layer<ModelRegistry.ModelRegistry>
  readonly credentialStore?: ProviderCredentialStoreShape
  readonly openAiAccountAuth?: OpenAiAuth.ServiceInterface
}
