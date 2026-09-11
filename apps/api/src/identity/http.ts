import { Effect, Schema } from "effect"
import type {
  Account,
  CliDeviceDirectory,
  CliInstallRegistration,
  IdentityDirectory,
  IdentityPrincipal,
  IdentityRuntime,
} from "@rika/identity"
import { HttpBodyError, readBoundedHttpText } from "../transport/body"

export interface IdentityHttpOptions {
  readonly identity: IdentityRuntime
  readonly directory: IdentityDirectory
  readonly devices: CliDeviceDirectory
}

export interface IdentityRequestAccess {
  readonly principal: IdentityPrincipal
  readonly account: Account
  readonly deviceId?: string
}

export class IdentityRequestAuthenticationError extends Schema.TaggedError<IdentityRequestAuthenticationError>()(
  "RikaApiV2IdentityRequestAuthenticationError",
  { kind: Schema.Literals(["anonymous", "invalid", "unavailable"]) },
) {}

class IdentityHttpFailure extends Schema.TaggedError<IdentityHttpFailure>()("RikaApiV2IdentityHttpFailure", {
  status: Schema.Int,
  message: Schema.String,
  authenticate: Schema.Boolean,
}) {}

const strict = <S extends Schema.Top>(schema: S) => schema.annotate({ parseOptions: { onExcessProperty: "error" } })

const CliRegistrationRequest = strict(
  Schema.Struct({
    reference_id: Schema.TemplateLiteral(["cli-device:", Schema.String.check(Schema.isUUID())]),
    token_endpoint_auth_method: Schema.Literal("none"),
    grant_types: Schema.Array(Schema.Literals(["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"])),
    scope: Schema.NonEmptyString,
    resource: Schema.NonEmptyString,
    dpop_jkt: Schema.NonEmptyString,
    jwk: strict(
      Schema.Struct({
        kty: Schema.Literal("EC"),
        crv: Schema.Literal("P-256"),
        x: Schema.NonEmptyString,
        y: Schema.NonEmptyString,
      }),
    ),
  }),
)

const CliRegistrationResponse = Schema.Struct({ client_id: Schema.NonEmptyString })

const InvitationRequest = strict(
  Schema.Struct({ email: Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) }),
)

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const authenticationFailure = (kind: IdentityRequestAuthenticationError["kind"]) =>
  kind === "unavailable"
    ? IdentityHttpFailure.make({ status: 503, message: "Identity service unavailable", authenticate: false })
    : IdentityHttpFailure.make({ status: 401, message: "Authentication required", authenticate: true })

const badRequest = (message: string) => IdentityHttpFailure.make({ status: 400, message, authenticate: false })

const notFound = (message: string) => IdentityHttpFailure.make({ status: 404, message, authenticate: false })

const requestTooLarge = () =>
  IdentityHttpFailure.make({ status: 413, message: "Request body is too large", authenticate: false })

const unavailable = (message = "Identity service unavailable") =>
  IdentityHttpFailure.make({ status: 503, message, authenticate: false })

const internalServerError = () =>
  IdentityHttpFailure.make({ status: 500, message: "Internal server error", authenticate: false })

const json = <Body>(body: Body, status = 200, authenticate = false) => {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  })
  if (authenticate) headers.set("www-authenticate", 'Bearer realm="rika"')
  return new Response(JSON.stringify(body), { status, headers })
}

const noContent = () => new Response(null, { status: 204, headers: { "cache-control": "no-store" } })

const errorResponse = (error: IdentityHttpFailure) => json({ message: error.message }, error.status, error.authenticate)

const isJson = (request: Request) => {
  const contentType = request.headers.get("content-type")
  return contentType !== null && /^application\/json(?:\s*;.*)?$/i.test(contentType)
}

const requestBodyFailure = (error: HttpBodyError, message: string) =>
  error.kind === "too-large" ? requestTooLarge() : badRequest(message)

const decodeCliRegistrationRequest = Effect.fn("RikaApiV2.IdentityHttp.decodeCliRegistrationRequest")(function* (
  request: Request,
) {
  if (!isJson(request)) return yield* badRequest("Invalid CLI registration")
  const body = yield* readBoundedHttpText(request.body, request.headers.get("content-length")).pipe(
    Effect.mapError((error) => requestBodyFailure(error, "Invalid CLI registration")),
  )
  return yield* Schema.decodeEffect(Schema.fromJsonString(CliRegistrationRequest))(body).pipe(
    Effect.mapError(() => badRequest("Invalid CLI registration")),
  )
})

const decodeInvitationRequest = Effect.fn("RikaApiV2.IdentityHttp.decodeInvitationRequest")(function* (
  request: Request,
) {
  if (!isJson(request)) return yield* badRequest("Invalid organization invitation")
  const body = yield* readBoundedHttpText(request.body, request.headers.get("content-length")).pipe(
    Effect.mapError((error) => requestBodyFailure(error, "Invalid organization invitation")),
  )
  return yield* Schema.decodeEffect(Schema.fromJsonString(InvitationRequest))(body).pipe(
    Effect.mapError(() => badRequest("Invalid organization invitation")),
  )
})

const decodeCliRegistrationResponse = Effect.fn("RikaApiV2.IdentityHttp.decodeCliRegistrationResponse")(
  function* (response: Response) {
    const body = yield* readBoundedHttpText(response.body, response.headers.get("content-length"))
    return yield* Schema.decodeEffect(Schema.fromJsonString(CliRegistrationResponse))(body)
  },
  Effect.mapError(() => unavailable("Identity service returned an invalid registration")),
)

const decodeInvitationResponse = Effect.fn("RikaApiV2.IdentityHttp.decodeInvitationResponse")(
  function* (response: Response) {
    const body = yield* readBoundedHttpText(response.body, response.headers.get("content-length"))
    return yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(body)
  },
  Effect.mapError(() => unavailable("Identity service returned an invalid response")),
)

export const authenticateIdentityRequest = Effect.fn("RikaApiV2.IdentityHttp.authenticateIdentityRequest")(function* (
  request: Request,
  options: IdentityHttpOptions,
) {
  const principal = yield* options.identity.identify(request).pipe(
    Effect.mapError((error) =>
      IdentityRequestAuthenticationError.make({ kind: error.kind === "invalid" ? "invalid" : "unavailable" }),
    ),
    Effect.flatMap((value) =>
      value === undefined
        ? Effect.fail(IdentityRequestAuthenticationError.make({ kind: "anonymous" }))
        : Effect.succeed(value),
    ),
  )
  const account = yield* options.directory.account(principal.userId).pipe(
    Effect.mapError(() => IdentityRequestAuthenticationError.make({ kind: "unavailable" })),
    Effect.flatMap((value) =>
      value === undefined
        ? Effect.fail(IdentityRequestAuthenticationError.make({ kind: "unavailable" }))
        : Effect.succeed(value),
    ),
  )
  const deviceId = yield* options.devices
    .authenticate(principal)
    .pipe(Effect.mapError(() => IdentityRequestAuthenticationError.make({ kind: "unavailable" })))
  if (principal.clientId !== undefined && deviceId === undefined)
    return yield* IdentityRequestAuthenticationError.make({ kind: "invalid" })
  const access: IdentityRequestAccess = { principal, account }
  return deviceId === undefined ? access : { ...access, deviceId }
})

const loginRedirect = (url: URL) => {
  const headers = new Headers({ "cache-control": "no-store" })
  headers.set("location", `/login?redirect=${encodeURIComponent(`${url.pathname}${url.search}`)}`)
  return new Response(null, { status: 303, headers })
}

const isAuthPath = (pathname: string) =>
  pathname === "/api/auth" ||
  pathname.startsWith("/api/auth/") ||
  pathname === "/.well-known/oauth-authorization-server/api/auth"

const requiresAuthentication = (pathname: string) =>
  pathname === "/api/auth/device/approve" ||
  pathname === "/api/auth/oauth2/authorize" ||
  pathname === "/api/auth/oauth2/consent"

const isBrowserAuthorization = (pathname: string, request: Request) =>
  pathname === "/api/auth/oauth2/authorize" && request.method === "GET"

const deviceRevocationPath = (pathname: string) => {
  const match = /^\/api\/v1\/auth\/cli\/devices\/([^/]+)\/revoke$/.exec(pathname)
  if (match?.[1] === undefined) return undefined
  try {
    const deviceId = decodeURIComponent(match[1])
    return deviceId.length === 0 ? undefined : deviceId
  } catch {
    return undefined
  }
}

const invitationPath = (pathname: string) => {
  const match = /^\/api\/v1\/organizations\/([^/]+)\/invitations$/.exec(pathname)
  if (match?.[1] === undefined) return undefined
  try {
    const organizationId = decodeURIComponent(match[1])
    return organizationId.length === 0 ? undefined : organizationId
  } catch {
    return undefined
  }
}

const handleOAuthRequest = Effect.fn("RikaApiV2.IdentityHttp.handleOAuthRequest")(function* (
  request: Request,
  options: IdentityHttpOptions,
) {
  const pathname = new URL(request.url).pathname
  if (requiresAuthentication(pathname)) {
    const access = yield* authenticateIdentityRequest(request, options).pipe(
      Effect.match({
        onFailure: (error) => ({ _tag: "failure" as const, error }),
        onSuccess: (value) => ({ _tag: "success" as const, value }),
      }),
    )
    if (access._tag === "failure") {
      if (
        isBrowserAuthorization(pathname, request) &&
        (access.error.kind === "anonymous" || access.error.kind === "invalid")
      )
        return loginRedirect(new URL(request.url))
      return yield* authenticationFailure(access.error.kind)
    }
  }
  return yield* options.identity.handle(request).pipe(Effect.mapError(() => unavailable()))
})

const handleCliRegistration = Effect.fn("RikaApiV2.IdentityHttp.handleCliRegistration")(function* (
  request: Request,
  options: IdentityHttpOptions,
) {
  const registration = yield* decodeCliRegistrationRequest(request)
  const origin = new URL(request.url).origin
  const resource = `${origin}/api/v1`
  if (registration.resource !== resource) return yield* badRequest("Invalid OAuth resource")
  const clientRegistration: CliInstallRegistration = {
    client_name: "Rika CLI",
    application_type: "native",
    token_endpoint_auth_method: "none",
    grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
    scope: "openid profile email offline_access account",
    software_id: "rika-cli",
    dpop_bound_access_tokens: true,
    resources: [resource],
  }
  const delegated = yield* options.identity
    .handle(
      new Request(`${origin}/api/auth/oauth2/register`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: encodeJson(clientRegistration),
      }),
    )
    .pipe(Effect.mapError(() => unavailable()))
  if (!delegated.ok) return yield* badRequest("CLI registration was rejected")
  const registered = yield* decodeCliRegistrationResponse(delegated)
  const persisted = yield* options.devices
    .register({
      clientId: registered.client_id,
      deviceId: registration.reference_id.slice("cli-device:".length),
      publicJwk: registration.jwk,
      jwkThumbprint: registration.dpop_jkt,
    })
    .pipe(
      Effect.match({
        onFailure: () => false,
        onSuccess: () => true,
      }),
    )
  if (!persisted) {
    yield* options.devices.discard(registered.client_id).pipe(Effect.ignore)
    return yield* unavailable("CLI registration could not be persisted")
  }
  return json({ client_id: registered.client_id }, 201)
})

const handleAccount = Effect.fn("RikaApiV2.IdentityHttp.handleAccount")(function* (
  request: Request,
  options: IdentityHttpOptions,
) {
  const access = yield* authenticateIdentityRequest(request, options).pipe(
    Effect.mapError((error) => authenticationFailure(error.kind)),
  )
  return json(access.account)
})

const handleListDevices = Effect.fn("RikaApiV2.IdentityHttp.handleListDevices")(function* (
  request: Request,
  options: IdentityHttpOptions,
) {
  const access = yield* authenticateIdentityRequest(request, options).pipe(
    Effect.mapError((error) => authenticationFailure(error.kind)),
  )
  const devices = yield* options.devices.list(access.principal).pipe(Effect.mapError(() => unavailable()))
  return json({ devices })
})

const handleRevokeDevice = Effect.fn("RikaApiV2.IdentityHttp.handleRevokeDevice")(function* (
  request: Request,
  deviceId: string,
  options: IdentityHttpOptions,
) {
  const access = yield* authenticateIdentityRequest(request, options).pipe(
    Effect.mapError((error) => authenticationFailure(error.kind)),
  )
  const revoked = yield* options.devices.revoke(access.principal, deviceId).pipe(Effect.mapError(() => unavailable()))
  if (!revoked) return yield* notFound("CLI device was not found")
  return noContent()
})

const handleRevokeAllDevices = Effect.fn("RikaApiV2.IdentityHttp.handleRevokeAllDevices")(function* (
  request: Request,
  options: IdentityHttpOptions,
) {
  const access = yield* authenticateIdentityRequest(request, options).pipe(
    Effect.mapError((error) => authenticationFailure(error.kind)),
  )
  if (access.deviceId === undefined || access.principal.clientId === undefined)
    return yield* IdentityHttpFailure.make({
      status: 401,
      message: "CLI device authentication required",
      authenticate: true,
    })
  yield* options.devices
    .revokeAll(access.principal)
    .pipe(Effect.mapError(() => unavailable("CLI device revocation failed")))
  return noContent()
})

const handleOrganizationInvitation = Effect.fn("RikaApiV2.IdentityHttp.handleOrganizationInvitation")(function* (
  request: Request,
  organizationId: string,
  options: IdentityHttpOptions,
) {
  const access = yield* authenticateIdentityRequest(request, options).pipe(
    Effect.mapError((error) => authenticationFailure(error.kind)),
  )
  const membership = access.account.memberships.find((candidate) => candidate.organization.id === organizationId)
  if (membership === undefined) return yield* notFound("Organization is unavailable")
  const invitation = yield* decodeInvitationRequest(request)
  const headers = new Headers(request.headers)
  headers.set("content-type", "application/json")
  headers.delete("content-length")
  const delegated = yield* options.identity
    .handle(
      new Request(`${new URL(request.url).origin}/api/auth/organization/invite-member`, {
        method: "POST",
        headers,
        body: encodeJson({ email: invitation.email, organizationId: membership.organization.id, role: "member" }),
      }),
    )
    .pipe(Effect.mapError(() => unavailable()))
  if (!delegated.ok) return yield* badRequest("Organization invitation was rejected")
  return json(yield* decodeInvitationResponse(delegated))
})

const isProtectedResourceMetadata = (pathname: string, method: string) =>
  pathname === "/.well-known/oauth-protected-resource/api/v1" && (method === "GET" || method === "HEAD")

const handleProtectedResourceMetadata = Effect.fn("RikaApiV2.IdentityHttp.handleProtectedResourceMetadata")(function* (
  request: Request,
  options: IdentityHttpOptions,
) {
  const metadata = yield* options.identity.protectedResourceMetadata.pipe(Effect.mapError(() => unavailable()))
  const response = json(metadata)
  return request.method === "HEAD"
    ? new Response(null, { status: response.status, headers: response.headers })
    : response
})

const routeGet = Effect.fn("RikaApiV2.IdentityHttp.routeGet")(function* (
  request: Request,
  pathname: string,
  options: IdentityHttpOptions,
) {
  if (pathname === "/api/account") return yield* handleAccount(request, options)
  if (pathname === "/api/v1/auth/cli/devices") return yield* handleListDevices(request, options)
  return undefined
})

const routePost = Effect.fn("RikaApiV2.IdentityHttp.routePost")(function* (
  request: Request,
  pathname: string,
  options: IdentityHttpOptions,
) {
  if (pathname === "/api/v1/auth/cli/registrations") return yield* handleCliRegistration(request, options)
  if (pathname === "/api/v1/auth/cli/devices/revoke-all") return yield* handleRevokeAllDevices(request, options)
  const deviceId = deviceRevocationPath(pathname)
  if (deviceId !== undefined) return yield* handleRevokeDevice(request, deviceId, options)
  const organizationId = invitationPath(pathname)
  if (organizationId !== undefined) return yield* handleOrganizationInvitation(request, organizationId, options)
  return undefined
})

const route = Effect.fn("RikaApiV2.IdentityHttp.route")(function* (request: Request, options: IdentityHttpOptions) {
  const pathname = new URL(request.url).pathname
  if (isProtectedResourceMetadata(pathname, request.method))
    return yield* handleProtectedResourceMetadata(request, options)
  if (isAuthPath(pathname)) return yield* handleOAuthRequest(request, options)
  if (request.method === "GET") return yield* routeGet(request, pathname, options)
  if (request.method === "POST") return yield* routePost(request, pathname, options)
  return undefined
})

export const makeIdentityRequestHandler = (options: IdentityHttpOptions) => (request: Request) =>
  route(request, options).pipe(
    Effect.catchTag("RikaApiV2IdentityHttpFailure", (error) => Effect.succeed(errorResponse(error))),
    Effect.catchCause(() => Effect.succeed(errorResponse(internalServerError()))),
  )
