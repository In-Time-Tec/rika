import type { ValidatedSetup } from "@rika/github-app/authorization-state"
import { sameAccount } from "@rika/github-app/github-model"
import { Installation } from "@rika/github-app/installation-service"
import { InstallationToken, type RepositoryToken } from "@rika/github-app/installation-token"
import type { RepositoryCheckout } from "@rika/product/executor-assignment"
import { ExecutorAssignments, type Access } from "@rika/product/executor-assignments"
import {
  OwnerId,
  type ActorAttribution,
  type AssignmentLeaseEpoch,
  type FencingGeneration,
} from "@rika/product/hosted-model"
import {
  layer as repositoryStoreLayer,
  RepositoryStore,
  type Publication as StoredPublication,
  type PublicationTransition,
  type RepositoryBinding,
  RepositoryStoreError,
} from "@rika/product-store/repositories"
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

type InstallationPermissions =
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
  "@rika/api/hosted/repositories/HostedRepositories",
) {}

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
const mapStoreError = (error: RepositoryStoreError) => failure(error.reason, error.message)
type CanonicalValue = Schema.Json | ActorAttribution

const canonicalJson = (value: CanonicalValue): string => {
  if (Schema.is(Schema.Array(Schema.Json))(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (Schema.is(Schema.Record(Schema.String, Schema.Json))(value))
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
      const store = yield* RepositoryStore
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

      const authorizationDigest = Effect.fn("HostedRepositories.authorizationDigest")(function* (value: Schema.Json) {
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
        return yield* store.loadBinding(ownerId, projectId).pipe(Effect.mapError(mapStoreError))
      })

      const verifyBinding = Effect.fn("HostedRepositories.verifyBinding")(function* (binding: RepositoryBinding) {
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

      const mint = (binding: RepositoryBinding, permissions: Record<string, "read" | "write">, fresh = false) =>
        tokens
          .mint({
            installationId: Number(binding.installationId),
            repositoryIds: [Number(binding.repositoryId)],
            permissions,
            fresh,
          })
          .pipe(Effect.mapError(mapGitHubError))

      const repositoryApiUrl = (binding: RepositoryBinding, path: string) =>
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
        binding: RepositoryBinding,
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
        binding: RepositoryBinding,
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

      const toPublication = (row: StoredPublication): ApprovedPublication => ({
        id: row.id,
        ownerId: row.ownerId,
        threadId: row.threadId,
        projectId: row.projectId,
        repositoryId: row.repositoryId,
        assignmentId: row.assignmentId,
        assignmentGeneration: row.assignmentGeneration,
        leaseEpoch: row.leaseEpoch,
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
      const toPublicationTransition = (publication: ApprovedPublication): PublicationTransition => ({
        ...publication,
        targetRef: publication.target.ref,
        targetCommitSha: publication.target.commitSha,
        targetProtected: publication.target.protected,
        title: publication.title,
        body: publication.body,
      })

      const claimBranchPush = Effect.fn("HostedRepositories.claimBranchPush")(function* (
        input: Extract<CredentialRequest, { readonly purpose: "branch-push" }>,
      ) {
        return yield* store
          .claimPush({
            ...input,
            access: {
              assignmentGeneration: input.access.assignmentGeneration,
              leaseEpoch: input.access.leaseEpoch,
              providerInstanceId: input.access.providerInstanceId,
              executorInstanceId: input.access.executorInstanceId,
              processIncarnation: input.access.processIncarnation,
              sessionDigest: Redacted.value(input.access.presentedSessionCredentialDigest),
            },
          })
          .pipe(Effect.mapError(mapStoreError))
      })

      const branchCredentialFailed = (_publicationId: string, publication: StoredPublication) =>
        store.failCredential(publication)

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
          if (!(yield* store.projectBelongsTo(input.projectId, input.ownerId).pipe(Effect.mapError(mapStoreError))))
            return yield* failure("authorization", "Project does not belong to the owner")
          const snapshot = yield* installations
            .reconcileInstallation(input.setup.installation.id)
            .pipe(Effect.mapError(mapGitHubError))
          if (!sameAccount(snapshot.installation.account, input.setup.installation.account))
            return yield* failure("authorization", "GitHub installation does not match the authorized owner")
          const repository = snapshot.repositories.find((candidate) => candidate.id === input.repositoryId)
          if (repository === undefined || repository.archived)
            return yield* failure("authorization", "Repository is not selected for the GitHub App installation")
          yield* store
            .saveBinding({
              projectId: input.projectId,
              ownerId: input.ownerId,
              repositoryId: String(repository.id),
              installationId: String(snapshot.installation.id),
              accountId: String(snapshot.installation.account.id),
              accountLogin: snapshot.installation.account.login,
              accountType: snapshot.installation.account.type,
              repositoryOwner: repository.owner.login,
              repositoryName: repository.name,
              defaultRef: input.ref.trim(),
              private: repository.private,
              gitName: input.gitIdentity.name.trim(),
              gitEmail: input.gitIdentity.email.trim(),
            })
            .pipe(Effect.mapError(mapStoreError))
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
          let publication: StoredPublication | undefined
          let publicationId: string | undefined
          if (input.purpose === "branch-push") {
            publicationId = input.publicationId
            publication = yield* claimBranchPush(input)
          }
          let permissions: InstallationPermissions = { contents: "read" }
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
        const existing = yield* store
          .findPublication(input.ownerId, input.threadId, idempotencyKey)
          .pipe(Effect.mapError(mapStoreError))
        if (existing !== undefined) {
          const known = existing
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
        const fence = yield* store
          .loadPublicationFence(input.ownerId, input.threadId)
          .pipe(Effect.mapError(mapStoreError))
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
        const inserted = yield* store
          .createPublication({
            id,
            idempotencyKey,
            actor: input.actor,
            ownerId: input.ownerId,
            threadId: input.threadId,
            projectId: fence.projectId,
            repositoryId: fence.repositoryId,
            assignmentId: fence.assignmentId,
            assignmentGeneration: fence.assignmentGeneration,
            leaseEpoch: fence.leaseEpoch,
            workspaceId: fence.workspaceId,
            authorizationCheckpointId: id,
            authorizationDigest: digest,
            sourceBranch,
            sourceRef,
            sourceCommitSha,
            targetRef: target.ref,
            targetCommitSha: target.commitSha,
            targetProtected: target.protected,
            title,
            body,
            state: "approved",
            pushResult: null,
            pullRequestResult: null,
            authority,
            fence: auditFence,
            auditResult: { outcome: "approved", purpose: "branch-push" },
          })
          .pipe(Effect.mapError(mapStoreError))
        return toPublication(inserted)
      })

      const recordPush: HostedRepositoriesService["recordPush"] = Effect.fn("HostedRepositories.recordPush")(
        function* (approved, result, state) {
          return toPublication(
            yield* store.recordPush(toPublicationTransition(approved), result, state).pipe(Effect.mapError(mapStoreError)),
          )
        },
      )

      const recordPullRequest: HostedRepositoriesService["recordPullRequest"] = Effect.fn(
        "HostedRepositories.recordPullRequest",
      )(function* (approved, result, succeeded) {
        return toPublication(
          yield* store
            .recordPullRequest(toPublicationTransition(approved), result, succeeded)
            .pipe(Effect.mapError(mapStoreError)),
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
  ).pipe(Layer.provide(repositoryStoreLayer))
