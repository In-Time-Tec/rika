import * as PgClient from "@effect/sql-pg/PgClient"
import type { ValidatedSetup } from "@rika/github-app/authorization-state"
import { sameAccount } from "@rika/github-app/github-model"
import { Installation } from "@rika/github-app/installation-service"
import { InstallationToken, type RepositoryToken } from "@rika/github-app/installation-token"
import type { RepositoryCheckout } from "@rika/product/executor-assignment"
import { ExecutorAssignments, type Access } from "@rika/product/executor-assignments"
import { OwnerId, type ActorAttribution } from "@rika/product/hosted-model"
import { Context, Crypto, Effect, Encoding, Layer, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

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

export type PublicationState = "approved" | "pushing" | "pushed" | "completed" | "failed" | "unknown"

export interface ApprovedPublication {
  readonly id: string
  readonly ownerId: string
  readonly threadId: string
  readonly projectId: string
  readonly repositoryId: string
  readonly assignmentId: string
  readonly assignmentGeneration: number
  readonly leaseEpoch: number
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
    result: object,
    state: "pushed" | "failed" | "unknown",
  ) => Effect.Effect<ApprovedPublication, HostedRepositoryError>
  readonly recordPullRequest: (
    publication: ApprovedPublication,
    result: object,
    succeeded: boolean,
  ) => Effect.Effect<ApprovedPublication, HostedRepositoryError>
  readonly revokePublicationCredential: (publicationId: string) => Effect.Effect<void, HostedRepositoryError>
}

export class HostedRepositories extends Context.Service<HostedRepositories, HostedRepositoriesService>()(
  "@rika/api/hosted-repositories/HostedRepositories",
) {}

export const testLayer = Layer.succeed(
  HostedRepositories,
  HostedRepositories.of({
    authorize: () => Effect.void,
    resolve: () => Effect.fail(failure("configuration", "Test Project repository is not configured")),
    credential: () => Effect.fail(failure("configuration", "Test repository credential is not configured")),
    revoke: () => Effect.void,
    inspectTarget: () => Effect.fail(failure("configuration", "Test repository target is not configured")),
    createPullRequest: () => Effect.fail(failure("configuration", "Test pull request creation is not configured")),
    approvePublication: () => Effect.fail(failure("configuration", "Test publication approval is not configured")),
    recordPush: () => Effect.fail(failure("configuration", "Test publication result is not configured")),
    recordPullRequest: () => Effect.fail(failure("configuration", "Test pull request result is not configured")),
    revokePublicationCredential: () => Effect.void,
  }),
)

interface BindingRow {
  readonly projectId: string
  readonly ownerId: string
  readonly repositoryId: string
  readonly installationId: string
  readonly accountId: string
  readonly accountLogin: string
  readonly accountType: "User" | "Organization" | "Enterprise"
  readonly repositoryOwner: string
  readonly repositoryName: string
  readonly defaultRef: string
  readonly private: boolean
  readonly gitName: string
  readonly gitEmail: string
}

const Commit = Schema.Struct({ sha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)) })
const Branch = Schema.Struct({
  name: Schema.NonEmptyString,
  protected: Schema.Boolean,
  commit: Commit,
})
const PullRequest = Schema.Struct({
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  html_url: Schema.NonEmptyString,
  head: Commit,
  base: Schema.Struct({ ref: Schema.NonEmptyString }),
})
function failure(reason: HostedRepositoryError["reason"], message: string) {
  return HostedRepositoryError.make({ reason, message })
}
const mapGitHubError = () => failure("github", "GitHub repository authorization failed")
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`
  return JSON.stringify(value)
}
const tokenKey = (access: Access, purpose: CredentialPurpose, publicationId?: string) =>
  `${access.assignmentId}:${access.assignmentGeneration}:${access.leaseEpoch}:${purpose}:${publicationId ?? ""}`

export const layer = (options: { readonly baseUrl?: string } = {}) =>
  Layer.effect(
    HostedRepositories,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const installations = yield* Installation
      const tokens = yield* InstallationToken
      const assignments = yield* ExecutorAssignments
      const client = yield* HttpClient.HttpClient
      const crypto = yield* Crypto.Crypto
      const issued = new Map<string, RepositoryToken>()
      const publicationTokens = new Map<string, { readonly key: string; readonly token: RepositoryToken }>()
      yield* Effect.addFinalizer(() =>
        Effect.forEach(
          [...issued.values(), ...[...publicationTokens.values()].map((record) => record.token)],
          (token) => tokens.revoke(token.token).pipe(Effect.ignore),
          { discard: true, concurrency: 4 },
        ),
      )

      const authorizationDigest = Effect.fn("HostedRepositories.authorizationDigest")(function* (value: object) {
        const bytes = yield* crypto
          .digest(
            "SHA-256",
            new TextEncoder().encode(`rika.repository-publication.authorization.v1\n${canonicalJson(value)}`),
          )
          .pipe(Effect.mapError(() => failure("database", "Could not identify the publication authorization")))
        return `sha256:${Encoding.encodeHex(bytes)}`
      })

      const selectBinding = Effect.fn("HostedRepositories.selectBinding")(function* (
        ownerId: string,
        projectId: string,
      ) {
        const rows = yield* sql<BindingRow>`SELECT repository.project_id AS "projectId",
          repository.owner_id AS "ownerId", repository.repository_id AS "repositoryId",
          repository.installation_id AS "installationId",
          repository.installation_account_id AS "accountId",
          repository.installation_account_login AS "accountLogin",
          repository.installation_account_type AS "accountType",
          repository.repository_owner AS "repositoryOwner", repository.repository_name AS "repositoryName",
          repository.default_ref AS "defaultRef", repository.private,
          identity.name AS "gitName", identity.email AS "gitEmail"
          FROM rika_hosted_project_repositories repository
          JOIN rika_hosted_git_identities identity ON identity.owner_id = repository.owner_id
          WHERE repository.owner_id = ${ownerId} AND repository.project_id = ${projectId}`.pipe(
          Effect.mapError(() => failure("database", "Could not load the authorized Project repository")),
        )
        if (rows[0] === undefined)
          return yield* failure("configuration", "Project does not have an authorized repository and Git identity")
        return rows[0]
      })

      const verifyBinding = Effect.fn("HostedRepositories.verifyBinding")(function* (binding: BindingRow) {
        const snapshot = yield* installations
          .reconcileInstallation(Number(binding.installationId))
          .pipe(Effect.mapError(mapGitHubError))
        if (
          String(snapshot.installation.account.id) !== binding.accountId ||
          snapshot.installation.account.login.toLowerCase() !== binding.accountLogin.toLowerCase() ||
          snapshot.installation.account.type !== binding.accountType
        )
          return yield* failure("authorization", "GitHub installation ownership changed")
        const repository = snapshot.repositories.find((candidate) => String(candidate.id) === binding.repositoryId)
        if (
          repository === undefined ||
          repository.owner.login.toLowerCase() !== binding.repositoryOwner.toLowerCase() ||
          repository.name.toLowerCase() !== binding.repositoryName.toLowerCase() ||
          repository.private !== binding.private ||
          repository.archived
        )
          return yield* failure("authorization", "Project repository is no longer authorized by the installation")
        return repository
      })

      const mint = (binding: BindingRow, permissions: Record<string, "read" | "write">, fresh = false) =>
        tokens
          .mint({
            installationId: Number(binding.installationId),
            repositoryIds: [Number(binding.repositoryId)],
            permissions,
            fresh,
          })
          .pipe(Effect.mapError(mapGitHubError))

      const repositoryApiUrl = (binding: BindingRow, path: string) =>
        `${options.baseUrl ?? "https://api.github.com"}/repos/${encodeURIComponent(binding.repositoryOwner)}/${encodeURIComponent(binding.repositoryName)}${path}`

      const githubRequest = (token: RepositoryToken, request: HttpClientRequest.HttpClientRequest, message: string) =>
        client
          .execute(
            HttpClientRequest.setHeaders(request, {
              accept: "application/vnd.github+json",
              authorization: `Bearer ${Redacted.value(token.token)}`,
              "x-github-api-version": "2026-03-10",
            }),
          )
          .pipe(Effect.mapError(() => failure("github", message)))

      const targetWithToken = Effect.fn("HostedRepositories.targetWithToken")(function* (
        binding: BindingRow,
        token: RepositoryToken,
        targetRef: string,
      ) {
        const response = yield* githubRequest(
          token,
          HttpClientRequest.get(repositoryApiUrl(binding, `/branches/${encodeURIComponent(targetRef)}`)),
          "Could not inspect the pull request target",
        )
        if (response.status < 200 || response.status >= 300)
          return yield* failure("authorization", "Pull request target is missing or unreachable")
        const branch = yield* HttpClientResponse.schemaBodyJson(Branch)(response).pipe(
          Effect.mapError(() => failure("github", "GitHub returned an invalid target branch")),
        )
        if (branch.name !== targetRef)
          return yield* failure("authorization", "GitHub returned a different pull request target")
        return { ref: branch.name, commitSha: branch.commit.sha, protected: branch.protected }
      })

      const verifySourceBranch = Effect.fn("HostedRepositories.verifySourceBranch")(function* (
        binding: BindingRow,
        token: RepositoryToken,
        sourceBranch: string,
      ) {
        const response = yield* githubRequest(
          token,
          HttpClientRequest.get(repositoryApiUrl(binding, `/branches/${encodeURIComponent(sourceBranch)}`)),
          "Could not inspect the publication branch",
        )
        if (response.status === 404) return
        if (response.status < 200 || response.status >= 300)
          return yield* failure("authorization", "Publication branch policy is unreachable")
        const branch = yield* HttpClientResponse.schemaBodyJson(Branch)(response).pipe(
          Effect.mapError(() => failure("github", "GitHub returned an invalid publication branch")),
        )
        if (branch.name !== sourceBranch || branch.protected)
          return yield* failure("authorization", "Publication branch is protected or has a different identity")
      })

      interface PublicationCredentialRow {
        readonly actor: object
        readonly ownerId: string
        readonly threadId: string
        readonly projectId: string
        readonly repositoryId: string
        readonly workspaceId: string
        readonly assignmentId: string
        readonly assignmentGeneration: string
        readonly leaseEpoch: string
        readonly authorizationCheckpointId: string
        readonly authorizationDigest: string
        readonly sourceBranch: string
        readonly sourceRef: string
        readonly sourceCommitSha: string
        readonly targetRef: string
        readonly targetCommitSha: string
        readonly targetProtected: boolean
      }

      interface PublicationRow {
        readonly id: string
        readonly idempotencyKey: string
        readonly actor: object
        readonly ownerId: string
        readonly threadId: string
        readonly projectId: string
        readonly repositoryId: string
        readonly assignmentId: string
        readonly assignmentGeneration: string
        readonly leaseEpoch: string
        readonly workspaceId: string
        readonly authorizationCheckpointId: string
        readonly authorizationDigest: string
        readonly sourceBranch: string
        readonly sourceRef: string
        readonly sourceCommitSha: string
        readonly targetRef: string
        readonly targetCommitSha: string
        readonly targetProtected: boolean
        readonly title: string
        readonly body: string
        readonly state: PublicationState
        readonly pushResult: object | null
        readonly pullRequestResult: object | null
      }

      const toPublication = (row: PublicationRow): ApprovedPublication => ({
        id: row.id,
        ownerId: row.ownerId,
        threadId: row.threadId,
        projectId: row.projectId,
        repositoryId: row.repositoryId,
        assignmentId: row.assignmentId,
        assignmentGeneration: Number(row.assignmentGeneration),
        leaseEpoch: Number(row.leaseEpoch),
        workspaceId: row.workspaceId,
        authorizationCheckpointId: row.authorizationCheckpointId,
        authorizationDigest: row.authorizationDigest,
        sourceBranch: row.sourceBranch,
        sourceRef: row.sourceRef,
        sourceCommitSha: row.sourceCommitSha,
        target: { ref: row.targetRef, commitSha: row.targetCommitSha, protected: row.targetProtected },
        title: row.title,
        body: row.body,
        state: row.state,
        pushResult: row.pushResult,
        pullRequestResult: row.pullRequestResult,
      })

      const publicationColumns = sql`publication.id, publication.idempotency_key AS "idempotencyKey",
        publication.actor, publication.owner_id AS "ownerId",
        publication.thread_id AS "threadId", publication.project_id AS "projectId",
        publication.repository_id AS "repositoryId", publication.assignment_id AS "assignmentId",
        publication.assignment_generation::text AS "assignmentGeneration",
        publication.lease_epoch::text AS "leaseEpoch", publication.workspace_id AS "workspaceId",
        publication.authorization_checkpoint_id AS "authorizationCheckpointId",
        publication.authorization_digest AS "authorizationDigest",
        publication.source_branch AS "sourceBranch", publication.source_ref AS "sourceRef",
        publication.source_commit_sha AS "sourceCommitSha", publication.target_ref AS "targetRef",
        publication.target_commit_sha AS "targetCommitSha", publication.target_protected AS "targetProtected",
        publication.pull_request_title AS title, publication.pull_request_body AS body, publication.state,
        publication.push_result AS "pushResult", publication.pull_request_result AS "pullRequestResult"`

      const publicationAuthority = (publication: PublicationCredentialRow) => ({
        ownerId: publication.ownerId,
        threadId: publication.threadId,
        projectId: publication.projectId,
        repositoryId: publication.repositoryId,
        sourceBranch: publication.sourceBranch,
        sourceRef: publication.sourceRef,
        sourceCommitSha: publication.sourceCommitSha,
        targetRef: publication.targetRef,
        targetCommitSha: publication.targetCommitSha,
        targetProtected: publication.targetProtected,
      })

      const publicationFence = (publication: PublicationCredentialRow) => ({
        assignmentId: publication.assignmentId,
        assignmentGeneration: publication.assignmentGeneration,
        leaseEpoch: publication.leaseEpoch,
        workspaceId: publication.workspaceId,
        authorizationCheckpointId: publication.authorizationCheckpointId,
        authorizationDigest: publication.authorizationDigest,
      })

      const claimBranchPush = Effect.fn("HostedRepositories.claimBranchPush")(function* (
        input: Extract<CredentialRequest, { readonly purpose: "branch-push" }>,
      ) {
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const rows = yield* sql<PublicationCredentialRow>`UPDATE rika_hosted_repository_publications publication
              SET state = 'pushing', credential_authorized_at = transaction_timestamp(),
                updated_at = transaction_timestamp()
              FROM rika_hosted_executor_assignments assignment,
                rika_hosted_workspace_preparations preparation
              WHERE publication.id = ${input.publicationId}
                AND publication.state = 'approved' AND publication.credential_authorized_at IS NULL
                AND publication.owner_id = ${input.ownerId}
                AND publication.repository_id = ${input.repositoryId}
                AND publication.workspace_id = ${input.workspaceId}
                AND publication.source_branch = ${input.branch}
                AND publication.source_ref = ${input.ref}
                AND publication.source_commit_sha = ${input.commitSha}
                AND assignment.id = publication.assignment_id
                AND assignment.owner_id = publication.owner_id
                AND assignment.thread_id = publication.thread_id
                AND assignment.workspace_id = publication.workspace_id
                AND assignment.generation = publication.assignment_generation
                AND assignment.generation = ${input.access.assignmentGeneration}::bigint
                AND assignment.lifecycle = 'active'
                AND assignment.provider_instance_id = ${input.access.providerInstanceId}
                AND assignment.executor_instance_id = ${input.access.executorInstanceId}
                AND assignment.process_incarnation = ${input.access.processIncarnation}
                AND assignment.lease_epoch = publication.lease_epoch
                AND assignment.lease_epoch = ${input.access.leaseEpoch}::bigint
                AND assignment.lease_expires_at > clock_timestamp()
                AND assignment.session_digest = ${Redacted.value(input.access.presentedSessionCredentialDigest)}
                AND assignment.checkout ->> 'ownerId' = publication.owner_id
                AND assignment.checkout ->> 'projectId' = publication.project_id
                AND assignment.checkout ->> 'repositoryId' = publication.repository_id
                AND preparation.assignment_id = publication.assignment_id
                AND preparation.owner_id = publication.owner_id
                AND preparation.workspace_id = publication.workspace_id
                AND preparation.generation = publication.assignment_generation
                AND preparation.lease_epoch = publication.lease_epoch
                AND preparation.state = 'ready'
              RETURNING publication.actor, publication.owner_id AS "ownerId",
                publication.thread_id AS "threadId", publication.project_id AS "projectId",
                publication.repository_id AS "repositoryId", publication.workspace_id AS "workspaceId",
                publication.assignment_id AS "assignmentId",
                publication.assignment_generation::text AS "assignmentGeneration",
                publication.lease_epoch::text AS "leaseEpoch",
                publication.authorization_checkpoint_id AS "authorizationCheckpointId",
                publication.authorization_digest AS "authorizationDigest", publication.source_branch AS "sourceBranch",
                publication.source_ref AS "sourceRef", publication.source_commit_sha AS "sourceCommitSha",
                publication.target_ref AS "targetRef", publication.target_commit_sha AS "targetCommitSha",
                publication.target_protected AS "targetProtected"`
              const publication = rows[0]
              if (publication === undefined)
                return yield* failure("authorization", "Branch push approval is stale or does not match this operation")
              yield* sql`INSERT INTO rika_hosted_repository_publication_audit
                (publication_id, owner_id, thread_id, actor, action, authority, fence, result)
                VALUES (${input.publicationId}, ${publication.ownerId}, ${publication.threadId},
                  ${sql.json(publication.actor)}, 'branch-push-credential-authorized',
                  ${sql.json(publicationAuthority(publication))}, ${sql.json(publicationFence(publication))},
                  ${sql.json({ purpose: "branch-push", permissions: { contents: "write" } })})`
              return publication
            }),
          )
          .pipe(
            Effect.mapError((error) =>
              Schema.is(HostedRepositoryError)(error)
                ? error
                : failure("database", "Could not claim the branch push approval"),
            ),
          )
      })

      const branchCredentialFailed = (publicationId: string, publication: PublicationCredentialRow) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const failed = yield* sql<{ readonly id: string }>`UPDATE rika_hosted_repository_publications
                SET state = 'failed', updated_at = transaction_timestamp()
                WHERE id = ${publicationId} AND state = 'pushing'
                  AND owner_id = ${publication.ownerId} AND thread_id = ${publication.threadId}
                  AND project_id = ${publication.projectId} AND repository_id = ${publication.repositoryId}
                  AND assignment_id = ${publication.assignmentId}
                  AND assignment_generation = ${publication.assignmentGeneration}::bigint
                  AND lease_epoch = ${publication.leaseEpoch}::bigint
                  AND workspace_id = ${publication.workspaceId}
                  AND authorization_checkpoint_id = ${publication.authorizationCheckpointId}
                  AND authorization_digest = ${publication.authorizationDigest}
                  AND source_branch = ${publication.sourceBranch} AND source_ref = ${publication.sourceRef}
                  AND source_commit_sha = ${publication.sourceCommitSha}
                  AND target_ref = ${publication.targetRef} AND target_commit_sha = ${publication.targetCommitSha}
                  AND target_protected = ${publication.targetProtected}
                RETURNING id`
              if (failed[0] === undefined) return
              yield* sql`INSERT INTO rika_hosted_repository_publication_audit
                (publication_id, owner_id, thread_id, actor, action, authority, fence, result)
                VALUES (${publicationId}, ${publication.ownerId}, ${publication.threadId},
                  ${sql.json(publication.actor)}, 'branch-push-credential-failed',
                  ${sql.json(publicationAuthority(publication))}, ${sql.json(publicationFence(publication))},
                  ${sql.json({ purpose: "branch-push", outcome: "failed" })})`
            }),
          )
          .pipe(Effect.ignore)

      const authorize: HostedRepositoriesService["authorize"] = Effect.fn("HostedRepositories.authorize")(
        function* (input) {
          if (input.setup.authoritySubject !== input.ownerId)
            return yield* failure("authorization", "GitHub installation authorization belongs to another owner")
          if (
            input.ref.trim().length === 0 ||
            input.gitIdentity.name.trim().length === 0 ||
            !/^[^\s@]+@[^\s@]+$/.test(input.gitIdentity.email)
          )
            return yield* failure("identity", "Repository ref and Git identity are required")
          const projects = yield* sql`SELECT id FROM rika_hosted_projects
            WHERE id = ${input.projectId} AND owner_id = ${input.ownerId}`.pipe(
            Effect.mapError(() => failure("database", "Could not authorize the Project repository")),
          )
          if (projects[0] === undefined) return yield* failure("authorization", "Project does not belong to the owner")
          const snapshot = yield* installations
            .reconcileInstallation(input.setup.installation.id)
            .pipe(Effect.mapError(mapGitHubError))
          if (!sameAccount(snapshot.installation.account, input.setup.installation.account))
            return yield* failure("authorization", "GitHub installation does not match the authorized owner")
          const repository = snapshot.repositories.find((candidate) => candidate.id === input.repositoryId)
          if (repository === undefined || repository.archived)
            return yield* failure("authorization", "Repository is not selected for the GitHub App installation")
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO rika_hosted_git_identities (owner_id, name, email, updated_at)
                VALUES (${input.ownerId}, ${input.gitIdentity.name.trim()}, ${input.gitIdentity.email.trim()},
                  transaction_timestamp())
                ON CONFLICT (owner_id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email,
                  updated_at = EXCLUDED.updated_at`
                yield* sql`INSERT INTO rika_hosted_project_repositories
                (project_id, owner_id, repository_id, installation_id, installation_account_id,
                  installation_account_login, installation_account_type, repository_owner, repository_name,
                  default_ref, private, created_at, updated_at)
                VALUES (${input.projectId}, ${input.ownerId}, ${String(repository.id)}, ${String(snapshot.installation.id)},
                  ${String(snapshot.installation.account.id)}, ${snapshot.installation.account.login},
                  ${snapshot.installation.account.type}, ${repository.owner.login}, ${repository.name},
                  ${input.ref.trim()}, ${repository.private}, transaction_timestamp(), transaction_timestamp())
                ON CONFLICT (project_id) DO UPDATE SET repository_id = EXCLUDED.repository_id,
                  installation_id = EXCLUDED.installation_id,
                  installation_account_id = EXCLUDED.installation_account_id,
                  installation_account_login = EXCLUDED.installation_account_login,
                  installation_account_type = EXCLUDED.installation_account_type,
                  repository_owner = EXCLUDED.repository_owner, repository_name = EXCLUDED.repository_name,
                  default_ref = EXCLUDED.default_ref, private = EXCLUDED.private, updated_at = EXCLUDED.updated_at`
              }),
            )
            .pipe(Effect.mapError(() => failure("database", "Could not persist the authorized Project repository")))
        },
      )

      const resolve: HostedRepositoriesService["resolve"] = Effect.fn("HostedRepositories.resolve")(function* (input) {
        const binding = yield* selectBinding(input.ownerId, input.projectId)
        yield* verifyBinding(binding)
        const token = yield* mint(binding, { contents: "read" })
        const ref = input.ref?.trim() || binding.defaultRef
        const request = HttpClientRequest.get(
          `${options.baseUrl ?? "https://api.github.com"}/repos/${encodeURIComponent(binding.repositoryOwner)}/${encodeURIComponent(binding.repositoryName)}/commits/${encodeURIComponent(ref)}`,
          {
            headers: {
              accept: "application/vnd.github+json",
              authorization: `Bearer ${Redacted.value(token.token)}`,
              "x-github-api-version": "2026-03-10",
            },
          },
        )
        const response = yield* client.execute(request).pipe(
          Effect.mapError(() => failure("github", "Could not resolve the repository ref")),
          Effect.ensuring(tokens.revoke(token.token).pipe(Effect.ignore)),
        )
        if (response.status < 200 || response.status >= 300)
          return yield* failure("authorization", "Repository ref is missing or unreachable")
        const commit = yield* HttpClientResponse.schemaBodyJson(Commit)(response).pipe(
          Effect.mapError(() => failure("github", "GitHub returned an invalid commit identity")),
        )
        return {
          ownerId: OwnerId.make(input.ownerId),
          projectId: input.projectId,
          repositoryId: binding.repositoryId,
          installationId: binding.installationId,
          owner: binding.repositoryOwner,
          name: binding.repositoryName,
          ref,
          commitSha: commit.sha,
          private: binding.private,
          gitIdentity: { name: binding.gitName, email: binding.gitEmail },
        }
      })

      const credential: HostedRepositoriesService["credential"] = Effect.fn("HostedRepositories.credential")(
        function* (input) {
          const assignment = yield* assignments
            .authenticate(input.access)
            .pipe(Effect.mapError(() => failure("stale-fence", "Credential request assignment fence is stale")))
          const checkout = assignment.checkout
          if (
            assignment.ownerId !== input.ownerId ||
            assignment.workspaceId !== input.workspaceId ||
            checkout === null ||
            checkout.ownerId !== input.ownerId ||
            checkout.repositoryId !== input.repositoryId
          )
            return yield* failure("authorization", "Credential request does not match the assigned repository")
          const binding = yield* selectBinding(checkout.ownerId, checkout.projectId)
          yield* verifyBinding(binding)
          if (
            binding.repositoryId !== checkout.repositoryId ||
            binding.installationId !== checkout.installationId ||
            binding.repositoryOwner !== checkout.owner ||
            binding.repositoryName !== checkout.name ||
            binding.private !== checkout.private
          )
            return yield* failure("authorization", "Assigned repository is no longer the authorized Project repository")
          let publication: PublicationCredentialRow | undefined
          let publicationId: string | undefined
          if (input.purpose === "branch-push") {
            publicationId = input.publicationId
            publication = yield* claimBranchPush(input)
          }
          let permissions: Record<string, "read" | "write"> = { contents: "read" }
          if (input.purpose === "github-read") permissions = { contents: "read", issues: "read", pull_requests: "read" }
          if (input.purpose === "branch-push") permissions = { contents: "write" }
          const next = yield* mint(binding, permissions, input.purpose === "branch-push").pipe(
            Effect.tapError(() =>
              publication === undefined || publicationId === undefined
                ? Effect.void
                : branchCredentialFailed(publicationId, publication),
            ),
          )
          const key = tokenKey(input.access, input.purpose, publicationId)
          if (publicationId === undefined) {
            const previous = issued.get(key)
            if (previous !== undefined && previous.token !== next.token)
              yield* tokens.revoke(previous.token).pipe(Effect.ignore)
            issued.set(key, next)
          } else {
            const previous = publicationTokens.get(publicationId)
            if (previous !== undefined && previous.token.token !== next.token)
              yield* tokens.revoke(previous.token.token).pipe(Effect.ignore)
            publicationTokens.set(publicationId, { key, token: next })
          }
          return {
            token: next.token,
            username: "x-access-token",
            repositoryUrl: `https://github.com/${binding.repositoryOwner}/${binding.repositoryName}.git`,
            expiresAt: next.expiresAtMillis,
          }
        },
      )

      const revoke: HostedRepositoriesService["revoke"] = Effect.fn("HostedRepositories.revoke")(
        function* (access, purpose, publicationId) {
          yield* assignments
            .authenticate(access)
            .pipe(Effect.mapError(() => failure("stale-fence", "Credential revocation assignment fence is stale")))
          if (purpose === "branch-push" && publicationId === undefined)
            return yield* failure("authorization", "Branch push credential revocation requires its approval")
          const key = tokenKey(access, purpose, publicationId)
          const publication = publicationId === undefined ? undefined : publicationTokens.get(publicationId)
          if (publication !== undefined && publication.key !== key)
            return yield* failure("authorization", "Branch push credential belongs to another assignment fence")
          const token = publicationId === undefined ? issued.get(key) : publication?.token
          if (token === undefined) return
          yield* tokens.revoke(token.token).pipe(Effect.mapError(mapGitHubError))
          if (publicationId === undefined) issued.delete(key)
          else publicationTokens.delete(publicationId)
        },
      )

      const revokePublicationCredential: HostedRepositoriesService["revokePublicationCredential"] = Effect.fn(
        "HostedRepositories.revokePublicationCredential",
      )(function* (publicationId) {
        const publication = publicationTokens.get(publicationId)
        if (publication === undefined) return
        yield* tokens.revoke(publication.token.token).pipe(Effect.mapError(mapGitHubError))
        publicationTokens.delete(publicationId)
      })

      const inspectTarget: HostedRepositoriesService["inspectTarget"] = Effect.fn("HostedRepositories.inspectTarget")(
        function* (input) {
          const binding = yield* selectBinding(input.ownerId, input.projectId)
          yield* verifyBinding(binding)
          const token = yield* mint(binding, { contents: "read" })
          return yield* targetWithToken(binding, token, input.targetRef).pipe(
            Effect.ensuring(tokens.revoke(token.token).pipe(Effect.ignore)),
          )
        },
      )

      const createPullRequest: HostedRepositoriesService["createPullRequest"] = Effect.fn(
        "HostedRepositories.createPullRequest",
      )(function* (input) {
        const binding = yield* selectBinding(input.ownerId, input.projectId)
        yield* verifyBinding(binding)
        if (binding.repositoryId !== input.repositoryId)
          return yield* failure("authorization", "Pull request repository does not match the approved repository")
        const token = yield* mint(binding, { contents: "read", pull_requests: "write" }, true)
        return yield* Effect.gen(function* () {
          const currentTarget = yield* targetWithToken(binding, token, input.target.ref)
          if (currentTarget.commitSha !== input.target.commitSha || currentTarget.protected !== input.target.protected)
            return yield* failure("authorization", "Pull request target changed after publication approval")
          const query = new URL(repositoryApiUrl(binding, "/pulls"))
          query.searchParams.set("state", "open")
          query.searchParams.set("head", `${binding.repositoryOwner}:${input.sourceBranch}`)
          query.searchParams.set("base", input.target.ref)
          const existingResponse = yield* githubRequest(
            token,
            HttpClientRequest.get(query.toString()),
            "Could not inspect existing pull requests",
          )
          if (existingResponse.status < 200 || existingResponse.status >= 300)
            return yield* failure("github", "GitHub rejected pull request inspection")
          const existing = yield* HttpClientResponse.schemaBodyJson(Schema.Array(PullRequest))(existingResponse).pipe(
            Effect.mapError(() => failure("github", "GitHub returned invalid pull request inspection")),
          )
          let pull = existing.find(
            (candidate) => candidate.head.sha === input.commitSha && candidate.base.ref === input.target.ref,
          )
          if (pull === undefined) {
            const create = HttpClientRequest.post(repositoryApiUrl(binding, "/pulls")).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                title: input.title,
                head: input.sourceBranch,
                base: input.target.ref,
                body: input.body,
              }),
            )
            const response = yield* githubRequest(token, create, "Could not create the pull request")
            if (response.status < 200 || response.status >= 300)
              return yield* failure("github", "GitHub rejected pull request creation")
            pull = yield* HttpClientResponse.schemaBodyJson(PullRequest)(response).pipe(
              Effect.mapError(() => failure("github", "GitHub returned an invalid pull request receipt")),
            )
          }
          if (pull.head.sha !== input.commitSha || pull.base.ref !== input.target.ref)
            return yield* failure("authorization", "Pull request receipt does not match the approved publication")
          return {
            number: pull.number,
            url: pull.html_url,
            commitSha: pull.head.sha,
            targetRef: pull.base.ref,
          }
        }).pipe(Effect.ensuring(tokens.revoke(token.token).pipe(Effect.ignore)))
      })

      const approvePublication: HostedRepositoriesService["approvePublication"] = Effect.fn(
        "HostedRepositories.approvePublication",
      )(function* (input) {
        const idempotencyKey = input.idempotencyKey.trim()
        const sourceCommitSha = input.commitSha.toLowerCase()
        const requestedTargetRef = input.targetRef?.trim()
        const title = input.title.trim()
        const body = input.body
        if (
          idempotencyKey.length === 0 ||
          !/^[a-f0-9]{40}$/.test(sourceCommitSha) ||
          (requestedTargetRef !== undefined && (requestedTargetRef.length === 0 || requestedTargetRef.length > 255)) ||
          title.length === 0 ||
          title.length > 256 ||
          body.length > 65_536
        )
          return yield* failure("identity", "Publication approval input is invalid")
        const existing = yield* sql<PublicationRow>`SELECT ${publicationColumns}
          FROM rika_hosted_repository_publications publication
          WHERE publication.owner_id = ${input.ownerId} AND publication.thread_id = ${input.threadId}
            AND publication.idempotency_key = ${idempotencyKey}`.pipe(
          Effect.mapError(() => failure("database", "Could not inspect the publication approval")),
        )
        if (existing[0] !== undefined) {
          const known = existing[0]
          if (
            known.actor !== null &&
            canonicalJson(known.actor) === canonicalJson(input.actor) &&
            known.sourceCommitSha === sourceCommitSha &&
            known.targetRef === (requestedTargetRef || known.targetRef) &&
            known.title === title &&
            known.body === body
          )
            return toPublication(known)
          return yield* failure("authorization", "Publication approval key was already used for another operation")
        }
        const rows = yield* sql<{
          readonly projectId: string
          readonly repositoryId: string
          readonly checkoutProjectId: string
          readonly assignmentId: string
          readonly assignmentGeneration: string
          readonly leaseEpoch: string
          readonly workspaceId: string
        }>`SELECT thread.project_id AS "projectId", repository.repository_id AS "repositoryId",
          assignment.checkout ->> 'projectId' AS "checkoutProjectId", assignment.id AS "assignmentId",
          assignment.generation::text AS "assignmentGeneration", assignment.lease_epoch::text AS "leaseEpoch",
          assignment.workspace_id AS "workspaceId"
          FROM rika_hosted_threads thread
          JOIN rika_hosted_executor_assignments assignment ON assignment.thread_id = thread.id
            AND assignment.owner_id = thread.owner_id
          JOIN rika_hosted_workspace_preparations preparation ON preparation.assignment_id = assignment.id
            AND preparation.owner_id = assignment.owner_id AND preparation.generation = assignment.generation
            AND preparation.workspace_id = assignment.workspace_id AND preparation.lease_epoch = assignment.lease_epoch
            AND preparation.state = 'ready'
          JOIN rika_hosted_project_repositories repository ON repository.project_id = thread.project_id
            AND repository.owner_id = thread.owner_id
          WHERE thread.id = ${input.threadId} AND thread.owner_id = ${input.ownerId}
            AND thread.executor_kind = 'e2b' AND thread.project_id IS NOT NULL
            AND assignment.lifecycle = 'active' AND assignment.lease_expires_at > clock_timestamp()
            AND assignment.checkout ->> 'ownerId' = thread.owner_id
            AND assignment.checkout ->> 'repositoryId' = repository.repository_id`.pipe(
          Effect.mapError(() => failure("database", "Could not load the publication fence")),
        )
        const fence = rows[0]
        if (fence === undefined || fence.checkoutProjectId !== fence.projectId)
          return yield* failure("stale-fence", "Publication requires the current prepared repository workspace")
        const sourceBranch = `rika/${input.threadId}`
        if (!/^rika\/[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/.test(sourceBranch))
          return yield* failure("identity", "Thread identity cannot be used as a publication branch")
        const binding = yield* selectBinding(input.ownerId, fence.projectId)
        yield* verifyBinding(binding)
        if (binding.repositoryId !== fence.repositoryId)
          return yield* failure("authorization", "Prepared repository no longer matches the Project")
        const targetRef = requestedTargetRef || binding.defaultRef
        if (sourceBranch === targetRef)
          return yield* failure("authorization", "Publication branch must not be the pull request target")
        const targetToken = yield* mint(binding, { contents: "read" })
        const target = yield* Effect.gen(function* () {
          const inspected = yield* targetWithToken(binding, targetToken, targetRef)
          yield* verifySourceBranch(binding, targetToken, sourceBranch)
          return inspected
        }).pipe(Effect.ensuring(tokens.revoke(targetToken.token).pipe(Effect.ignore)))
        const id = `publication-${input.threadId}-${idempotencyKey}`
        const sourceRef = `refs/heads/${sourceBranch}`
        const authority = {
          ownerId: input.ownerId,
          threadId: input.threadId,
          projectId: fence.projectId,
          repositoryId: fence.repositoryId,
          sourceBranch,
          sourceRef,
          sourceCommitSha,
          targetRef: target.ref,
          targetCommitSha: target.commitSha,
          targetProtected: target.protected,
        }
        const assignmentFence = {
          assignmentId: fence.assignmentId,
          assignmentGeneration: fence.assignmentGeneration,
          leaseEpoch: fence.leaseEpoch,
          workspaceId: fence.workspaceId,
          authorizationCheckpointId: id,
        }
        const digest = yield* authorizationDigest({
          version: 1,
          operation: "repository-publication",
          purpose: "branch-push",
          actor: input.actor,
          idempotencyKey,
          authority,
          fence: assignmentFence,
          pullRequest: { title, body },
        })
        const auditFence = { ...assignmentFence, authorizationDigest: digest }
        const inserted = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const created = yield* sql<PublicationRow>`INSERT INTO rika_hosted_repository_publications AS publication
                (id, idempotency_key, owner_id, thread_id, project_id, repository_id, actor,
                  assignment_id, assignment_generation, lease_epoch, workspace_id,
                  authorization_checkpoint_id, authorization_digest,
                  source_branch, source_ref, source_commit_sha, target_ref, target_commit_sha, target_protected,
                  pull_request_title, pull_request_body, state, approved_at, updated_at)
                SELECT ${id}, ${idempotencyKey}, ${input.ownerId}, ${input.threadId}, ${fence.projectId},
                  ${fence.repositoryId}, ${sql.json(input.actor)}, assignment.id,
                  ${fence.assignmentGeneration}::bigint, ${fence.leaseEpoch}::bigint, ${fence.workspaceId},
                  ${id}, ${digest}, ${sourceBranch}, ${sourceRef}, ${sourceCommitSha}, ${target.ref},
                  ${target.commitSha}, ${target.protected}, ${title}, ${body}, 'approved',
                  transaction_timestamp(), transaction_timestamp()
                FROM rika_hosted_executor_assignments assignment
                JOIN rika_hosted_workspace_preparations preparation ON preparation.assignment_id = assignment.id
                  AND preparation.owner_id = assignment.owner_id
                  AND preparation.generation = assignment.generation
                  AND preparation.workspace_id = assignment.workspace_id
                  AND preparation.lease_epoch = assignment.lease_epoch AND preparation.state = 'ready'
                JOIN rika_hosted_project_repositories repository ON repository.project_id = ${fence.projectId}
                  AND repository.owner_id = assignment.owner_id
                WHERE assignment.id = ${fence.assignmentId} AND assignment.owner_id = ${input.ownerId}
                  AND assignment.thread_id = ${input.threadId} AND assignment.lifecycle = 'active'
                  AND assignment.generation = ${fence.assignmentGeneration}::bigint
                  AND assignment.lease_epoch = ${fence.leaseEpoch}::bigint
                  AND assignment.workspace_id = ${fence.workspaceId}
                  AND assignment.lease_expires_at > clock_timestamp()
                  AND assignment.checkout ->> 'ownerId' = assignment.owner_id
                  AND assignment.checkout ->> 'projectId' = ${fence.projectId}
                  AND assignment.checkout ->> 'repositoryId' = ${fence.repositoryId}
                  AND assignment.checkout ->> 'installationId' = repository.installation_id
                  AND repository.repository_id = ${fence.repositoryId}
                ON CONFLICT (owner_id, thread_id, idempotency_key) DO NOTHING
                RETURNING ${publicationColumns}`
              if (created[0] === undefined)
                return yield* failure("stale-fence", "Publication assignment changed before approval")
              yield* sql`INSERT INTO rika_hosted_repository_publication_audit
                (publication_id, owner_id, thread_id, actor, action, authority, fence, result)
                VALUES (${id}, ${input.ownerId}, ${input.threadId}, ${sql.json(input.actor)}, 'approved',
                  ${sql.json(authority)}, ${sql.json(auditFence)},
                  ${sql.json({ outcome: "approved", purpose: "branch-push" })})`
              return created[0]
            }),
          )
          .pipe(
            Effect.mapError((error) =>
              Schema.is(HostedRepositoryError)(error)
                ? error
                : failure("database", "Could not persist the publication approval"),
            ),
          )
        return toPublication(inserted)
      })

      const recordPush: HostedRepositoriesService["recordPush"] = Effect.fn("HostedRepositories.recordPush")(
        function* (approved, result, state) {
          return yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const rows = yield* sql<PublicationRow>`UPDATE rika_hosted_repository_publications publication
                  SET state = ${state}, push_result = ${sql.json(result)}, updated_at = transaction_timestamp()
                  WHERE publication.id = ${approved.id} AND publication.state = 'pushing'
                    AND publication.owner_id = ${approved.ownerId} AND publication.thread_id = ${approved.threadId}
                    AND publication.repository_id = ${approved.repositoryId}
                    AND publication.assignment_id = ${approved.assignmentId}
                    AND publication.assignment_generation = ${approved.assignmentGeneration}::bigint
                    AND publication.lease_epoch = ${approved.leaseEpoch}::bigint
                    AND publication.workspace_id = ${approved.workspaceId}
                    AND publication.authorization_checkpoint_id = ${approved.authorizationCheckpointId}
                    AND publication.authorization_digest = ${approved.authorizationDigest}
                    AND publication.source_branch = ${approved.sourceBranch}
                    AND publication.source_commit_sha = ${approved.sourceCommitSha}
                  RETURNING ${publicationColumns}`
                const row = rows[0]
                if (row === undefined) return yield* failure("authorization", "Publication push result is stale")
                let action = "branch-push-failed"
                if (state === "pushed") action = "branch-push-succeeded"
                if (state === "unknown") action = "branch-push-unknown"
                yield* sql`INSERT INTO rika_hosted_repository_publication_audit
                  (publication_id, owner_id, thread_id, actor, action, authority, fence, result)
                  SELECT id, owner_id, thread_id, actor, ${action},
                    jsonb_build_object('ownerId', owner_id, 'threadId', thread_id, 'projectId', project_id,
                      'repositoryId', repository_id, 'sourceBranch', source_branch, 'sourceRef', source_ref,
                      'sourceCommitSha', source_commit_sha, 'targetRef', target_ref,
                      'targetCommitSha', target_commit_sha, 'targetProtected', target_protected),
                    jsonb_build_object('assignmentId', assignment_id,
                      'assignmentGeneration', assignment_generation::text, 'leaseEpoch', lease_epoch::text,
                      'workspaceId', workspace_id, 'authorizationCheckpointId', authorization_checkpoint_id,
                      'authorizationDigest', authorization_digest), ${sql.json(result)}
                  FROM rika_hosted_repository_publications WHERE id = ${approved.id}`
                return toPublication(row)
              }),
            )
            .pipe(
              Effect.mapError((error) =>
                Schema.is(HostedRepositoryError)(error)
                  ? error
                  : failure("database", "Could not record the publication push result"),
              ),
            )
        },
      )

      const recordPullRequest: HostedRepositoriesService["recordPullRequest"] = Effect.fn(
        "HostedRepositories.recordPullRequest",
      )(function* (approved, result, succeeded) {
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const state = succeeded ? "completed" : "failed"
              const rows = yield* sql<PublicationRow>`UPDATE rika_hosted_repository_publications publication
                SET state = ${state}, pull_request_result = ${sql.json(result)}, updated_at = transaction_timestamp()
                WHERE publication.id = ${approved.id} AND publication.state = 'pushed'
                  AND publication.source_commit_sha = ${approved.sourceCommitSha}
                  AND publication.target_ref = ${approved.target.ref}
                  AND publication.target_commit_sha = ${approved.target.commitSha}
                RETURNING ${publicationColumns}`
              const row = rows[0]
              if (row === undefined) return yield* failure("authorization", "Pull request result is stale")
              yield* sql`INSERT INTO rika_hosted_repository_publication_audit
                (publication_id, owner_id, thread_id, actor, action, authority, fence, result)
                SELECT id, owner_id, thread_id, actor,
                  ${succeeded ? "pull-request-succeeded" : "pull-request-failed"},
                  jsonb_build_object('ownerId', owner_id, 'threadId', thread_id, 'projectId', project_id,
                    'repositoryId', repository_id, 'sourceBranch', source_branch, 'sourceRef', source_ref,
                    'sourceCommitSha', source_commit_sha, 'targetRef', target_ref,
                    'targetCommitSha', target_commit_sha, 'targetProtected', target_protected),
                  jsonb_build_object('assignmentId', assignment_id,
                    'assignmentGeneration', assignment_generation::text, 'leaseEpoch', lease_epoch::text,
                    'workspaceId', workspace_id, 'authorizationCheckpointId', authorization_checkpoint_id,
                    'authorizationDigest', authorization_digest), ${sql.json(result)}
                FROM rika_hosted_repository_publications WHERE id = ${approved.id}`
              return toPublication(row)
            }),
          )
          .pipe(
            Effect.mapError((error) =>
              Schema.is(HostedRepositoryError)(error)
                ? error
                : failure("database", "Could not record the pull request result"),
            ),
          )
      })

      return HostedRepositories.of({
        authorize,
        resolve,
        credential,
        revoke,
        inspectTarget,
        createPullRequest,
        approvePublication,
        recordPush,
        recordPullRequest,
        revokePublicationCredential,
      })
    }),
  )
