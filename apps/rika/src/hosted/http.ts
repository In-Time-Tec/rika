import { Effect, Layer, Option, Redacted, Schema } from "effect"
import { ClientTicketResponse } from "@rika/product/client-protocol"
import { RunnerPollResult } from "@rika/product/runner-registration"
import { HttpClientRequest } from "effect/unstable/http"
import {
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
  RecoveryInspection,
  RecoveryResolutionReceipt,
  Registration,
  RepositoryPublicationStatus,
  WorkspaceSeedUpload,
  scopes,
  type DevicePoll,
  type OwnerSelection,
} from "./contract"
import { clientOperations } from "./http/client"
import {
  DeviceAuthorizationWire,
  DevicesWire,
  OAuthErrorWire,
  ProviderCredentialsWire,
  RegistrationWire,
  TokenWire,
  tokensFrom,
} from "./http/schema"

const failure = (kind: HostedError["kind"], message: string) => HostedError.make({ kind, message })
const resource = (origin: string) => `${origin}/api/v1`
const ownerWire = (owner: OwnerSelection) =>
  owner.kind === "personal"
    ? { kind: "personal" as const }
    : { kind: "organization" as const, organization_id: owner.organizationId }

export const layer = Layer.effect(
  Http,
  Effect.gen(function* () {
    const { authenticatedEmpty, authenticatedJson, decode, execute, responseError, tokenResponse, withDpop } =
      yield* clientOperations
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
              : responseError(response, "CLI registration"),
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
                Effect.flatMap(tokensFrom()),
                Effect.map((tokens) => ({ _tag: "Complete" as const, tokens })),
              )
            if (response.status >= 500 || response.status === 429)
              return responseError(response, "Device token request")
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
          RecoveryInspection,
          "Thread recovery inspection",
        )
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
          RecoveryResolutionReceipt,
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
