import { sameAccount } from "@rika/github-app/github-model"
import { Installation } from "@rika/github-app/installation-service"
import { InstallationToken, type RepositoryToken } from "@rika/github-app/installation-token"
import { ExecutorAssignments } from "@rika/product/executor-assignments"
import { OwnerId } from "@rika/product/hosted-model"
import { layer as repositoryStoreLayer, RepositoryStore, RepositoryStoreError } from "@rika/product-store/repositories"
import type { Publication as StoredPublication, RepositoryBinding } from "@rika/product-store/repositories"
import { Crypto, Effect, Encoding, Layer, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { HostedRepositories, HostedRepositoryError } from "./repository-contract"
import type { CredentialRequest, HostedRepositoriesService } from "./repository-contract"
import { assignedCheckout, bindingMatchesCheckout, permissionsFor, tokenKey } from "./repository-credentials"
import {
  canonicalJson,
  isSameApproval,
  isValidApproval,
  normalizeApproval,
  toPublication,
  toPublicationTransition,
} from "./repository-publication"
import { createPullRequestWithToken } from "./repository-pull-request"

export * from "./repository-contract"

const Commit = Schema.Struct({ sha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)) })
const Branch = Schema.Struct({
  name: Schema.NonEmptyString,
  protected: Schema.Boolean,
  commit: Commit,
})
const mapGitHubError = () => failure("github", "GitHub repository authorization failed")
const mapStoreError = (error: RepositoryStoreError) => failure(error.reason, error.message)
const failure = (reason: HostedRepositoryError["reason"], message: string) =>
  HostedRepositoryError.make({ reason, message })
const ignoreRevocationFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tapError((cause) => Effect.logWarning("github-token.revoke-replaced-failed", { cause: String(cause) })),
    Effect.ignore,
  )
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
          const checkout = assignedCheckout({ assignment, input })
          if (checkout === undefined)
            return yield* failure("authorization", "Credential request does not match the assigned repository")
          const binding = yield* selectBinding(checkout.ownerId, checkout.projectId)
          yield* verifyBinding(binding)
          if (!bindingMatchesCheckout({ binding, checkout }))
            return yield* failure("authorization", "Assigned repository is no longer the authorized Project repository")
          let publication: StoredPublication | undefined
          let publicationId: string | undefined
          if (input.purpose === "branch-push") {
            publicationId = input.publicationId
            publication = yield* claimBranchPush(input)
          }
          const next = yield* mint(binding, permissionsFor(input.purpose), input.purpose === "branch-push").pipe(
            Effect.tapError(() =>
              publication === undefined || publicationId === undefined
                ? Effect.void
                : branchCredentialFailed(publicationId, publication),
            ),
          )
          const key = tokenKey({ access: input.access, purpose: input.purpose, publicationId })
          if (publicationId === undefined) {
            const previous = issued.get(key)
            if (previous !== undefined && previous.token !== next.token)
              yield* ignoreRevocationFailure(tokens.revoke(previous.token))
            issued.set(key, next)
          } else {
            const previous = publicationTokens.get(publicationId)
            if (previous !== undefined && previous.token.token !== next.token)
              yield* ignoreRevocationFailure(tokens.revoke(previous.token.token))
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
          const key = tokenKey({ access, purpose, publicationId })
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
        return yield* createPullRequestWithToken(input, binding, token, options.baseUrl, (targetRef) =>
          targetWithToken(binding, token, targetRef),
        ).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.ensuring(tokens.revoke(token.token).pipe(Effect.ignore)),
        )
      })

      const approvePublication: HostedRepositoriesService["approvePublication"] = Effect.fn(
        "HostedRepositories.approvePublication",
      )(function* (input) {
        const { idempotencyKey, sourceCommitSha, requestedTargetRef, title, body } = normalizeApproval(input)
        if (!isValidApproval({ idempotencyKey, sourceCommitSha, requestedTargetRef, title, body }))
          return yield* failure("identity", "Publication approval input is invalid")
        const existing = yield* store
          .findPublication(input.ownerId, input.threadId, idempotencyKey)
          .pipe(Effect.mapError(mapStoreError))
        if (existing !== undefined) {
          if (
            isSameApproval({
              known: existing,
              input,
              approval: { idempotencyKey, sourceCommitSha, requestedTargetRef, title, body },
            })
          )
            return toPublication(existing)
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
          const recorded = yield* store
            .recordPush(toPublicationTransition(approved), result, state)
            .pipe(Effect.mapError(mapStoreError))
          return toPublication(recorded)
        },
      )
      const recordPullRequest: HostedRepositoriesService["recordPullRequest"] = Effect.fn(
        "HostedRepositories.recordPullRequest",
      )(function* (approved, result, succeeded) {
        const recorded = yield* store
          .recordPullRequest(toPublicationTransition(approved), result, succeeded)
          .pipe(Effect.mapError(mapStoreError))
        return toPublication(recorded)
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
