/* oxlint-disable effecttsgo/strict-effect-provide -- the repository-scoped transport layer is built per freshly minted installation token inside the acquire/release boundary. */
import type { InstallationError, InstallationService } from "@rika/github-app/installation-service"
import type { InstallationTokenError, InstallationTokenService } from "@rika/github-app/installation-token"
import { RepositoryCheckout } from "@rika/product/executor-assignment"
import type { RepositoryBinding, RepositoryStoreError, RepositoryStoreService } from "@rika/product-store/repositories"
import { Effect, Redacted, Schema, Stream } from "effect"
import { Pins } from "generalist"
import * as RepositoryInput from "@rika/workspace-input/repository"
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http"
import { ProductControlError, type ProductControlOptions } from "./control"

export interface ProductRepositoriesOptions {
  readonly store: Pick<RepositoryStoreService, "loadBinding">
  readonly installations: Pick<InstallationService, "reconcileInstallation">
  readonly tokens: Pick<InstallationTokenService, "mint" | "revoke">
  readonly http: HttpClient.HttpClient
  readonly baseUrl?: string
}

const Commit = Schema.Struct({ sha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)) })
const maximumCommitResponseBytes = 1_048_576
const requestTimeout = "10 seconds"

const failure = (kind: ProductControlError["kind"], message: string) => ProductControlError.make({ kind, message })
const forbidden = () => failure("forbidden", "Project repository is not authorized")
const unavailable = () => failure("unavailable", "Repository checkout is unavailable")
const invalid = () => failure("invalid", "Repository checkout configuration is invalid")

const mapStoreError = (error: RepositoryStoreError) => (error.reason === "database" ? unavailable() : forbidden())
const mapInstallationError = (error: InstallationError) =>
  error.reason === "transport" || error.reason === "response" ? unavailable() : forbidden()
const mapTokenError = (error: InstallationTokenError) =>
  error.reason === "transport" || error.reason === "response" ? unavailable() : forbidden()

const sanitizeDefect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.catchDefect(() => Effect.fail(unavailable())))

const verifiedBaseUrl = (configured: string | undefined): string | undefined => {
  try {
    const parsed = new URL(configured ?? "https://api.github.com")
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname.length === 0 ||
      parsed.username.length !== 0 ||
      parsed.password.length !== 0 ||
      parsed.search.length !== 0 ||
      parsed.hash.length !== 0
    )
      return undefined
    return parsed.toString().replace(/\/$/, "")
  } catch {
    return undefined
  }
}

const numericIdentity = (value: string): number | undefined => {
  const decoded = Number(value)
  return Number.isSafeInteger(decoded) && decoded > 0 && String(decoded) === value ? decoded : undefined
}

interface BodyState {
  readonly chunks: Uint8Array[]
  readonly total: number
}

const verifyBinding = (binding: RepositoryBinding, input: { readonly ownerId: string; readonly projectId: string }) =>
  Effect.gen(function* () {
    if (
      binding.ownerId !== input.ownerId ||
      binding.projectId !== input.projectId ||
      binding.defaultRef.trim() !== binding.defaultRef ||
      binding.defaultRef.length === 0
    )
      return yield* forbidden()
    const installationId = numericIdentity(binding.installationId)
    const repositoryId = numericIdentity(binding.repositoryId)
    if (installationId === undefined || repositoryId === undefined) return yield* forbidden()
    return { installationId, repositoryId }
  })

const checkoutFromBinding = (
  binding: RepositoryBinding,
  input: { readonly ownerId: string; readonly projectId: string },
) =>
  Schema.decodeEffect(RepositoryCheckout)({
    ownerId: input.ownerId,
    projectId: input.projectId,
    repositoryId: binding.repositoryId,
    installationId: binding.installationId,
    owner: binding.repositoryOwner,
    name: binding.repositoryName,
    ref: binding.defaultRef,
    commitSha: "0".repeat(40),
    private: binding.private,
    gitIdentity: { name: binding.gitName, email: binding.gitEmail },
  }).pipe(Effect.mapError(forbidden))

const verifyInstallation = (
  options: ProductRepositoriesOptions,
  binding: RepositoryBinding,
  installationId: number,
  repositoryId: number,
) =>
  options.installations.reconcileInstallation(installationId).pipe(
    Effect.mapError(mapInstallationError),
    sanitizeDefect,
    Effect.flatMap((snapshot) => {
      const installation = snapshot.installation
      if (
        installation.id !== installationId ||
        (installation.suspended_at !== undefined && installation.suspended_at !== null) ||
        String(installation.account.id) !== binding.accountId ||
        installation.account.login.toLowerCase() !== binding.accountLogin.toLowerCase() ||
        installation.account.type !== binding.accountType
      )
        return Effect.fail(forbidden())
      const repository = snapshot.repositories.find((candidate) => candidate.id === repositoryId)
      if (
        repository === undefined ||
        repository.archived ||
        repository.owner.login.toLowerCase() !== binding.repositoryOwner.toLowerCase() ||
        repository.name.toLowerCase() !== binding.repositoryName.toLowerCase() ||
        repository.full_name.toLowerCase() !== `${binding.repositoryOwner}/${binding.repositoryName}`.toLowerCase() ||
        repository.private !== binding.private
      )
        return Effect.fail(forbidden())
      return Effect.succeed(repository)
    }),
  )

const boundedCommit = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    const contentLength = response.headers["content-length"]
    if (contentLength !== undefined) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(contentLength)) return yield* unavailable()
      const declaredBytes = Number(contentLength)
      if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maximumCommitResponseBytes)
        return yield* unavailable()
    }
    const body = yield* response.stream.pipe(
      Stream.runFoldEffect(
        (): BodyState => ({ chunks: [], total: 0 }),
        (state, chunk) => {
          if (state.total > maximumCommitResponseBytes - chunk.byteLength) return Effect.fail(unavailable())
          state.chunks.push(chunk)
          return Effect.succeed({ chunks: state.chunks, total: state.total + chunk.byteLength })
        },
      ),
      Effect.timeout(requestTimeout),
      Effect.mapError(() => unavailable()),
      sanitizeDefect,
    )
    if (contentLength !== undefined && body.total !== Number(contentLength)) return yield* unavailable()
    const bytes = new Uint8Array(body.total)
    let offset = 0
    for (const chunk of body.chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: unavailable,
    })
    return yield* Schema.decodeEffect(Schema.fromJsonString(Commit))(text).pipe(Effect.mapError(unavailable))
  })

const revoke = (tokens: ProductRepositoriesOptions["tokens"], token: Redacted.Redacted<string>) =>
  sanitizeDefect(tokens.revoke(token)).pipe(Effect.ignore)

export const makeProductRepositories = (options: ProductRepositoriesOptions) => {
  const baseUrl = verifiedBaseUrl(options.baseUrl)
  const resolver: ProductControlOptions["repositories"] = {
    resolve: Effect.fn("Rika.ProductRepositories.resolve")(function* (input) {
      if (baseUrl === undefined) return yield* invalid()
      const binding = yield* options.store
        .loadBinding(input.ownerId, input.projectId)
        .pipe(Effect.mapError(mapStoreError), sanitizeDefect)
      const { installationId, repositoryId } = yield* verifyBinding(binding, input)
      const checkout = yield* checkoutFromBinding(binding, input)
      yield* verifyInstallation(options, binding, installationId, repositoryId)
      const commit = yield* Effect.acquireUseRelease(
        options.tokens
          .mint({
            installationId,
            repositoryIds: [repositoryId],
            permissions: { contents: "read" },
            fresh: true,
          })
          .pipe(Effect.mapError(mapTokenError), sanitizeDefect),
        (scoped) => {
          const request = HttpClientRequest.get(
            `${baseUrl}/repos/${encodeURIComponent(binding.repositoryOwner)}/${encodeURIComponent(binding.repositoryName)}/commits/${encodeURIComponent(binding.defaultRef)}`,
            {
              headers: {
                accept: "application/vnd.github+json",
                authorization: `Bearer ${Redacted.value(scoped.token)}`,
                "x-github-api-version": "2026-03-10",
              },
            },
          )
          return sanitizeDefect(options.http.execute(request)).pipe(
            Effect.timeout(requestTimeout),
            Effect.mapError(() => unavailable()),
            Effect.flatMap((response) =>
              response.status >= 200 && response.status < 300 ? boundedCommit(response) : Effect.fail(forbidden()),
            ),
          )
        },
        (scoped) => revoke(options.tokens, scoped.token),
      )
      return yield* Schema.encodeEffect(RepositoryCheckout)({ ...checkout, commitSha: commit.sha }).pipe(
        Effect.mapError(unavailable),
      )
    }),
  }
  const capture = Effect.fn("Rika.ProductRepositories.capture")(function* (input: RepositoryCheckout) {
    const checkout = yield* Schema.decodeEffect(RepositoryCheckout)(input).pipe(Effect.mapError(invalid))
    const authorize = Effect.fn("Rika.ProductRepositories.authorizeInput")(function* () {
      const binding = yield* options.store.loadBinding(checkout.ownerId, checkout.projectId).pipe(
        Effect.mapError(mapStoreError), sanitizeDefect,
      )
      const identity = yield* verifyBinding(binding, checkout)
      const expected = yield* checkoutFromBinding(binding, checkout)
      if (Pins.digest({ ...expected, commitSha: checkout.commitSha }) !== Pins.digest(checkout))
        return yield* forbidden()
      yield* verifyInstallation(options, binding, identity.installationId, identity.repositoryId)
      return identity
    })
    const identity = yield* authorize()
    return yield* Effect.acquireUseRelease(
      options.tokens.mint({
        installationId: identity.installationId,
        repositoryIds: [identity.repositoryId],
        permissions: { contents: "read" },
        fresh: true,
      }).pipe(Effect.mapError(mapTokenError), sanitizeDefect),
      (scoped) => RepositoryInput.captureRepositoryInput({
        metadata: {
          version: 1,
          source: { owner: checkout.owner, name: checkout.name },
          commitSha: checkout.commitSha,
          gitIdentity: checkout.gitIdentity,
        },
      }).pipe(
        Effect.provide(RepositoryInput.layerGitHubRepositoryTransport({ token: scoped.token })),
        Effect.mapError(unavailable),
        Effect.tap(() => authorize()),
      ),
      (scoped) => revoke(options.tokens, scoped.token),
    )
  })
  return { ...resolver, capture }
}
