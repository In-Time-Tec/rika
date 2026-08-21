import * as PgClient from "@effect/sql-pg/PgClient"
import type { ValidatedSetup } from "@rika/github-app/authorization-state"
import { sameAccount } from "@rika/github-app/github-model"
import { Installation } from "@rika/github-app/installation-service"
import { InstallationToken, type RepositoryToken } from "@rika/github-app/installation-token"
import type { RepositoryCheckout } from "@rika/product/executor-assignment"
import { ExecutorAssignments, type Access } from "@rika/product/executor-assignments"
import { OwnerId } from "@rika/product/hosted-model"
import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

export const CredentialPurpose = Schema.Literals(["git-read", "github-read"])
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

export interface CredentialRequest {
  readonly access: Access
  readonly ownerId: string
  readonly workspaceId: string
  readonly repositoryId: string
  readonly purpose: CredentialPurpose
}

export interface HostedRepositoriesService {
  readonly authorize: (input: AuthorizeRepositoryInput) => Effect.Effect<void, HostedRepositoryError>
  readonly resolve: (input: {
    readonly ownerId: string
    readonly projectId: string
    readonly ref?: string
  }) => Effect.Effect<RepositoryCheckout, HostedRepositoryError>
  readonly credential: (input: CredentialRequest) => Effect.Effect<RepositoryCredential, HostedRepositoryError>
  readonly revoke: (access: Access, purpose: CredentialPurpose) => Effect.Effect<void, HostedRepositoryError>
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
function failure(reason: HostedRepositoryError["reason"], message: string) {
  return HostedRepositoryError.make({ reason, message })
}
const mapGitHubError = () => failure("github", "GitHub repository authorization failed")
const tokenKey = (access: Access, purpose: CredentialPurpose) =>
  `${access.assignmentId}:${access.assignmentGeneration}:${access.leaseEpoch}:${purpose}`

export const layer = (options: { readonly baseUrl?: string } = {}) =>
  Layer.effect(
    HostedRepositories,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const installations = yield* Installation
      const tokens = yield* InstallationToken
      const assignments = yield* ExecutorAssignments
      const client = yield* HttpClient.HttpClient
      const issued = new Map<string, RepositoryToken>()
      yield* Effect.addFinalizer(() =>
        Effect.forEach(issued.values(), (token) => tokens.revoke(token.token).pipe(Effect.ignore), {
          discard: true,
          concurrency: 4,
        }),
      )

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

      const mint = (binding: BindingRow, permissions: Record<string, "read">) =>
        tokens
          .mint({
            installationId: Number(binding.installationId),
            repositoryIds: [Number(binding.repositoryId)],
            permissions,
          })
          .pipe(Effect.mapError(mapGitHubError))

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
          const permissions =
            input.purpose === "git-read"
              ? { contents: "read" as const }
              : { contents: "read" as const, issues: "read" as const, pull_requests: "read" as const }
          const next = yield* mint(binding, permissions)
          const key = tokenKey(input.access, input.purpose)
          const previous = issued.get(key)
          if (previous !== undefined && previous.token !== next.token)
            yield* tokens.revoke(previous.token).pipe(Effect.ignore)
          issued.set(key, next)
          return {
            token: next.token,
            username: "x-access-token",
            repositoryUrl: `https://github.com/${binding.repositoryOwner}/${binding.repositoryName}.git`,
            expiresAt: next.expiresAtMillis,
          }
        },
      )

      const revoke: HostedRepositoriesService["revoke"] = Effect.fn("HostedRepositories.revoke")(
        function* (access, purpose) {
          yield* assignments
            .authenticate(access)
            .pipe(Effect.mapError(() => failure("stale-fence", "Credential revocation assignment fence is stale")))
          const key = tokenKey(access, purpose)
          const token = issued.get(key)
          if (token === undefined) return
          yield* tokens.revoke(token.token).pipe(Effect.mapError(mapGitHubError))
          issued.delete(key)
        },
      )

      return HostedRepositories.of({ authorize, resolve, credential, revoke })
    }),
  )
