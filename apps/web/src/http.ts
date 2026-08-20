import { Effect } from "effect"
import { AccountGateway, type Account } from "./account-gateway"
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

export interface WebDependencies {
  readonly production: boolean
  readonly accountGateway: AccountGateway["Service"]
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

const response = (
  body: string | null,
  input: { readonly production: boolean; readonly status?: number; readonly headers?: Headers },
) => {
  const headers = securityHeaders(input.production)
  input.headers?.forEach((value, name) => headers.set(name, value))
  return new Response(body, { headers, ...(input.status === undefined ? {} : { status: input.status }) })
}

const html = (body: string, production: boolean, status = 200) =>
  response(body, {
    production,
    status,
    headers: new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }),
  })

const redirect = (location: string, production: boolean) =>
  response(null, { production, status: 303, headers: new Headers({ location, "cache-control": "no-store" }) })

const safePath = (value: string | null, requestUrl: URL, fallback = "/") => {
  if (value === null || !value.startsWith("/")) return fallback
  const destination = new URL(value, requestUrl.origin)
  return destination.origin === requestUrl.origin
    ? `${destination.pathname}${destination.search}${destination.hash}`
    : fallback
}

const currentPath = (url: URL) => `${url.pathname}${url.search}`

const loginRedirect = (url: URL, production: boolean) =>
  redirect(`/login?redirect=${encodeURIComponent(currentPath(url))}`, production)

const organizationRedirect = (url: URL, production: boolean) =>
  redirect(`/organizations/new?redirect=${encodeURIComponent(currentPath(url))}`, production)

const guarded = Effect.fn("WebHttp.guarded")(function* (
  request: Request,
  url: URL,
  dependencies: WebDependencies,
  render: (account: Account) => string,
  organizationRequired: boolean,
) {
  const access = yield* dependencies.accountGateway.account({
    cookie: request.headers.get("cookie") ?? undefined,
    signal: request.signal,
  })
  if (access._tag === "anonymous") return loginRedirect(url, dependencies.production)
  if (access._tag === "unavailable") return html("<h1>Service unavailable</h1>", dependencies.production, 503)
  if (organizationRequired && access.account.memberships.length === 0)
    return organizationRedirect(url, dependencies.production)
  return html(render(access.account), dependencies.production)
})

const route = Effect.fn("WebHttp.route")(function* (request: Request, dependencies: WebDependencies) {
  const url = new URL(request.url)
  const { pathname } = url
  if (pathname === "/healthz")
    return response('{"status":"ok"}', {
      production: dependencies.production,
      headers: new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }),
    })
  if (request.method !== "GET") return html("<h1>Not found</h1>", dependencies.production, 404)
  if (pathname === "/assets/web.css")
    return response(webStyles, {
      production: dependencies.production,
      headers: new Headers({ "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=3600" }),
    })
  if (pathname === "/assets/web.js")
    return response(webScript, {
      production: dependencies.production,
      headers: new Headers({
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=3600",
      }),
    })
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
      resetPasswordPage({ token: url.searchParams.get("token") ?? "", error: url.searchParams.get("error") ?? "" }),
      dependencies.production,
    )
  if (pathname === "/organizations/new")
    return yield* guarded(request, url, dependencies, () => newOrganizationPage(destination), false)
  const invitation = /^\/invitations\/([^/]+)$/.exec(pathname)
  if (invitation?.[1] !== undefined)
    return yield* guarded(
      request,
      url,
      dependencies,
      () => invitationPage({ id: decodeURIComponent(invitation[1] as string), redirect: destination }),
      false,
    )
  if (pathname === "/device") {
    const userCode = url.searchParams.get("user_code") ?? ""
    return yield* guarded(request, url, dependencies, () => devicePage({ userCode, redirect: destination }), true)
  }
  if (pathname === "/device/approve") {
    const userCode = url.searchParams.get("user_code") ?? ""
    return yield* guarded(
      request,
      url,
      dependencies,
      () => deviceApprovalPage({ userCode, redirect: destination }),
      true,
    )
  }
  if (pathname === "/consent")
    return yield* guarded(
      request,
      url,
      dependencies,
      () => consentPage({ query: url.searchParams, redirect: destination }),
      true,
    )
  if (pathname === "/") return yield* guarded(request, url, dependencies, () => accountPage(), true)
  return html("<h1>Not found</h1>", dependencies.production, 404)
})

export const handleRequest = (input: { readonly request: Request; readonly dependencies: WebDependencies }) =>
  route(input.request, input.dependencies).pipe(
    Effect.catchCause(() => Effect.succeed(html("<h1>Internal server error</h1>", input.dependencies.production, 500))),
  )
