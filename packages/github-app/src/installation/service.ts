import * as AppAuthentication from "../auth/jwt"
import * as GitHub from "../model"
import { Clock, Context, Effect, Layer, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

const InventoryTokenResponse = Schema.Struct({
  token: Schema.NonEmptyString,
  expires_at: Schema.NonEmptyString,
})

const RepositoryPage = Schema.Struct({
  total_count: Schema.Natural,
  repositories: Schema.Array(GitHub.Repository),
})

export class InstallationError extends Schema.TaggedError<InstallationError>()("GitHubInstallationError", {
  reason: Schema.Literals([
    "input",
    "authentication",
    "not_found",
    "suspended",
    "transport",
    "response",
    "app_mismatch",
  ]),
  operation: Schema.String,
  installationId: Schema.Int,
  status: Schema.optionalKey(Schema.Int),
  message: Schema.String,
}) {}

export interface InstallationSnapshot {
  readonly installation: GitHub.Installation
  readonly repositories: ReadonlyArray<GitHub.Repository>
  readonly reconciledAtMillis: number
}

export interface InstallationService {
  readonly verifyInstallation: (installationId: number) => Effect.Effect<GitHub.Installation, InstallationError>
  readonly listRepositories: (
    installationId: number,
  ) => Effect.Effect<ReadonlyArray<GitHub.Repository>, InstallationError>
  readonly reconcileInstallation: (installationId: number) => Effect.Effect<InstallationSnapshot, InstallationError>
}

export class Installation extends Context.Service<Installation, InstallationService>()(
  "@rika/github-app/installation/service/Installation",
) {}

export interface InstallationOptions {
  readonly appId: number
  readonly baseUrl?: string
  readonly apiVersion?: string
}

const failure = (
  reason: InstallationError["reason"],
  operation: string,
  installationId: number,
  message: string,
  status?: number,
) => {
  if (status === undefined) return InstallationError.make({ reason, operation, installationId, message })
  return InstallationError.make({ reason, operation, installationId, message, status })
}

const responseReason = (status: number): InstallationError["reason"] => {
  if (status === 401 || status === 403) return "authentication"
  if (status === 404) return "not_found"
  return "response"
}

export const installationLayer = (options: InstallationOptions) =>
  Layer.effect(
    Installation,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const appJwt = yield* AppAuthentication.AppJwt
      const baseUrl = options.baseUrl ?? "https://api.github.com"
      const headers = (authorization: string) => ({
        accept: "application/vnd.github+json",
        authorization: `Bearer ${authorization}`,
        "x-github-api-version": options.apiVersion ?? "2026-03-10",
      })
      const appAuthorization = Effect.fn("GitHubInstallation.appAuthorization")(function* (
        operation: string,
        installationId: number,
      ) {
        return yield* appJwt.sign.pipe(
          Effect.map(Redacted.value),
          Effect.mapError(() => failure("authentication", operation, installationId, "App authentication failed")),
        )
      })
      const verifyInstallation = Effect.fn("GitHubInstallation.verifyInstallation")(function* (installationId: number) {
        const id = yield* Schema.decodeEffect(GitHub.PositiveInt)(installationId).pipe(
          Effect.mapError(() => failure("input", "verify installation", installationId, "Installation ID is invalid")),
        )
        const authorization = yield* appAuthorization("verify installation", id)
        const request = HttpClientRequest.get(`${baseUrl}/app/installations/${id}`, {
          headers: headers(authorization),
        })
        const httpResponse = yield* client
          .execute(request)
          .pipe(Effect.mapError(() => failure("transport", "verify installation", id, "GitHub request failed")))
        if (httpResponse.status < 200 || httpResponse.status >= 300) {
          return yield* failure(
            responseReason(httpResponse.status),
            "verify installation",
            id,
            "GitHub rejected installation verification",
            httpResponse.status,
          )
        }
        const installation = yield* HttpClientResponse.schemaBodyJson(GitHub.Installation)(httpResponse).pipe(
          Effect.mapError(() =>
            failure("response", "verify installation", id, "GitHub returned an invalid installation"),
          ),
        )
        if (installation.id !== id || installation.app_id !== options.appId) {
          return yield* failure(
            "app_mismatch",
            "verify installation",
            id,
            "Installation does not belong to this GitHub App",
          )
        }
        if (installation.suspended_at != null) {
          return yield* failure("suspended", "verify installation", id, "Installation is suspended")
        }
        return installation
      })
      const listVerifiedRepositories = Effect.fn("GitHubInstallation.listVerifiedRepositories")(function* (
        installationId: number,
      ) {
        const authorization = yield* appAuthorization("list repositories", installationId)
        const tokenRequest = HttpClientRequest.post(`${baseUrl}/app/installations/${installationId}/access_tokens`, {
          headers: headers(authorization),
        }).pipe(HttpClientRequest.bodyJsonUnsafe({ permissions: { metadata: "read" } }))
        const tokenHttpResponse = yield* client
          .execute(tokenRequest)
          .pipe(
            Effect.mapError(() => failure("transport", "list repositories", installationId, "GitHub request failed")),
          )
        if (tokenHttpResponse.status < 200 || tokenHttpResponse.status >= 300) {
          return yield* failure(
            responseReason(tokenHttpResponse.status),
            "list repositories",
            installationId,
            "GitHub rejected repository inventory authentication",
            tokenHttpResponse.status,
          )
        }
        const tokenResponse = yield* HttpClientResponse.schemaBodyJson(InventoryTokenResponse)(tokenHttpResponse).pipe(
          Effect.mapError(() =>
            failure("response", "list repositories", installationId, "GitHub returned an invalid token response"),
          ),
        )
        const token = Redacted.make(tokenResponse.token)
        const repositories: Array<GitHub.Repository> = []
        let page = 1
        let total = 0
        do {
          const request = HttpClientRequest.get(`${baseUrl}/installation/repositories?per_page=100&page=${page}`, {
            headers: headers(Redacted.value(token)),
          })
          const httpResponse = yield* client
            .execute(request)
            .pipe(
              Effect.mapError(() => failure("transport", "list repositories", installationId, "GitHub request failed")),
            )
          if (httpResponse.status < 200 || httpResponse.status >= 300) {
            return yield* failure(
              responseReason(httpResponse.status),
              "list repositories",
              installationId,
              "GitHub rejected repository inventory",
              httpResponse.status,
            )
          }
          const response = yield* HttpClientResponse.schemaBodyJson(RepositoryPage)(httpResponse).pipe(
            Effect.mapError(() =>
              failure("response", "list repositories", installationId, "GitHub returned an invalid repository page"),
            ),
          )
          total = response.total_count
          if (response.repositories.length === 0 && repositories.length < total) {
            return yield* failure(
              "response",
              "list repositories",
              installationId,
              "GitHub repository pagination ended early",
            )
          }
          repositories.push(...response.repositories)
          page += 1
        } while (repositories.length < total)
        const repositoryIds = new Set(repositories.map((repository) => repository.id))
        if (repositoryIds.size !== repositories.length || repositories.length !== total) {
          return yield* failure(
            "response",
            "list repositories",
            installationId,
            "GitHub repository inventory was inconsistent",
          )
        }
        return repositories
      })
      const listRepositories = Effect.fn("GitHubInstallation.listRepositories")(function* (installationId: number) {
        const installation = yield* verifyInstallation(installationId)
        return yield* listVerifiedRepositories(installation.id)
      })
      const reconcileInstallation = Effect.fn("GitHubInstallation.reconcileInstallation")(function* (
        installationId: number,
      ) {
        const installation = yield* verifyInstallation(installationId)
        const repositories = yield* listVerifiedRepositories(installation.id)
        return {
          installation,
          repositories,
          reconciledAtMillis: yield* Clock.currentTimeMillis,
        }
      })
      return Installation.of({ verifyInstallation, listRepositories, reconcileInstallation })
    }),
  )

export const installationTestLayer = (service: InstallationService) =>
  Layer.succeed(Installation, Installation.of(service))
