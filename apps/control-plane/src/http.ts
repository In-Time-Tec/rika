import { Effect } from "effect"
import type { Account, IdentityDirectory, IdentityRuntime, IdentityRuntimeError } from "@rika/identity"
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
  readonly production: boolean
}

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
  | { readonly _tag: "account"; readonly account: Account }
  | { readonly _tag: "anonymous" }
  | { readonly _tag: "invalid" }
  | { readonly _tag: "unavailable" }

const accountAccess = Effect.fn("ControlPlaneHttp.accountAccess")(function* (
  request: Request,
  dependencies: HttpDependencies,
): Effect.fn.Return<AccountAccess> {
  const identity = yield* dependencies.identity.identify(request).pipe(
    Effect.map((userId) => ({ _tag: "identity" as const, userId })),
    Effect.catch((error: IdentityRuntimeError) =>
      Effect.succeed(error.kind === "invalid" ? { _tag: "invalid" as const } : { _tag: "unavailable" as const }),
    ),
  )
  if (identity._tag === "invalid") return { _tag: "invalid" }
  if (identity._tag === "unavailable") return { _tag: "unavailable" }
  if (identity.userId === undefined) return { _tag: "anonymous" }
  const account = yield* dependencies.directory.account(identity.userId).pipe(
    Effect.map((value) => ({ _tag: "value" as const, value })),
    Effect.orElseSucceed(() => ({ _tag: "unavailable" as const })),
  )
  if (account._tag === "unavailable" || account.value === undefined) return { _tag: "unavailable" }
  return { _tag: "account", account: account.value }
})

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
    pathname === "/.well-known/oauth-protected-resource/api" &&
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
