import { Context, Effect, Schema } from "effect"
import type { AuthorizationAction } from "@rika/product/hosted-authorization"
import type { ActorAttribution, HostedOwner, JsonObject, OwnerId, ThreadId } from "@rika/product/hosted-model"
import { HostedPersistenceError } from "@rika/product/hosted-persistence-error"
import type { PromptPart } from "@rika/product/execution-request"
import type { ProductProject } from "@rika/product/hosted-product"
import type { RemoteThreadCreationPreference, RunnerProfile, RunnerTarget } from "@rika/product/runner-registration"
import { ProductRepositoryError } from "@rika/product-store/product-repository"
import { RunnerRegistrationsError } from "@rika/product-store/runner-registrations"
import type { HostedModelRegistryError } from "../environment/model-registry"

export interface AuthenticatedPrincipal {
  readonly userId: string
  readonly deviceId: string
  readonly clientId: string
  readonly dpopJkt?: string
}

export type OwnerSelection = HostedOwner

export type ProjectContext = ProductProject

export type AdmittedRun =
  | {
      readonly _tag: "Admitted"
      readonly commandId: string
      readonly turnId: string
      readonly status: "accepted" | "queued"
    }
  | { readonly _tag: "Cancelled"; readonly commandId: string }

export interface ThreadAuthority {
  readonly ownerId: OwnerId
  readonly actor: ActorAttribution
}

export interface OwnerAuthority {
  readonly ownerId: OwnerId
}

export interface ThreadExecutionContext {
  readonly workspaceId: string
  readonly repository: JsonObject | null
  readonly branch: string | null
  readonly executor: JsonObject
}

export class HostedProductError extends Schema.TaggedError<HostedProductError>()("HostedProductError", {
  kind: Schema.optionalKey(Schema.Literals(["conflict", "not-found", "forbidden", "invalid", "unavailable"])),
  message: Schema.String,
}) {}

export const unavailable = () =>
  HostedProductError.make({ kind: "unavailable", message: "Rika service is unavailable" })

export const forbidden = (message = "Resource is unavailable") =>
  HostedProductError.make({ kind: "forbidden", message })

type ProductOperationError = HostedProductError | HostedPersistenceError | { readonly _tag: string }

export const storeFailure = (error: ProductOperationError) => {
  if (Schema.is(HostedProductError)(error)) return error
  if (!Schema.is(HostedPersistenceError)(error)) return unavailable()
  let kind: NonNullable<HostedProductError["kind"]> = "unavailable"
  if (error.reason === "conflict" || error.reason === "stale-fence") kind = "conflict"
  else if (error.reason === "not-found") kind = "not-found"
  else if (error.reason === "invalid-authority") kind = "forbidden"
  return HostedProductError.make({ kind, message: "Rika operation was rejected" })
}

export const modelFailure = (error: HostedModelRegistryError) =>
  HostedProductError.make({
    kind: error.kind === "unavailable" ? "unavailable" : "invalid",
    message: error.message,
  })

export const repositoryFailure = (error: ProductRepositoryError | RunnerRegistrationsError) =>
  Schema.is(ProductRepositoryError)(error)
    ? HostedProductError.make({ kind: error.kind, message: error.message })
    : unavailable()

export interface HostedProductService {
  readonly ready: Effect.Effect<void, HostedProductError>
  readonly projects: (
    principal: AuthenticatedPrincipal,
  ) => Effect.Effect<ReadonlyArray<ProjectContext>, HostedProductError>
  readonly createProject: (input: {
    readonly principal: AuthenticatedPrincipal
    readonly owner: OwnerSelection
    readonly name: string
  }) => Effect.Effect<ProjectContext, HostedProductError>
  readonly createConnection: (input: {
    readonly principal: AuthenticatedPrincipal
    readonly owner: OwnerSelection
    readonly projectId?: string
    readonly executorKind: "runner" | "orb"
    readonly runnerTarget?: RunnerTarget
    readonly workspaceSeedId?: string
    readonly threadId?: string
    readonly archiveThreadId?: string
  }) => Effect.Effect<{ readonly threadId: string }, HostedProductError>
  readonly registerRunner: (input: {
    readonly principal: AuthenticatedPrincipal
    readonly checkoutFingerprint: string
    readonly registration: RunnerProfile
  }) => Effect.Effect<void, HostedProductError>
  readonly setRemoteThreadCreation: (input: {
    readonly principal: AuthenticatedPrincipal
    readonly checkoutFingerprint: string
    readonly preference: RemoteThreadCreationPreference
  }) => Effect.Effect<void, HostedProductError>
  readonly pollRunner: (input: {
    readonly principal: AuthenticatedPrincipal
    readonly checkoutFingerprint: string
    readonly supervisorId: string
    readonly activeAssignmentIds: ReadonlyArray<string>
  }) => Effect.Effect<
    {
      readonly claimed: boolean
      readonly assignment?: {
        readonly assignmentId: string
        readonly threadId: string
        readonly workspaceId: string
        readonly resume: boolean
        readonly leaseExpiresAt: number | null
      }
    },
    HostedProductError
  >
  readonly admitRun: (input: {
    readonly principal: AuthenticatedPrincipal
    readonly threadId: string
    readonly operationKey: string
    readonly prompt: string
    readonly promptParts?: ReadonlyArray<PromptPart>
    readonly mode?: string
    readonly review?: true
  }) => Effect.Effect<AdmittedRun, HostedProductError>
  readonly admitAuthorizedRun: (input: {
    readonly authority: ThreadAuthority
    readonly threadId: string
    readonly operationKey: string
    readonly turnId: string
    readonly claimToken?: string
    readonly submissionId?: string
    readonly prompt: string
    readonly promptParts?: ReadonlyArray<PromptPart>
    readonly mode?: string
    readonly review?: true
  }) => Effect.Effect<AdmittedRun, HostedProductError>
  readonly cancelRunAdmission: (input: {
    readonly principal: AuthenticatedPrincipal
    readonly threadId: string
    readonly cancelCommandId: string
    readonly targetCommandId: string
  }) => Effect.Effect<{ readonly turnId?: string }, HostedProductError>
  readonly cancelAuthorizedRunAdmission: (input: {
    readonly authority: ThreadAuthority
    readonly threadId: string
    readonly cancelCommandId: string
    readonly targetCommandId: string
    readonly claimToken?: string
  }) => Effect.Effect<{ readonly turnId?: string }, HostedProductError>
  readonly authorizeOwner: (
    principal: AuthenticatedPrincipal,
    owner: OwnerSelection,
  ) => Effect.Effect<OwnerAuthority, HostedProductError>
  readonly authorizeThread: (
    principal: AuthenticatedPrincipal,
    threadId: string,
    action: AuthorizationAction,
  ) => Effect.Effect<ThreadAuthority, HostedProductError>
  readonly threadExecutionContext: (
    ownerId: OwnerId,
    threadId: ThreadId,
  ) => Effect.Effect<ThreadExecutionContext, HostedProductError>
  readonly activatePrincipal: (principal: AuthenticatedPrincipal) => Effect.Effect<void, HostedProductError>
}

export class HostedProduct extends Context.Service<HostedProduct, HostedProductService>()(
  "@rika/api/hosted/product/contract/HostedProduct",
) {}
