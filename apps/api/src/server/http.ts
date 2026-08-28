import { Effect } from "effect"
import type {
  Account,
  CliDeviceDirectory,
  IdentityDirectory,
  IdentityPrincipal,
  IdentityRuntime,
  IdentityRuntimeError,
} from "@rika/identity"
import type { HostedProductService } from "../hosted/product"
import type { HostedThreadProtocolService } from "../hosted/thread/protocol"
import type { HostedModelRegistryService } from "../hosted/environment/model-registry"
import type { HostedProviderCredentialsService } from "../hosted/environment/provider-credentials"
import type { HostedEnvironmentService } from "../hosted/environment/runtime"
import type { HostedRecoveryService } from "../hosted/execution/recovery"
import type { HostedPublicationService } from "../hosted/publication"
import type { Runtime as Executor } from "../executor/service"
import type { ReadinessInterface as ExecutionReadiness } from "@rika/execution/postgres"
import type { HostedToolPolicyService } from "../hosted/execution/tool-policy"
import type { HostedWorkspaceSeedsService } from "../hosted/workspace-seeds"
import type { HostedThreadApplicationService } from "../hosted/thread/application"

export interface HttpDependencies {
  readonly identity: IdentityRuntime
  readonly directory: IdentityDirectory
  readonly devices: CliDeviceDirectory
  readonly product: HostedProductService
  readonly toolPolicy: HostedToolPolicyService
  readonly threads?: HostedThreadProtocolService
  readonly threadApplication?: HostedThreadApplicationService
  readonly credentials?: HostedProviderCredentialsService
  readonly environment?: HostedEnvironmentService
  readonly models?: HostedModelRegistryService
  readonly recovery: HostedRecoveryService
  readonly publication?: HostedPublicationService
  readonly executor: Executor
  readonly workspaceSeeds?: HostedWorkspaceSeedsService
  readonly execution: ExecutionReadiness
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

export const secureResponse = (production: boolean) => (response: Response) => secured(response, production)

const json = <Body>(body: Body, production: boolean, status = 200, extraHeaders?: Headers) => {
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
  const access: Extract<AccountAccess, { readonly _tag: "account" }> = {
    _tag: "account",
    account: account.value,
    principal: identity.principal,
  }
  return device.value === undefined ? access : { ...access, deviceId: device.value }
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
