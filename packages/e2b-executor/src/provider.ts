import { Context, Effect, Redacted, Schema } from "effect"

export interface SandboxCreateRequest {
  readonly templateBuildId: string
  readonly assignmentId: string
  readonly workspaceId: string
  readonly generation: number
  readonly idleTimeoutMillis: number
  readonly allowedEgress: ReadonlyArray<string>
  readonly environment: Readonly<Record<string, string>>
  readonly secrets: Readonly<Record<string, Redacted.Redacted<string>>>
}

export interface SandboxHandle {
  readonly sandboxId: string
  readonly state: "running" | "paused"
}

export interface SandboxInventoryEntry extends SandboxHandle {
  readonly templateBuildId: string
  readonly metadata: Readonly<Record<string, string>>
}

export class SandboxProviderError extends Schema.TaggedError<SandboxProviderError>()("SandboxProviderError", {
  operation: Schema.Literals(["create", "connect", "pause", "kill", "touch", "inventory"]),
  message: Schema.String,
}) {}

export interface Interface {
  readonly create: (request: SandboxCreateRequest) => Effect.Effect<SandboxHandle, SandboxProviderError>
  readonly connect: (sandboxId: string, idleTimeoutMillis: number) => Effect.Effect<SandboxHandle, SandboxProviderError>
  readonly pauseFilesystem: (sandboxId: string) => Effect.Effect<boolean, SandboxProviderError>
  readonly kill: (sandboxId: string) => Effect.Effect<boolean, SandboxProviderError>
  readonly touch: (sandboxId: string, idleTimeoutMillis: number) => Effect.Effect<void, SandboxProviderError>
  readonly inventory: Effect.Effect<ReadonlyArray<SandboxInventoryEntry>, SandboxProviderError>
}

export class E2BSandboxProvider extends Context.Service<E2BSandboxProvider, Interface>()(
  "@rika/e2b-executor/provider/E2BSandboxProvider",
) {}
