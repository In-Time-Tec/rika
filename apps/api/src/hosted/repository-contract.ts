import type { ValidatedSetup } from "@rika/github-app/authorization-state"
import type { RepositoryCheckout } from "@rika/product/executor-assignment"
import type { Access } from "@rika/product/executor-assignments"
import type { ActorAttribution, AssignmentLeaseEpoch, FencingGeneration } from "@rika/product/hosted-model"
import { Context, Effect, Layer, Redacted, Schema } from "effect"

export const CredentialPurpose = Schema.Literals(["git-read", "github-read", "branch-push"])
export type CredentialPurpose = typeof CredentialPurpose.Type

export interface RepositoryCredential {
  readonly token: Redacted.Redacted<string>
  readonly username: "x-access-token"
  readonly repositoryUrl: string
  readonly expiresAt: number
}

export class HostedRepositoryError extends Schema.TaggedError<HostedRepositoryError>()("HostedRepositoryError", {
  reason: Schema.Literals(["authorization", "configuration", "database", "github", "identity", "stale-fence"]),
  message: Schema.String,
}) {}

export interface AuthorizeRepositoryInput {
  readonly ownerId: string
  readonly projectId: string
  readonly setup: ValidatedSetup
  readonly repositoryId: number
  readonly ref: string
  readonly gitIdentity: { readonly name: string; readonly email: string }
}

interface CredentialRequestBase {
  readonly access: Access
  readonly ownerId: string
  readonly workspaceId: string
  readonly repositoryId: string
}

export type InstallationPermissions =
  | { readonly contents: "read" }
  | { readonly contents: "read"; readonly issues: "read"; readonly pull_requests: "read" }
  | { readonly contents: "write" }

export type CredentialRequest = CredentialRequestBase &
  (
    | { readonly purpose: "git-read" | "github-read" }
    | {
        readonly purpose: "branch-push"
        readonly publicationId: string
        readonly branch: string
        readonly ref: string
        readonly commitSha: string
      }
  )

export interface TargetBranch {
  readonly ref: string
  readonly commitSha: string
  readonly protected: boolean
}

export interface PullRequestReceipt {
  readonly number: number
  readonly url: string
  readonly commitSha: string
  readonly targetRef: string
}

export type PublicationResult = Readonly<Record<string, Schema.Json>>
export type PublicationState = "approved" | "pushing" | "pushed" | "completed" | "failed" | "unknown"

export interface ApprovedPublication {
  readonly id: string
  readonly ownerId: string
  readonly threadId: string
  readonly projectId: string
  readonly repositoryId: string
  readonly assignmentId: string
  readonly assignmentGeneration: FencingGeneration
  readonly leaseEpoch: AssignmentLeaseEpoch
  readonly workspaceId: string
  readonly authorizationCheckpointId: string
  readonly authorizationDigest: string
  readonly sourceBranch: string
  readonly sourceRef: string
  readonly sourceCommitSha: string
  readonly target: TargetBranch
  readonly title: string
  readonly body: string
  readonly state: PublicationState
  readonly pushResult: object | null
  readonly pullRequestResult: object | null
}

export interface HostedRepositoriesService {
  readonly authorize: (input: AuthorizeRepositoryInput) => Effect.Effect<void, HostedRepositoryError>
  readonly resolve: (input: {
    readonly ownerId: string
    readonly projectId: string
    readonly ref?: string
  }) => Effect.Effect<RepositoryCheckout, HostedRepositoryError>
  readonly credential: (input: CredentialRequest) => Effect.Effect<RepositoryCredential, HostedRepositoryError>
  readonly revoke: (
    access: Access,
    purpose: CredentialPurpose,
    publicationId?: string,
  ) => Effect.Effect<void, HostedRepositoryError>
  readonly inspectTarget: (input: {
    readonly ownerId: string
    readonly projectId: string
    readonly targetRef: string
  }) => Effect.Effect<TargetBranch, HostedRepositoryError>
  readonly createPullRequest: (input: {
    readonly ownerId: string
    readonly projectId: string
    readonly repositoryId: string
    readonly sourceBranch: string
    readonly commitSha: string
    readonly target: TargetBranch
    readonly title: string
    readonly body: string
  }) => Effect.Effect<PullRequestReceipt, HostedRepositoryError>
  readonly approvePublication: (input: {
    readonly ownerId: string
    readonly threadId: string
    readonly actor: ActorAttribution
    readonly idempotencyKey: string
    readonly commitSha: string
    readonly targetRef?: string
    readonly title: string
    readonly body: string
  }) => Effect.Effect<ApprovedPublication, HostedRepositoryError>
  readonly recordPush: (
    publication: ApprovedPublication,
    result: PublicationResult,
    state: "pushed" | "failed" | "unknown",
  ) => Effect.Effect<ApprovedPublication, HostedRepositoryError>
  readonly recordPullRequest: (
    publication: ApprovedPublication,
    result: PublicationResult,
    succeeded: boolean,
  ) => Effect.Effect<ApprovedPublication, HostedRepositoryError>
  readonly revokePublicationCredential: (publicationId: string) => Effect.Effect<void, HostedRepositoryError>
}

export class HostedRepositories extends Context.Service<HostedRepositories, HostedRepositoriesService>()(
  "@rika/api/hosted/repository-contract/HostedRepositories",
) {}

const failure = (reason: HostedRepositoryError["reason"], message: string) =>
  HostedRepositoryError.make({ reason, message })

export const unavailableLayer = Layer.succeed(
  HostedRepositories,
  HostedRepositories.of({
    authorize: () => Effect.void,
    resolve: () => Effect.fail(failure("configuration", "Project repository is not configured")),
    credential: () => Effect.fail(failure("configuration", "Repository credential is not configured")),
    revoke: () => Effect.void,
    inspectTarget: () => Effect.fail(failure("configuration", "Repository target is not configured")),
    createPullRequest: () => Effect.fail(failure("configuration", "Pull request creation is not configured")),
    approvePublication: () => Effect.fail(failure("configuration", "Publication approval is not configured")),
    recordPush: () => Effect.fail(failure("configuration", "Publication result is not configured")),
    recordPullRequest: () => Effect.fail(failure("configuration", "Pull request result is not configured")),
    revokePublicationCredential: () => Effect.void,
  }),
)
