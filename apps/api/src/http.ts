import { Effect, Schema } from "effect"
import type {
  Account,
  CliDeviceDirectory,
  IdentityDirectory,
  IdentityPrincipal,
  IdentityRuntime,
  IdentityRuntimeError,
} from "@rika/identity"
import type { HostedProductService } from "./hosted-product"
import type { HostedThreadProtocolService } from "./hosted-thread-protocol"
import type { HostedModelRegistryService } from "./hosted-model-registry"
import type { HostedProviderCredentialsService } from "./hosted-provider-credentials"
import type { HostedEnvironmentService } from "./hosted-environment"
import type { HostedRecoveryService } from "./hosted-recovery"
import type { Runtime as Executor } from "./executor"
import type { ReadinessInterface as ExecutionReadiness } from "@rika/execution/postgres"
import type { HostedToolPolicyService } from "./hosted-tool-policy"

export interface HttpDependencies {
  readonly identity: IdentityRuntime
  readonly directory: IdentityDirectory
  readonly devices: CliDeviceDirectory
  readonly product: HostedProductService
  readonly toolPolicy: HostedToolPolicyService
  readonly threads?: HostedThreadProtocolService
  readonly credentials?: HostedProviderCredentialsService
  readonly environment?: HostedEnvironmentService
  readonly models?: HostedModelRegistryService
  readonly recovery: HostedRecoveryService
  readonly executor: Executor
  readonly execution: ExecutionReadiness
  readonly production: boolean
}

const CliRegistrationRequest = Schema.Struct({
  reference_id: Schema.String.check(Schema.isPattern(/^cli-device:[0-9a-f-]{36}$/i)),
  token_endpoint_auth_method: Schema.Literal("none"),
  grant_types: Schema.Array(Schema.Literals(["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"])),
  scope: Schema.NonEmptyString,
  resource: Schema.NonEmptyString,
  dpop_jkt: Schema.NonEmptyString,
  jwk: Schema.Struct({
    kty: Schema.Literal("EC"),
    crv: Schema.Literal("P-256"),
    x: Schema.NonEmptyString,
    y: Schema.NonEmptyString,
  }),
})

const OAuthRegistrationResponse = Schema.Struct({ client_id: Schema.NonEmptyString })
const InvitationRequest = Schema.Struct({ email: Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) })
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const securityHeaders = (production: boolean) => {
  const headers = new Headers({
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  })
  if (production) headers.set("strict-transport-security", "max-age=31536000; includeSubDomains")
  return headers
}

const secured = (response: Response, production: boolean) => {
  const headers = new Headers(response.headers)
  securityHeaders(production).forEach((value, name) => headers.set(name, value))
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

export const secureResponse = (production: boolean) => (response: Response) => secured(response, production)

const json = (body: unknown, production: boolean, status = 200, extraHeaders?: Headers) => {
  const headers = securityHeaders(production)
  headers.set("content-type", "application/json; charset=utf-8")
  headers.set("cache-control", "no-store")
  if (extraHeaders !== undefined) new Headers(extraHeaders).forEach((value, name) => headers.set(name, value))
  return new Response(JSON.stringify(body), { status, headers })
}

const redirect = (location: string, production: boolean) => {
  const headers = securityHeaders(production)
  headers.set("location", location)
  headers.set("cache-control", "no-store")
  return new Response(null, { status: 303, headers })
}

const currentPath = (url: URL) => `${url.pathname}${url.search}`

const loginRedirect = (url: URL, production: boolean) =>
  redirect(`/login?redirect=${encodeURIComponent(currentPath(url))}`, production)

const isAuthPath = (path: string) =>
  path === "/api/auth" || path.startsWith("/api/auth/") || path === "/.well-known/oauth-authorization-server/api/auth"

const requiresAuthentication = (path: string) =>
  path === "/api/auth/device/approve" || path === "/api/auth/oauth2/authorize" || path === "/api/auth/oauth2/consent"

const isBrowserAuthorization = (path: string, request: Request) =>
  path === "/api/auth/oauth2/authorize" && request.method === "GET"

export type AccountAccess =
  | {
      readonly _tag: "account"
      readonly account: Account
      readonly principal: IdentityPrincipal
      readonly deviceId?: string
    }
  | { readonly _tag: "anonymous" }
  | { readonly _tag: "invalid" }
  | { readonly _tag: "unavailable" }

export const accountAccess = Effect.fn("ApiHttp.accountAccess")(function* (
  request: Request,
  dependencies: HttpDependencies,
): Effect.fn.Return<AccountAccess> {
  const identity = yield* dependencies.identity.identify(request).pipe(
    Effect.map((principal) => ({ _tag: "identity" as const, principal })),
    Effect.catch((error: IdentityRuntimeError) =>
      Effect.succeed(error.kind === "invalid" ? { _tag: "invalid" as const } : { _tag: "unavailable" as const }),
    ),
  )
  if (identity._tag === "invalid") return { _tag: "invalid" }
  if (identity._tag === "unavailable") return { _tag: "unavailable" }
  if (identity.principal === undefined) return { _tag: "anonymous" }
  const account = yield* dependencies.directory.account(identity.principal.userId).pipe(
    Effect.map((value) => ({ _tag: "value" as const, value })),
    Effect.orElseSucceed(() => ({ _tag: "unavailable" as const })),
  )
  if (account._tag === "unavailable" || account.value === undefined) return { _tag: "unavailable" }
  const device = yield* dependencies.devices.authenticate(identity.principal).pipe(
    Effect.map((value) => ({ _tag: "device" as const, value })),
    Effect.orElseSucceed(() => ({ _tag: "unavailable" as const })),
  )
  if (device._tag === "unavailable") return { _tag: "unavailable" }
  if (identity.principal.clientId !== undefined && device.value === undefined) return { _tag: "invalid" }
  return {
    _tag: "account",
    account: account.value,
    principal: identity.principal,
    ...(device.value === undefined ? {} : { deviceId: device.value }),
  }
})

const decodeJson = <S extends Schema.Constraint>(request: Request, schema: S) =>
  Effect.tryPromise({ try: () => request.json(), catch: () => undefined }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })),
    Effect.option,
  )

const accessFailure = (
  access: Exclude<AccountAccess, { readonly _tag: "account" }>,
  dependencies: HttpDependencies,
) => {
  if (access._tag === "unavailable")
    return json({ message: "Identity service unavailable" }, dependencies.production, 503)
  return json(
    { message: "Authentication required" },
    dependencies.production,
    401,
    new Headers({ "www-authenticate": 'Bearer realm="rika"' }),
  )
}

const routeRequest = Effect.fn("ApiHttp.route")(function* (request: Request, dependencies: HttpDependencies) {
  const url = new URL(request.url)
  const { pathname } = url

  if (
    pathname === "/.well-known/oauth-protected-resource/api/v1" &&
    (request.method === "GET" || request.method === "HEAD")
  ) {
    const metadata = yield* dependencies.identity.protectedResourceMetadata.pipe(
      Effect.map((value) => ({ _tag: "metadata" as const, value })),
      Effect.orElseSucceed(() => ({ _tag: "unavailable" as const })),
    )
    if (metadata._tag === "unavailable")
      return json({ message: "Identity service unavailable" }, dependencies.production, 503)
    const response = json(metadata.value, dependencies.production)
    return request.method === "HEAD"
      ? new Response(null, { status: response.status, headers: response.headers })
      : response
  }

  if (pathname === "/api/account") {
    if (request.method !== "GET")
      return json({ message: "Method not allowed" }, dependencies.production, 405, new Headers({ allow: "GET" }))
    const access = yield* accountAccess(request, dependencies)
    return access._tag === "account"
      ? json(access.account, dependencies.production)
      : accessFailure(access, dependencies)
  }

  if (pathname === "/api/v1/auth/cli/registrations" && request.method === "POST") {
    const decoded = yield* decodeJson(request, CliRegistrationRequest)
    if (decoded._tag === "None") return json({ message: "Invalid CLI registration" }, dependencies.production, 400)
    const expectedResource = `${url.origin}/api/v1`
    if (decoded.value.resource !== expectedResource)
      return json({ message: "Invalid OAuth resource" }, dependencies.production, 400)
    const delegated = yield* dependencies.identity
      .handle(
        new Request(`${url.origin}/api/auth/oauth2/register`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: encodeJson({
            client_name: "Rika CLI",
            application_type: "native",
            token_endpoint_auth_method: "none",
            grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
            scope: "openid profile email offline_access account",
            software_id: "rika-cli",
            dpop_bound_access_tokens: true,
            resources: [expectedResource],
          }),
        }),
      )
      .pipe(Effect.option)
    if (delegated._tag === "None")
      return json({ message: "Identity service unavailable" }, dependencies.production, 503)
    if (!delegated.value.ok) return secured(delegated.value, dependencies.production)
    const registration = yield* Effect.tryPromise({
      try: () => delegated.value.clone().json(),
      catch: () => undefined,
    }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(OAuthRegistrationResponse)), Effect.option)
    if (registration._tag === "None")
      return json({ message: "Identity service returned an invalid registration" }, dependencies.production, 503)
    const stored = yield* dependencies.devices
      .register({
        clientId: registration.value.client_id,
        deviceId: decoded.value.reference_id.slice("cli-device:".length),
        publicJwk: decoded.value.jwk,
        jwkThumbprint: decoded.value.dpop_jkt,
      })
      .pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      )
    if (!stored) {
      yield* dependencies.devices.discard(registration.value.client_id).pipe(Effect.ignore)
      return json({ message: "CLI registration could not be persisted" }, dependencies.production, 503)
    }
    return secured(delegated.value, dependencies.production)
  }

  if (pathname === "/api/v1/auth/cli/devices" && request.method === "GET") {
    const access = yield* accountAccess(request, dependencies)
    if (access._tag !== "account") return accessFailure(access, dependencies)
    const devices = yield* dependencies.devices.list(access.principal).pipe(Effect.option)
    return devices._tag === "None"
      ? json({ message: "Identity service unavailable" }, dependencies.production, 503)
      : json({ devices: devices.value }, dependencies.production)
  }

  const revokeCliDevice = /^\/api\/v1\/auth\/cli\/devices\/([^/]+)\/revoke$/.exec(pathname)
  if (revokeCliDevice?.[1] !== undefined && request.method === "POST") {
    const access = yield* accountAccess(request, dependencies)
    if (access._tag !== "account") return accessFailure(access, dependencies)
    const revoked = yield* dependencies.devices
      .revoke(access.principal, decodeURIComponent(revokeCliDevice[1]))
      .pipe(Effect.option)
    if (revoked._tag === "None") return json({ message: "Identity service unavailable" }, dependencies.production, 503)
    return revoked.value
      ? new Response(null, { status: 204, headers: securityHeaders(dependencies.production) })
      : json({ message: "CLI device was not found" }, dependencies.production, 404)
  }

  const invitationRoute = /^\/api\/v1\/organizations\/([^/]+)\/invitations$/.exec(pathname)
  if (invitationRoute?.[1] !== undefined && request.method === "POST") {
    const access = yield* accountAccess(request, dependencies)
    if (access._tag !== "account") return accessFailure(access, dependencies)
    const membership = access.account.memberships.find(
      (candidate) => candidate.organization.id === decodeURIComponent(invitationRoute[1] as string),
    )
    if (membership === undefined) return json({ message: "Organization is unavailable" }, dependencies.production, 404)
    const decoded = yield* decodeJson(request, InvitationRequest)
    if (decoded._tag === "None") return json({ message: "Invalid invitation" }, dependencies.production, 400)
    return yield* dependencies.identity
      .handle(
        new Request(`${url.origin}/api/auth/organization/invite-member`, {
          method: "POST",
          headers: request.headers,
          body: encodeJson({ email: decoded.value.email, organizationId: membership.organization.id, role: "member" }),
        }),
      )
      .pipe(
        Effect.map((response) => secured(response, dependencies.production)),
        Effect.orElseSucceed(() => json({ message: "Identity service unavailable" }, dependencies.production, 503)),
      )
  }

  if (isAuthPath(pathname)) {
    if (requiresAuthentication(pathname)) {
      const access = yield* accountAccess(request, dependencies)
      if (access._tag !== "account")
        return isBrowserAuthorization(pathname, request) && (access._tag === "anonymous" || access._tag === "invalid")
          ? loginRedirect(url, dependencies.production)
          : accessFailure(access, dependencies)
    }
    return yield* dependencies.identity.handle(request).pipe(
      Effect.map((response) => secured(response, dependencies.production)),
      Effect.orElseSucceed(() => json({ message: "Identity service unavailable" }, dependencies.production, 503)),
    )
  }

  return json({ message: "Not found" }, dependencies.production, 404)
})

export const handleRequest = (input: { readonly request: Request; readonly dependencies: HttpDependencies }) =>
  routeRequest(input.request, input.dependencies).pipe(
    Effect.catchCause(() =>
      Effect.succeed(json({ message: "Internal server error" }, input.dependencies.production, 500)),
    ),
  )

export const makeSupplementalApiRequestHandler = (dependencies: HttpDependencies) => (request: Request) =>
  Effect.runPromise(handleRequest({ request, dependencies }))
