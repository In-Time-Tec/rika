import { ModelRegistry } from "generalist"
import type { State } from "generalist/instructions"
import type * as ExecutionPins from "../harness/execution-pins"
import type { ProviderCredentialStore } from "@rika/product/provider-credential-store"
import type * as OpenAiAuth from "@rika/product/openai-auth-service"
import type { Effect, Layer } from "effect"
import type { Runtime } from "generalist/runtime"
import type * as Postgres from "../postgres"
import type { RemoteToolRoute } from "../routing/route"

export interface CommonOptions {
  readonly tools?: RemoteToolRoute
  readonly capabilities?: (workspace: string) => Effect.Effect<{
    readonly skills: ReadonlyArray<ExecutionPins.SkillPin>
    readonly harnessSnapshot: State.GuidanceState
  }>
  readonly modelServices?: Layer.Layer<ModelRegistry.ModelRegistry, never, never>
  readonly credentialStore?: Layer.Layer<ProviderCredentialStore, never, never>
  readonly openAiAccountAccess?: (credentialIdentity: string) => OpenAiAuth.CredentialAccess
  readonly subscriberQueueCapacity?: number
  readonly scheduler?: Runtime.LayerOptions["scheduler"]
}

export interface HostedOptions extends CommonOptions {
  readonly tools: RemoteToolRoute
  readonly postgres: Postgres.Options
}

export type MemoryOptions = CommonOptions
