import { Crypto, Effect, Layer, Option, Redacted, Schema } from "effect"
import { ClientTicketResponse } from "@rika/product/client-protocol"
import { RunnerPollResult } from "@rika/product/runner-registration"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import {
  CliDevice,
  DeviceAuthorization,
  HostedError,
  HostedThreadList,
  HostedThreadPreview,
  EnvironmentReferenceStatus,
  Http,
  IdentityContext,
  Invitation,
  OpenAiAccountStatus,
  ProviderCredentialStatus,
  Project,
  RecoveryOperation,
  Registration,
  RepositoryPublicationStatus,
  WorkspaceSeedUpload,
  scopes,
  type DevicePoll,
  type OwnerSelection,
  type PrivateJwk,
  type Session,
  type TokenSet,
} from "./contract"
import * as Dpop from "./dpop"

const RegistrationWire = Schema.Struct({ client_id: Schema.String })
const DeviceAuthorizationWire = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  verification_uri_complete: Schema.optionalKey(Schema.String),
  expires_in: Schema.Int,
  interval: Schema.optionalKey(Schema.Int),
})
const TokenWire = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
  expires_in: Schema.Int,
  token_type: Schema.optionalKey(Schema.String),
})
const OAuthErrorWire = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optionalKey(Schema.String),
})
const DevicesWire = Schema.Union([Schema.Array(CliDevice), Schema.Struct({ devices: Schema.Array(CliDevice) })])
const ProviderCredentialsWire = Schema.Struct({ credentials: Schema.Array(ProviderCredentialStatus) })
const RecoveryOperationsWire = Schema.Struct({ operations: Schema.Array(RecoveryOperation) })

const failure = (kind: HostedError["kind"], message: string) => HostedError.make({ kind, message })
const resource = (origin: string) => `${origin}/api/v1`
const ownerWire = (owner: OwnerSelection) =>
  owner.kind === "personal"
    ? { kind: "personal" as const }
    : { kind: "organization" as const, organization_id: owner.organizationId }

const tokensFrom = (
  wire: typeof TokenWire.Type,
  previousRefreshToken?: string,
): Effect.Effect<TokenSet, HostedError> => {
  const refreshToken = wire.refresh_token ?? previousRefreshToken
  if (
    refreshToken === undefined ||
    wire.expires_in <= 0 ||
    (wire.token_type !== undefined && wire.token_type.toLowerCase() !== "dpop")
  )
    return Effect.fail(failure("protocol", "Token response was not a valid DPoP token response"))
  return Effect.succeed({
    accessToken: wire.access_token,
    refreshToken,
    expiresIn: wire.expires_in,
  })
}

const decode = <S extends Schema.Constraint>(
  response: HttpClientResponse.HttpClientResponse,
  schema: S,
  message: string,
) => HttpClientResponse.schemaBodyJson(schema)(response).pipe(Effect.mapError(() => failure("protocol", message)))

export const layer = Layer.effect(
  Http,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const crypto = yield* Crypto.Crypto
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      client.execute(request).pipe(
        Effect.timeoutOption("30 seconds"),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(failure("network", "Server request timed out")),
            onSome: Effect.succeed,
          }),
        ),
        Effect.mapError((error) =>
          Schema.is(HostedError)(error) ? error : failure("network", "Server request failed"),
        ),
      )
    const responseError = (response: HttpClientResponse.HttpClientResponse, action: string) => {
      if (response.status === 401) return failure("login-required", "Identity login is required")
      if (response.status === 429) {
        const value = response.headers["x-retry-after"] ?? response.headers["retry-after"]
        const seconds = value === undefined ? Number.NaN : Number(value)
        const retryAfterMillis = Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1_000) : undefined
        const suffix = retryAfterMillis === undefined ? "" : `; retry in ${Math.ceil(retryAfterMillis / 1_000)} seconds`
        const limited = {
          kind: "rate-limit",
          message: `${action} was rate limited${suffix}`,
          status: response.status,
        } as const
        return HostedError.make(retryAfterMillis === undefined ? limited : { ...limited, retryAfterMillis })
      }
      return HostedError.make({
        kind: response.status >= 500 ? "network" : "protocol",
        message: `${action} failed`,
        status: response.status,
      })
    }
    const withDpop = Effect.fn("HostedHttp.withDpop")(function* (
      request: HttpClientRequest.HttpClientRequest,
      method: string,
      url: string,
      privateJwk: PrivateJwk,
      accessToken?: Redacted.Redacted<string>,
    ) {
      const jti = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(() => failure("host", "Could not create a DPoP identifier")),
      )
      const value = yield* Dpop.proof({
        method,
        url,
        privateJwk,
        jti,
        accessToken,
      })
      return request.pipe(
        HttpClientRequest.setHeader("DPoP", value),
        accessToken === undefined
          ? (current) => current
          : HttpClientRequest.setHeader("Authorization", `DPoP ${Redacted.value(accessToken)}`),
      )
    })
    const tokenResponse = Effect.fn("HostedHttp.tokenResponse")(function* (
      response: HttpClientResponse.HttpClientResponse,
      action: string,
      previousRefreshToken?: string,
    ) {
      if (response.status >= 200 && response.status < 300)
        return yield* decode(response, TokenWire, `${action} returned an invalid response`).pipe(
          Effect.flatMap((wire) => tokensFrom(wire, previousRefreshToken)),
        )
      const oauth = yield* decode(response, OAuthErrorWire, `${action} failed`).pipe(Effect.option)
      if (Option.isSome(oauth) && (oauth.value.error === "invalid_grant" || oauth.value.error === "invalid_token"))
        return yield* failure("login-required", "Identity login is required")
      return yield* responseError(response, action)
    })
    const authenticatedJson = <S extends Schema.Constraint>(
      method: "GET" | "POST" | "PUT" | "DELETE",
      url: string,
      request: HttpClientRequest.HttpClientRequest,
      session: Session,
      schema: S,
      action: string,
    ) =>
      withDpop(request, method, url, session.privateJwk, session.accessToken).pipe(
        Effect.flatMap(execute),
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300
            ? decode(response, schema, `${action} returned an invalid response`)
            : Effect.fail(responseError(response, action)),
        ),
      )
    const authenticatedEmpty = (
      method: "POST" | "PUT",
      url: string,
      request: HttpClientRequest.HttpClientRequest,
      session: Session,
      action: string,
    ) =>
      withDpop(request, method, url, session.privateJwk, session.accessToken).pipe(
        Effect.flatMap(execute),
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300 ? Effect.void : Effect.fail(responseError(response, action)),
        ),
      )
    return Http.of({
      register: (origin, deviceId, publicJwk, thumbprint) => {
        const url = `${origin}/api/v1/auth/cli/registrations`
        return execute(
          HttpClientRequest.post(url).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              reference_id: `cli-device:${deviceId}`,
              token_endpoint_auth_method: "none",
              grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
              scope: scopes,
              resource: resource(origin),
              dpop_jkt: thumbprint,
              jwk: publicJwk,
            }),
          ),
        ).pipe(
          Effect.flatMap((response) =>
            response.status >= 200 && response.status < 300
              ? decode(response, RegistrationWire, "CLI registration returned an invalid response")
              : Effect.fail(responseError(response, "CLI registration")),
          ),
          Effect.map((wire) => Registration.make({ clientId: wire.client_id })),
        )
      },
      startDeviceAuthorization: (origin, clientId, privateJwk) => {
        const url = `${origin}/api/auth/device/code`
        return withDpop(
          HttpClientRequest.post(url).pipe(
            HttpClientRequest.bodyUrlParams({ client_id: clientId, scope: scopes, resource: resource(origin) }),
          ),
          "POST",
          url,
          privateJwk,
        ).pipe(
          Effect.flatMap(execute),
          Effect.flatMap((response) =>
            response.status >= 200 && response.status < 300
              ? decode(response, DeviceAuthorizationWire, "Device authorization returned an invalid response")
              : Effect.gen(function* () {
                  const oauth = yield* decode(response, OAuthErrorWire, "Device authorization failed").pipe(
                    Effect.option,
                  )
                  if (Option.isSome(oauth) && oauth.value.error === "invalid_client")
                    return yield* failure("registration-required", "CLI registration is no longer valid")
                  return yield* responseError(response, "Device authorization")
                }),
          ),
          Effect.flatMap((wire) => {
            const authorization = {
              deviceCode: wire.device_code,
              userCode: wire.user_code,
              verificationUri: wire.verification_uri,
              expiresIn: wire.expires_in,
              interval: wire.interval ?? 5,
            }
            return Schema.decodeEffect(DeviceAuthorization)(
              wire.verification_uri_complete === undefined
                ? authorization
                : { ...authorization, verificationUriComplete: wire.verification_uri_complete },
            ).pipe(Effect.mapError(() => failure("protocol", "Device authorization returned invalid timing")))
          }),
          Effect.filterOrFail(
            (authorization) => authorization.expiresIn > 0 && authorization.interval > 0,
            () => failure("protocol", "Device authorization returned invalid timing"),
          ),
        )
      },
      pollDeviceAuthorization: (origin, clientId, deviceCode, privateJwk) => {
        const url = `${origin}/api/auth/oauth2/token`
        return withDpop(
          HttpClientRequest.post(url).pipe(
            HttpClientRequest.bodyUrlParams({
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
              device_code: Redacted.value(deviceCode),
              client_id: clientId,
              resource: resource(origin),
            }),
          ),
          "POST",
          url,
          privateJwk,
        ).pipe(
          Effect.flatMap(execute),
          Effect.flatMap((response) => {
            if (response.status >= 200 && response.status < 300)
              return decode(response, TokenWire, "Device token response was invalid").pipe(
                Effect.flatMap(tokensFrom),
                Effect.map((tokens) => ({ _tag: "Complete" as const, tokens })),
              )
            if (response.status >= 500 || response.status === 429)
              return Effect.fail(responseError(response, "Device token request"))
            return decode(response, OAuthErrorWire, "Device token response was invalid").pipe(
              Effect.flatMap((body): Effect.Effect<DevicePoll, HostedError> => {
                if (body.error === "authorization_pending") return Effect.succeed({ _tag: "Pending" as const })
                if (body.error === "slow_down") return Effect.succeed({ _tag: "SlowDown" as const })
                if (body.error === "access_denied") return Effect.succeed({ _tag: "Denied" as const })
                if (body.error === "expired_token") return Effect.succeed({ _tag: "Expired" as const })
                return Effect.fail(failure("protocol", "Device authorization failed"))
              }),
            )
          }),
        )
      },
      refresh: (origin, clientId, refreshToken, privateJwk) => {
        const url = `${origin}/api/auth/oauth2/token`
        return withDpop(
          HttpClientRequest.post(url).pipe(
            HttpClientRequest.bodyUrlParams({
              grant_type: "refresh_token",
              refresh_token: Redacted.value(refreshToken),
              client_id: clientId,
              resource: resource(origin),
            }),
          ),
          "POST",
          url,
          privateJwk,
        ).pipe(
          Effect.flatMap(execute),
          Effect.flatMap((response) => tokenResponse(response, "Token refresh", Redacted.value(refreshToken))),
        )
      },
      context: (origin, session) => {
        const url = `${origin}/api/v1/me/context`
        return authenticatedJson("GET", url, HttpClientRequest.get(url), session, IdentityContext, "Identity context")
      },
      invite: (origin, organization, email, session) => {
        const url = `${origin}/api/v1/organizations/${encodeURIComponent(organization)}/invitations`
        return authenticatedJson(
          "POST",
          url,
          HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe({ email })),
          session,
          Invitation,
          "Organization invitation",
        )
      },
      devices: (origin, session) => {
        const url = `${origin}/api/v1/auth/cli/devices`
        return authenticatedJson("GET", url, HttpClientRequest.get(url), session, DevicesWire, "CLI device list").pipe(
          Effect.map((value) => ("devices" in value ? value.devices : value)),
        )
      },
      revokeDevice: (origin, deviceId, session) => {
        const url = `${origin}/api/v1/auth/cli/devices/${encodeURIComponent(deviceId)}/revoke`
        return authenticatedEmpty(
          "POST",
          url,
          HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe({})),
          session,
          "CLI device revocation",
        )
      },
      revokeAllDevices: (origin, session) => {
        const url = `${origin}/api/v1/auth/cli/devices/revoke-all`
        return authenticatedEmpty("POST", url, HttpClientRequest.post(url), session, "All CLI device revocation")
      },
      issueThreadTicket: (origin, session) => {
        const url = `${origin}/api/v1/thread-sessions`
        return authenticatedJson(
          "POST",
          url,
          HttpClientRequest.post(url),
          session,
          ClientTicketResponse,
          "Thread session",
        )
      },
      listThreads: (origin, owner, project, session) => {
        const url = `${origin}/api/v1/threads/list`
        return authenticatedJson(
          "POST",
          url,
          HttpClientRequest.post(url).pipe(
            HttpClientRequest.bodyJsonUnsafe({ owner: ownerWire(owner), project_id: project }),
          ),
          session,
          HostedThreadList,
          "Thread list",
        ).pipe(Effect.map((response) => response.threads))
      },
      previewThread: (origin, threadId, session) => {
        const url = `${origin}/api/v1/threads/${encodeURIComponent(threadId)}/preview`
        return authenticatedJson(
          "GET",
          url,
          HttpClientRequest.get(url),
          session,
          HostedThreadPreview,
          "Thread preview",
        ).pipe(Effect.map((response) => response.units))
      },
      inspectRecovery: (origin, threadId, runId, session) => {
        const url = `${origin}/api/v1/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/recovery`
        return authenticatedJson(
          "GET",
          url,
          HttpClientRequest.get(url),
          session,
          RecoveryOperationsWire,
          "Thread recovery inspection",
        ).pipe(Effect.map((response) => response.operations))
      },
      resolveRecovery: (origin, threadId, runId, operationId, resolution, operationKey, session) => {
        const url = `${origin}/api/v1/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/recovery/${encodeURIComponent(operationId)}`
        return authenticatedJson(
          "POST",
          url,
          HttpClientRequest.post(url).pipe(
            HttpClientRequest.setHeader("idempotency-key", operationKey),
            HttpClientRequest.bodyJsonUnsafe(resolution),
          ),
          session,
          RecoveryOperation,
          "Thread recovery resolution",
        )
      },
      uploadWorkspaceSeed: (origin, archive, sourceRepository, session) => {
        const url = `${origin}/api/v1/workspace-seeds`
        const request = HttpClientRequest.post(url).pipe(
          HttpClientRequest.setHeader("x-rika-content-digest", archive.contentDigest),
          HttpClientRequest.bodyUint8Array(archive.bytes, "application/vnd.rika.workspace-seed+zstd"),
        )
        const withRepository =
          sourceRepository === undefined
            ? request
            : HttpClientRequest.setHeader(
                request,
                "x-rika-source-repository",
                `${sourceRepository.owner}/${sourceRepository.name}`,
              )
        return authenticatedJson("POST", url, withRepository, session, WorkspaceSeedUpload, "Workspace seed upload")
      },
      registerRunner: (origin, checkoutFingerprint, registration, session) => {
        const url = `${origin}/api/v1/runners/${encodeURIComponent(checkoutFingerprint)}`
        return authenticatedEmpty(
          "PUT",
          url,
          HttpClientRequest.put(url).pipe(HttpClientRequest.bodyJsonUnsafe(registration)),
          session,
          "Runner registration",
        )
      },
      setRemoteThreadCreation: (origin, checkoutFingerprint, preference, session) => {
        const url = `${origin}/api/v1/runners/${encodeURIComponent(checkoutFingerprint)}/remote-thread-creation`
        return authenticatedEmpty(
          "PUT",
          url,
          HttpClientRequest.put(url).pipe(HttpClientRequest.bodyJsonUnsafe({ preference })),
          session,
          "Runner preference",
        )
      },
      pollRunner: (origin, checkoutFingerprint, supervisorId, activeAssignmentIds, session) => {
        const url = `${origin}/api/v1/runners/${encodeURIComponent(checkoutFingerprint)}/admissions`
        return authenticatedJson(
          "POST",
          url,
          HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe({ supervisorId, activeAssignmentIds })),
          session,
          RunnerPollResult,
          "Runner admission",
        )
      },
      putProviderCredential: (origin, owner, provider, apiKey, session) => {
        const url = `${origin}/api/v1/provider-credentials/${provider}`
        return authenticatedJson(
          "PUT",
          url,
          HttpClientRequest.put(url).pipe(
            HttpClientRequest.bodyJsonUnsafe({ owner: ownerWire(owner), api_key: Redacted.value(apiKey) }),
          ),
          session,
          ProviderCredentialStatus,
          "Provider credential update",
        )
      },
      listProviderCredentials: (origin, owner, session) => {
        const url = `${origin}/api/v1/provider-credentials/list`
        return authenticatedJson(
          "POST",
          url,
          HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe({ owner: ownerWire(owner) })),
          session,
          ProviderCredentialsWire,
          "Provider credential list",
        ).pipe(Effect.map((response) => response.credentials))
      },
      revokeProviderCredential: (origin, owner, provider, session) => {
        const url = `${origin}/api/v1/provider-credentials/${provider}`
        return authenticatedJson(
          "DELETE",
          url,
          HttpClientRequest.delete(url).pipe(HttpClientRequest.bodyJsonUnsafe({ owner: ownerWire(owner) })),
          session,
          ProviderCredentialStatus,
          "Provider credential revocation",
        )
      },
      putOpenAiAccount: (origin, owner, credential, session) => {
        const url = `${origin}/api/v1/provider-accounts/openai`
        return authenticatedJson(
          "PUT",
          url,
          HttpClientRequest.put(url).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              owner: ownerWire(owner),
              access_token: Redacted.value(credential.accessToken),
              id_token: Redacted.value(credential.idToken),
              refresh_token: Redacted.value(credential.refreshToken),
            }),
          ),
          session,
          OpenAiAccountStatus,
          "OpenAI account update",
        )
      },
      getOpenAiAccount: (origin, owner, session) => {
        const url = `${origin}/api/v1/provider-accounts/openai/status`
        return authenticatedJson(
          "POST",
          url,
          HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe({ owner: ownerWire(owner) })),
          session,
          OpenAiAccountStatus,
          "OpenAI account status",
        )
      },
      revokeOpenAiAccount: (origin, owner, session) => {
        const url = `${origin}/api/v1/provider-accounts/openai`
        return authenticatedJson(
          "DELETE",
          url,
          HttpClientRequest.delete(url).pipe(HttpClientRequest.bodyJsonUnsafe({ owner: ownerWire(owner) })),
          session,
          OpenAiAccountStatus,
          "OpenAI account revocation",
        )
      },
      createProject: (origin, owner, name, session) => {
        const url = `${origin}/api/v1/projects`
        return authenticatedJson(
          "POST",
          url,
          HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe({ owner: ownerWire(owner), name })),
          session,
          Project,
          "Project creation",
        )
      },
      putEnvironment: (origin, owner, project, name, scope, phases, value, session) => {
        const url = `${origin}/api/v1/environment/${encodeURIComponent(name)}`
        return authenticatedJson(
          "PUT",
          url,
          HttpClientRequest.put(url).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              owner: ownerWire(owner),
              project_id: project,
              scope,
              classification: "secret",
              phases,
              value: Redacted.value(value),
            }),
          ),
          session,
          EnvironmentReferenceStatus,
          "Secret update",
        )
      },
      revokeEnvironment: (origin, owner, project, name, scope, session) => {
        const url = `${origin}/api/v1/environment/${encodeURIComponent(name)}`
        return authenticatedJson(
          "DELETE",
          url,
          HttpClientRequest.delete(url).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              owner: ownerWire(owner),
              project_id: project,
              scope,
            }),
          ),
          session,
          EnvironmentReferenceStatus,
          "Secret revocation",
        )
      },
      publishRepository: (origin, threadId, commitSha, targetBranch, title, body, operationKey, session) => {
        const url = `${origin}/api/v1/threads/${encodeURIComponent(threadId)}/repository-publications`
        return authenticatedJson(
          "POST",
          url,
          HttpClientRequest.post(url).pipe(
            HttpClientRequest.setHeader("idempotency-key", operationKey),
            HttpClientRequest.bodyJsonUnsafe({
              commit_sha: commitSha,
              target_branch: targetBranch,
              title,
              body,
            }),
          ),
          session,
          RepositoryPublicationStatus,
          "Repository synchronization",
        )
      },
    })
  }),
)
