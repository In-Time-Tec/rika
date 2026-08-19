import { Effect, Schema } from "effect"
import type {
  Account,
  CliDeviceDirectory,
  IdentityDirectory,
  IdentityPrincipal,
  IdentityRuntime,
  IdentityRuntimeError,
} from "@rika/identity"
import {
  accountPage,
  consentPage,
  deviceApprovalPage,
  devicePage,
  forgotPasswordPage,
  invitationPage,
  loginPage,
  newOrganizationPage,
  resetPasswordPage,
  signupPage,
  verifyEmailPage,
  webScript,
  webStyles,
} from "./web-pages"

export interface HttpDependencies {
  readonly identity: IdentityRuntime
  readonly directory: IdentityDirectory
  readonly devices: CliDeviceDirectory
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

const html = (body: string, production: boolean, status = 200) => {
  const headers = securityHeaders(production)
  headers.set("content-type", "text/html; charset=utf-8")
  headers.set("cache-control", "no-store")
  return new Response(body, { status, headers })
}

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

const safePath = (value: string | null, requestUrl: URL, fallback = "/") => {
  if (value === null || !value.startsWith("/")) return fallback
  const destination = new URL(value, requestUrl.origin)
  return destination.origin === requestUrl.origin
    ? `${destination.pathname}${destination.search}${destination.hash}`
    : fallback
}

const loginRedirect = (url: URL, production: boolean) =>
  redirect(`/login?redirect=${encodeURIComponent(currentPath(url))}`, production)

const organizationRedirect = (url: URL, production: boolean) =>
  redirect(`/organizations/new?redirect=${encodeURIComponent(currentPath(url))}`, production)

const isAuthPath = (path: string) =>
  path === "/api/auth" || path.startsWith("/api/auth/") || path === "/.well-known/oauth-authorization-server/api/auth"

const requiresOrganization = (path: string) =>
  path === "/api/auth/device/approve" || path === "/api/auth/oauth2/authorize" || path === "/api/auth/oauth2/consent"

const isBrowserAuthorization = (path: string, request: Request) =>
  path === "/api/auth/oauth2/authorize" && request.method === "GET"

type AccountAccess =
  | {
      readonly _tag: "account"
      readonly account: Account
      readonly principal: IdentityPrincipal
      readonly deviceId?: string
    }
  | { readonly _tag: "anonymous" }
  | { readonly _tag: "invalid" }
  | { readonly _tag: "unavailable" }

const accountAccess = Effect.fn("ControlPlaneHttp.accountAccess")(function* (
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

const protectedPage = Effect.fn("ControlPlaneHttp.protectedPage")(function* (
  request: Request,
  url: URL,
  dependencies: HttpDependencies,
  render: (account: Account) => string,
  organizationRequired: boolean,
) {
  const access = yield* accountAccess(request, dependencies)
  if (access._tag === "anonymous" || access._tag === "invalid") return loginRedirect(url, dependencies.production)
  if (access._tag === "unavailable") return html("<h1>Service unavailable</h1>", dependencies.production, 503)
  if (organizationRequired && access.account.memberships.length === 0)
    return organizationRedirect(url, dependencies.production)
  return html(render(access.account), dependencies.production)
})

const routeRequest = Effect.fn("ControlPlaneHttp.route")(function* (request: Request, dependencies: HttpDependencies) {
  const url = new URL(request.url)
  const { pathname } = url

  if (pathname === "/healthz" && request.method === "GET") return json({ status: "ok" }, dependencies.production)

  if (pathname === "/readyz" && request.method === "GET") {
    const ready = yield* dependencies.directory.ready.pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    )
    return json({ status: ready ? "ready" : "unavailable" }, dependencies.production, ready ? 200 : 503)
  }

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

  if (pathname === "/assets/control-plane.css" && request.method === "GET") {
    const response = new Response(webStyles, {
      headers: { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=3600" },
    })
    return secured(response, dependencies.production)
  }

  if (pathname === "/assets/control-plane.js" && request.method === "GET") {
    const response = new Response(webScript, {
      headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=3600" },
    })
    return secured(response, dependencies.production)
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
    const delegated = yield* dependencies.identity.handle(
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
    ).pipe(Effect.option)
    if (delegated._tag === "None") return json({ message: "Identity service unavailable" }, dependencies.production, 503)
    if (!delegated.value.ok) return secured(delegated.value, dependencies.production)
    const registration = yield* Effect.tryPromise({ try: () => delegated.value.clone().json(), catch: () => undefined }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(OAuthRegistrationResponse)),
      Effect.option,
    )
    if (registration._tag === "None")
      return json({ message: "Identity service returned an invalid registration" }, dependencies.production, 503)
    const stored = yield* dependencies.devices.register({
      clientId: registration.value.client_id,
      deviceId: decoded.value.reference_id.slice("cli-device:".length),
      publicJwk: decoded.value.jwk,
      jwkThumbprint: decoded.value.dpop_jkt,
    }).pipe(Effect.as(true), Effect.orElseSucceed(() => false))
    if (!stored) {
      yield* dependencies.devices.discard(registration.value.client_id).pipe(Effect.ignore)
      return json({ message: "CLI registration could not be persisted" }, dependencies.production, 503)
    }
    return secured(delegated.value, dependencies.production)
  }

  if (pathname === "/api/v1/me/context" && request.method === "GET") {
    const access = yield* accountAccess(request, dependencies)
    if (access._tag !== "account") return accessFailure(access, dependencies)
    return json(
      {
        account: {
          id: access.account.user.id,
          email: access.account.user.email,
          name: access.account.user.name,
        },
        organizations: access.account.memberships.map((membership) => membership.organization),
        projects: [],
      },
      dependencies.production,
    )
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

  if (isAuthPath(pathname)) {
    if (requiresOrganization(pathname)) {
      const access = yield* accountAccess(request, dependencies)
      if (access._tag !== "account")
        return isBrowserAuthorization(pathname, request) && (access._tag === "anonymous" || access._tag === "invalid")
          ? loginRedirect(url, dependencies.production)
          : accessFailure(access, dependencies)
      if (access.account.memberships.length === 0)
        return isBrowserAuthorization(pathname, request)
          ? organizationRedirect(url, dependencies.production)
          : json(
              { message: "Create or join an organization before authorizing a client" },
              dependencies.production,
              403,
            )
    }
    return yield* dependencies.identity.handle(request).pipe(
      Effect.map((response) => secured(response, dependencies.production)),
      Effect.orElseSucceed(() => json({ message: "Identity service unavailable" }, dependencies.production, 503)),
    )
  }

  if (request.method !== "GET") return json({ message: "Not found" }, dependencies.production, 404)

  const destination = safePath(url.searchParams.get("redirect"), url)
  if (pathname === "/login") return html(loginPage(destination), dependencies.production)
  if (pathname === "/signup") return html(signupPage(destination), dependencies.production)
  if (pathname === "/verify-email") {
    const token = url.searchParams.get("token")
    const callbackURL = safePath(url.searchParams.get("callbackURL"), url, "/organizations/new")
    return token === null
      ? html(verifyEmailPage(), dependencies.production)
      : redirect(
          `/api/auth/verify-email?token=${encodeURIComponent(token)}&callbackURL=${encodeURIComponent(callbackURL)}`,
          dependencies.production,
        )
  }
  if (pathname === "/forgot-password") return html(forgotPasswordPage(), dependencies.production)
  if (pathname === "/reset-password")
    return html(
      resetPasswordPage({
        token: url.searchParams.get("token") ?? "",
        error: url.searchParams.get("error") ?? "",
      }),
      dependencies.production,
    )

  if (pathname === "/organizations/new")
    return yield* protectedPage(request, url, dependencies, () => newOrganizationPage(destination), false)

  const invitation = /^\/invitations\/([^/]+)$/.exec(pathname)
  if (invitation?.[1] !== undefined)
    return yield* protectedPage(
      request,
      url,
      dependencies,
      () => invitationPage({ id: decodeURIComponent(invitation[1] as string), redirect: destination }),
      false,
    )

  if (pathname === "/device") {
    const userCode = url.searchParams.get("user_code") ?? ""
    return yield* protectedPage(request, url, dependencies, () => devicePage({ userCode, redirect: destination }), true)
  }

  if (pathname === "/device/approve") {
    const userCode = url.searchParams.get("user_code") ?? ""
    return yield* protectedPage(
      request,
      url,
      dependencies,
      () => deviceApprovalPage({ userCode, redirect: destination }),
      true,
    )
  }

  if (pathname === "/consent")
    return yield* protectedPage(
      request,
      url,
      dependencies,
      () => consentPage({ query: url.searchParams, redirect: destination }),
      true,
    )

  if (pathname === "/") return yield* protectedPage(request, url, dependencies, () => accountPage(), true)

  return html("<h1>Not found</h1>", dependencies.production, 404)
})

export const handleRequest = (input: { readonly request: Request; readonly dependencies: HttpDependencies }) =>
  routeRequest(input.request, input.dependencies).pipe(
    Effect.catchCause(() =>
      Effect.succeed(json({ message: "Internal server error" }, input.dependencies.production, 500)),
    ),
  )

export const makeWebRequestHandler = (dependencies: HttpDependencies) => (request: Request) =>
  Effect.runPromise(handleRequest({ request, dependencies }))
