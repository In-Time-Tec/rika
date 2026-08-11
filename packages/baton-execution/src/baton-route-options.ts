import { AgentManifest, ExecutableManifest, ModelRegistry } from "@batonfx/core"
import { ExecutableRegistration, ExecutableResolver, Runtime } from "@batonfx/runtime"
import type { HarnessState } from "@batonfx/harness"
import { KernelPool, type KernelProfile } from "@batonfx/repl"
import * as CellCallContext from "./baton-cell-call-context"
import * as RoleToolkits from "@rika/coding-tools/agent-role-toolkits"
import * as ExecutionPins from "@rika/kernel/execution-pins"
import type * as ExecutionRoute from "@rika/product/execution-route-snapshot"
import type * as OpenAiAuth from "@rika/product/openai-auth-service"
import type { ProviderCredentialStoreShape } from "@rika/product/provider-credential-store"
import { Context, Effect, Layer, Option } from "effect"
import { Tool } from "effect/unstable/ai"

type RouteSnapshot = ExecutionRoute.ExecutionRouteSnapshot

export type AgentToolHandlers =
  | Tool.HandlersFor<typeof RoleToolkits.root.tools>
  | Tool.HandlersFor<typeof RoleToolkits.oracle.tools>
  | Tool.HandlersFor<typeof RoleToolkits.librarian.tools>
  | Tool.HandlersFor<typeof RoleToolkits.painter.tools>
  | Tool.HandlersFor<typeof RoleToolkits.readThread.tools>
  | Tool.HandlersFor<typeof RoleToolkits.surgeon.tools>
  | Tool.HandlersFor<typeof RoleToolkits.task.tools>

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
  readonly durableRuntime?: Effect.Effect<Option.Option<Runtime.Runtime["Service"]>>
  readonly skills?: ReadonlyArray<ExecutionPins.SkillPin>
  readonly harnessSnapshot?: HarnessState.HarnessState
  readonly agentServices?: Layer.Layer<AgentToolHandlers>
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
  readonly kernelPool?: Context.Context<KernelPool.KernelPool | CellCallContext.CellCallContext>
  readonly durableRuntime?: Effect.Effect<Option.Option<Runtime.Runtime["Service"]>>
  readonly skills?: ReadonlyArray<ExecutionPins.SkillPin>
  readonly harnessSnapshot?: HarnessState.HarnessState
  readonly agentServices?: (workspace: string) => Layer.Layer<AgentToolHandlers>
  readonly modelServices?: Layer.Layer<ModelRegistry.ModelRegistry>
  readonly credentialStore?: ProviderCredentialStoreShape
  readonly openAiAccountAuth?: OpenAiAuth.ServiceInterface
}
