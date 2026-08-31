import { ModelRegistry } from "tenetkit"
import type { State } from "tenetkit/agent-guidance"
import { KernelPool, KernelStateStore } from "tenetkit/repl"
import type * as ExecutionPins from "@rika/kernel/execution-pins"
import type * as ExecutorRuntime from "@rika/kernel/executor-runtime"
import type { ProviderCredentialStore } from "@rika/product/provider-credential-store"
import type * as OpenAiAuth from "@rika/product/openai-auth-service"
import type { Context, Effect, Layer } from "effect"
import type { Runtime } from "tenetkit/runtime"
import type * as Postgres from "../postgres"
import type { KernelOptions, RemoteCellRoute } from "../routing/route"
import type * as Route from "../routing/route"

export type KernelPoolServices = KernelPool.KernelPool | ExecutorRuntime.CellContext

export interface LocalCells extends Route.LocalCellResolver {
  readonly built: Effect.Effect<ReadonlyArray<Context.Context<KernelPoolServices | KernelStateStore.KernelStateStore>>>
}

export type Cells = LocalCells | RemoteCellRoute

export interface CommonOptions {
  readonly kernel: KernelOptions
  readonly cells?: Cells
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
  readonly cells: Cells
  readonly postgres: Postgres.Options
}

export interface MemoryOptions extends Omit<CommonOptions, "kernel"> {
  readonly dataRoot: string
  readonly kernel?: KernelOptions
}

export interface LocalCellsOptions {
  readonly forWorkspace: (
    workspace: string,
  ) => Effect.Effect<Context.Context<KernelPoolServices | KernelStateStore.KernelStateStore>>
  readonly built: Effect.Effect<ReadonlyArray<Context.Context<KernelPoolServices | KernelStateStore.KernelStateStore>>>
}
