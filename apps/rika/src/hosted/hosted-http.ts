import { Crypto, Effect, Layer, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import {
  CliDevice,
  DeviceAuthorization,
  HostedError,
  Http,
  IdentityContext,
  Invitation,
  Registration,
  RemoteConnection,
  scopes,
  type DevicePoll,
  type PrivateJwk,
  type Session,
  type TokenSet,
} from "./hosted-contract"
import * as Dpop from "./hosted-dpop"

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
  refresh_token: Schema.String,
  expires_in: Schema.Int,
  token_type: Schema.optionalKey(Schema.String),
})
const OAuthErrorWire = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optionalKey(Schema.String),
})
const DevicesWire = Schema.Union([Schema.Array(CliDevice), Schema.Struct({ devices: Schema.Array(CliDevice) })])

const failure = (kind: HostedError["kind"], message: string) => HostedError.make({ kind, message })
const resource = (origin: string) => `${origin}/api/v1`

const tokensFrom = (wire: typeof TokenWire.Type): Effect.Effect<TokenSet, HostedError> => {
  if (wire.expires_in <= 0 || (wire.token_type !== undefined && wire.token_type.toLowerCase() !== "dpop"))
    return Effect.fail(failure("protocol", "Hosted token response was not a valid DPoP token response"))
  return Effect.succeed({
    accessToken: wire.access_token,
    refreshToken: wire.refresh_token,
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
            onNone: () => Effect.fail(failure("network", "Hosted server request timed out")),
            onSome: Effect.succeed,
          }),
        ),
        Effect.mapError((error) =>
          Schema.is(HostedError)(error) ? error : failure("network", "Hosted server request failed"),
        ),
      )
    const responseError = (status: number, action: string) =>
      status === 401
        ? failure("login-required", "Hosted identity login is required")
        : failure(status >= 500 || status === 429 ? "network" : "protocol", `${action} failed`)
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
        ...(accessToken === undefined ? {} : { accessToken }),
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
    ) {
      if (response.status >= 200 && response.status < 300)
        return yield* decode(response, TokenWire, `${action} returned an invalid response`).pipe(
          Effect.flatMap(tokensFrom),
        )
      const oauth = yield* decode(response, OAuthErrorWire, `${action} failed`).pipe(Effect.option)
      if (Option.isSome(oauth) && (oauth.value.error === "invalid_grant" || oauth.value.error === "invalid_token"))
        return yield* failure("login-required", "Hosted identity login is required")
      return yield* responseError(response.status, action)
    })
    const authenticatedJson = <S extends Schema.Constraint>(
      method: "GET" | "POST",
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
            : Effect.fail(responseError(response.status, action)),
        ),
      )
    const authenticatedEmpty = (
      method: "POST",
      url: string,
      request: HttpClientRequest.HttpClientRequest,
      session: Session,
      action: string,
    ) =>
      withDpop(request, method, url, session.privateJwk, session.accessToken).pipe(
        Effect.flatMap(execute),
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300
            ? Effect.void
            : Effect.fail(responseError(response.status, action)),
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
              : Effect.fail(responseError(response.status, "CLI registration")),
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
              : Effect.fail(responseError(response.status, "Device authorization")),
          ),
          Effect.flatMap((wire) =>
            Schema.decodeUnknownEffect(DeviceAuthorization)({
              deviceCode: wire.device_code,
              userCode: wire.user_code,
              verificationUri: wire.verification_uri,
              ...(wire.verification_uri_complete === undefined
                ? {}
                : { verificationUriComplete: wire.verification_uri_complete }),
              expiresIn: wire.expires_in,
              interval: wire.interval ?? 5,
            }).pipe(Effect.mapError(() => failure("protocol", "Device authorization returned invalid timing"))),
          ),
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
              return Effect.fail(failure("network", "Device token request failed"))
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
          Effect.flatMap((response) => tokenResponse(response, "Hosted token refresh")),
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
          "Hosted organization invitation",
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
      createRemoteConnection: (origin, organization, project, session) => {
        const url = `${origin}/api/v1/connections`
        return authenticatedJson(
          "POST",
          url,
          HttpClientRequest.post(url).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              placement: "e2b",
              organization_id: organization,
              ...(project === undefined ? {} : { project_id: project }),
            }),
          ),
          session,
          RemoteConnection,
          "Remote connection creation",
        )
      },
    })
  }),
)
