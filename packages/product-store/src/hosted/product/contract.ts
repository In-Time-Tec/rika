import type { WorkspaceSeed as WorkspaceSeedValue } from "@rika/product/executor-assignment"
import type { HostedOwner, JsonObject } from "@rika/product/hosted-model"
import type { ProductProject } from "@rika/product/hosted-product"
import { Effect, Schema } from "effect"

export class ProductRepositoryError extends Schema.TaggedError<ProductRepositoryError>()("ProductRepositoryError", {
  kind: Schema.Literals(["conflict", "forbidden", "not-found", "unavailable"]),
  message: Schema.String,
}) {}

export interface OwnerAuthority {
  readonly ownerId: string
  readonly owner: HostedOwner
  readonly userId: string
  readonly membershipId?: string
}
export type { ProductProject } from "@rika/product/hosted-product"
export interface ProjectAccess {
  readonly role: ProductProject["role"]
}
export interface ThreadAuthorityProjection {
  readonly ownerId: string
  readonly kind: string
  readonly userId: string | null
  readonly organizationId: string | null
  readonly membershipId: string | null
  readonly createdByUserId: string
  readonly executorKind: "runner" | "orb"
  readonly inheritProjectGrants: boolean
  readonly threadRole: ProductProject["role"] | null
  readonly projectRole: ProductProject["role"] | null
}
export interface ThreadExecutionProjection {
  readonly assignmentId: string
  readonly workspaceId: string
  readonly executorKind: "runner" | "orb"
  readonly generation: string
  readonly lifecycle: string
  readonly executorInstanceId: string | null
  readonly providerInstanceId: string | null
  readonly checkout: unknown
  readonly localRepository: unknown
}
export type CreateConnectionResult =
  | { readonly _tag: "Created"; readonly threadId: string }
  | { readonly _tag: "Existing"; readonly threadId: string }
  | { readonly _tag: "Incompatible" }
  | { readonly _tag: "RunnerMissing" }
  | { readonly _tag: "RunnerAuthorityMismatch" }
  | { readonly _tag: "RunnerRemoteDenied" }

export interface ProductRepositoryService {
  readonly stageWorkspaceSeed: (input: {
    readonly id: string
    readonly userId: string
    readonly deviceId: string
    readonly clientId: string
    readonly manifest: WorkspaceSeedValue
    readonly expiresAt: Date
    readonly now: Date
  }) => Effect.Effect<void, ProductRepositoryError>
  readonly resolveOwner: (input: {
    readonly userId: string
    readonly selection: HostedOwner
    readonly proposedOwnerId: string
    readonly now: Date
  }) => Effect.Effect<OwnerAuthority, ProductRepositoryError>
  readonly organizationIds: (userId: string) => Effect.Effect<ReadonlyArray<string>, ProductRepositoryError>
  readonly projects: (input: {
    readonly userId: string
    readonly personalOwnerId: string
  }) => Effect.Effect<ReadonlyArray<ProductProject>, ProductRepositoryError>
  readonly projectAccess: (input: {
    readonly authority: OwnerAuthority
    readonly projectId: string
  }) => Effect.Effect<ProjectAccess | undefined, ProductRepositoryError>
  readonly createProject: (input: {
    readonly id: string
    readonly authority: OwnerAuthority
    readonly name: string
    readonly now: Date
  }) => Effect.Effect<ProductProject, ProductRepositoryError>
  readonly existingConnection: (input: {
    readonly authority: OwnerAuthority
    readonly projectId: string | null
    readonly executorKind: "runner" | "orb"
    readonly runnerTarget?: { readonly deviceId: string; readonly checkoutFingerprint: string }
    readonly workspaceSeedId?: string
    readonly threadId: string
    readonly archiveThreadId?: string
  }) => Effect.Effect<
    Extract<CreateConnectionResult, { readonly _tag: "Existing" | "Incompatible" }> | undefined,
    ProductRepositoryError
  >
  readonly createConnection: (input: {
    readonly authority: OwnerAuthority
    readonly projectId: string | null
    readonly executorKind: "runner" | "orb"
    readonly runnerTarget?: { readonly deviceId: string; readonly checkoutFingerprint: string }
    readonly requestingDeviceId: string
    readonly requestingClientId: string
    readonly workspaceSeedId?: string
    readonly threadId: string
    readonly archiveThreadId?: string
    readonly workspaceId: string
    readonly assignmentId: string
    readonly placement: JsonObject
    readonly checkout: JsonObject | null
    readonly now: Date
    readonly nowMillis: number
  }) => Effect.Effect<CreateConnectionResult, ProductRepositoryError>
  readonly threadAuthority: (
    userId: string,
    threadId: string,
  ) => Effect.Effect<ThreadAuthorityProjection | undefined, ProductRepositoryError>
  readonly threadExecutionContext: (
    ownerId: string,
    threadId: string,
  ) => Effect.Effect<ThreadExecutionProjection | undefined, ProductRepositoryError>
  readonly ready: Effect.Effect<void, ProductRepositoryError>
}
