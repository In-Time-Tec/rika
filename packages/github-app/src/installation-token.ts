import * as AppAuthentication from "./app-jwt"
import * as GitHub from "./github-model"
import { Clock, Context, DateTime, Effect, Layer, Option, Redacted, Schema, Semaphore } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

const RequiredPermissions = GitHub.Permissions.check(
  Schema.makeFilter((permissions) => Object.keys(permissions).length > 0 || "at least one permission is required"),
)

export const RepositoryTokenRequest = Schema.Struct({
  installationId: GitHub.PositiveInt,
  repositoryIds: GitHub.RepositoryIds,
  permissions: RequiredPermissions,
})
export type RepositoryTokenRequest = typeof RepositoryTokenRequest.Type

const InstallationTokenResponse = Schema.Struct({
  token: Schema.NonEmptyString,
  expires_at: Schema.NonEmptyString,
  permissions: GitHub.Permissions,
  repositories: Schema.optionalKey(Schema.Array(GitHub.Repository)),
})

export class InstallationTokenError extends Schema.TaggedError<InstallationTokenError>()(
  "GitHubInstallationTokenError",
  {
    reason: Schema.Literals(["input", "authentication", "transport", "response", "scope"]),
    operation: Schema.String,
    status: Schema.optionalKey(Schema.Int),
    message: Schema.String,
  },
) {}

export interface RepositoryToken {
  readonly token: Redacted.Redacted<string>
  readonly expiresAtMillis: number
  readonly installationId: number
  readonly repositoryIds: ReadonlyArray<number>
  readonly permissions: GitHub.Permissions
}

export interface InstallationTokenService {
  readonly mint: (request: RepositoryTokenRequest) => Effect.Effect<RepositoryToken, InstallationTokenError>
  readonly revoke: (token: Redacted.Redacted<string>) => Effect.Effect<void, InstallationTokenError>
}

export class InstallationToken extends Context.Service<InstallationToken, InstallationTokenService>()(
  "@rika/github-app/installation-token/InstallationToken",
) {}

export interface InstallationTokenOptions {
  readonly baseUrl?: string
  readonly apiVersion?: string
}

interface CacheEntry {
  readonly value: RepositoryToken
  readonly usableUntilMillis: number
}

const failure = (reason: InstallationTokenError["reason"], operation: string, message: string, status?: number) =>
  InstallationTokenError.make({ reason, operation, message, ...(status === undefined ? {} : { status }) })

const canonicalPermissions = (permissions: GitHub.Permissions) =>
  Object.entries(permissions).sort(([left], [right]) => left.localeCompare(right))

const canonicalRepositoryIds = (repositoryIds: ReadonlyArray<number>) =>
  [...new Set(repositoryIds)].sort((a, b) => a - b)

const cacheKey = (request: RepositoryTokenRequest) =>
  JSON.stringify([
    request.installationId,
    canonicalRepositoryIds(request.repositoryIds),
    canonicalPermissions(request.permissions),
  ])

const expiresAtMillis = (value: string) =>
  Option.match(DateTime.make(value), {
    onNone: () => Effect.fail(failure("response", "mint repository token", "GitHub returned an invalid expiry")),
    onSome: (dateTime) => Effect.succeed(DateTime.toEpochMillis(dateTime)),
  })

const verifyScope = (
  request: RepositoryTokenRequest,
  response: typeof InstallationTokenResponse.Type,
): Effect.Effect<void, InstallationTokenError> =>
  Effect.gen(function* () {
    const requestedIds = canonicalRepositoryIds(request.repositoryIds)
    const returnedIds = response.repositories?.map((repository) => repository.id).sort((a, b) => a - b)
    if (
      returnedIds === undefined ||
      returnedIds.length !== requestedIds.length ||
      returnedIds.some((repositoryId, index) => repositoryId !== requestedIds[index])
    ) {
      return yield* failure("scope", "mint repository token", "GitHub returned a different repository scope")
    }
    for (const [permission, level] of Object.entries(response.permissions)) {
      const expected = request.permissions[permission]
      if (expected === level || (permission === "metadata" && expected === undefined && level === "read")) continue
      return yield* failure("scope", "mint repository token", "GitHub returned broader permissions")
    }
    for (const [permission, level] of Object.entries(request.permissions)) {
      if (response.permissions[permission] === level) continue
      return yield* failure("scope", "mint repository token", "GitHub omitted a required permission")
    }
  })

export const installationTokenLayer = (options: InstallationTokenOptions = {}) =>
  Layer.effect(
    InstallationToken,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const appJwt = yield* AppAuthentication.AppJwt
      const admission = yield* Semaphore.make(1)
      const cache = new Map<string, CacheEntry>()
      const mint = Effect.fn("GitHubInstallationToken.mint")(function* (untrustedRequest: RepositoryTokenRequest) {
        const request = yield* Schema.decodeUnknownEffect(RepositoryTokenRequest)(untrustedRequest).pipe(
          Effect.mapError(() => failure("input", "mint repository token", "Repository token scope is invalid")),
        )
        const repositoryIds = canonicalRepositoryIds(request.repositoryIds)
        const normalizedRequest = { ...request, repositoryIds }
        const key = cacheKey(normalizedRequest)
        return yield* admission.withPermits(1)(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            for (const [cachedKey, entry] of cache) {
              if (now >= entry.usableUntilMillis) cache.delete(cachedKey)
            }
            const cached = cache.get(key)
            if (cached !== undefined) return cached.value
            const jwt = yield* appJwt.sign.pipe(
              Effect.mapError(() => failure("authentication", "mint repository token", "App authentication failed")),
            )
            const httpRequest = HttpClientRequest.post(
              `${options.baseUrl ?? "https://api.github.com"}/app/installations/${request.installationId}/access_tokens`,
              {
                headers: {
                  accept: "application/vnd.github+json",
                  authorization: `Bearer ${Redacted.value(jwt)}`,
                  "x-github-api-version": options.apiVersion ?? "2026-03-10",
                },
              },
            ).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                repository_ids: repositoryIds,
                permissions: request.permissions,
              }),
            )
            const httpResponse = yield* client
              .execute(httpRequest)
              .pipe(Effect.mapError(() => failure("transport", "mint repository token", "GitHub request failed")))
            if (httpResponse.status < 200 || httpResponse.status >= 300) {
              return yield* failure(
                httpResponse.status === 401 || httpResponse.status === 403 ? "authentication" : "response",
                "mint repository token",
                "GitHub rejected the repository token request",
                httpResponse.status,
              )
            }
            const response = yield* HttpClientResponse.schemaBodyJson(InstallationTokenResponse)(httpResponse).pipe(
              Effect.mapError(() =>
                failure("response", "mint repository token", "GitHub returned an invalid response"),
              ),
            )
            yield* verifyScope(normalizedRequest, response)
            const expiry = yield* expiresAtMillis(response.expires_at)
            if (expiry <= now) {
              return yield* failure("response", "mint repository token", "GitHub returned an expired token")
            }
            if (expiry - now > 60 * 60 * 1_000) {
              return yield* failure(
                "scope",
                "mint repository token",
                "GitHub returned a token lasting longer than one hour",
              )
            }
            const value: RepositoryToken = {
              token: Redacted.make(response.token),
              expiresAtMillis: expiry,
              installationId: request.installationId,
              repositoryIds,
              permissions: request.permissions,
            }
            const usableUntilMillis = expiry - 5 * 60 * 1_000
            if (now < usableUntilMillis) cache.set(key, { value, usableUntilMillis })
            return value
          }),
        )
      })
      const revoke = Effect.fn("GitHubInstallationToken.revoke")(function* (token: Redacted.Redacted<string>) {
        const request = HttpClientRequest.delete(`${options.baseUrl ?? "https://api.github.com"}/installation/token`, {
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${Redacted.value(token)}`,
            "x-github-api-version": options.apiVersion ?? "2026-03-10",
          },
        })
        const response = yield* client
          .execute(request)
          .pipe(Effect.mapError(() => failure("transport", "revoke repository token", "GitHub request failed")))
        if (response.status !== 204 && response.status !== 404) {
          return yield* failure(
            response.status === 401 || response.status === 403 ? "authentication" : "response",
            "revoke repository token",
            "GitHub rejected repository token revocation",
            response.status,
          )
        }
        for (const [key, entry] of cache) if (entry.value.token === token) cache.delete(key)
      })
      return InstallationToken.of({ mint, revoke })
    }),
  )
