/* oxlint-disable typescript/no-dynamic-delete -- private transport headers are normalized by exact protocol keys. */
import { Effect, Schema } from "effect"
import type { Principal, Resource } from "generalist/server"
import { ProjectId } from "@rika/product/hosted-model"
import { threadPartition } from "../runtime/partition"
import { authorizeResource, ProductAuthorizationError, type ProductAuthorityService } from "../product/authority"
import type {
  ProductRouteError,
  ProductRouteService,
  ProductThreadScope,
  ThreadMetadata,
  ThreadPage,
} from "../product/routes"
import type { RuntimeGateway, RuntimeWebSocket } from "./runtime-gateway"
import {
  RIKA_DOWNSTREAM_CREDENTIAL,
  RIKA_ORIGINAL_AUTHORIZATION,
  RIKA_ORIGINAL_REQUEST_METHOD,
  RIKA_ORIGINAL_REQUEST_URL,
} from "./rivet-protocol"

export class ApiV2HttpError extends Schema.TaggedError<ApiV2HttpError>()("RikaApiV2HttpError", {
  status: Schema.Int,
  message: Schema.String,
}) {}

const errorResponse = (error: ApiV2HttpError) =>
  new Response(JSON.stringify({ message: error.message }), {
    status: error.status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  })

const bearer = (request: Request) => {
  const value = request.headers.get("authorization")
  if (value === null) return undefined
  const match = /^(?:Bearer|DPoP) (\S+)$/i.exec(value)
  return match?.[1]
}

const productSessionPath = (pathname: string) => {
  const match = /^\/api\/v2\/threads\/([^/]+)\/session$/.exec(pathname)
  if (match?.[1] === undefined) return undefined
  try {
    return decodeURIComponent(match[1])
  } catch {
    return undefined
  }
}

const runtimePath = (pathname: string) => {
  const match = /^\/api\/v2\/threads\/([^/]+)\/runtime(?:\/(.*))?$/.exec(pathname)
  if (match?.[1] === undefined) return undefined
  let threadId: string
  try {
    threadId = decodeURIComponent(match[1])
  } catch {
    return undefined
  }
  const suffix = match[2] === undefined || match[2] === "" ? "/" : `/${match[2]}`
  return { threadId, upstreamPath: suffix }
}

const productThreadsPath = (pathname: string) => {
  if (pathname === "/api/v2/threads") return { threadId: undefined }
  const match = /^\/api\/v2\/threads\/([^/]+)$/.exec(pathname)
  if (match?.[1] === undefined) return undefined
  try {
    return { threadId: decodeURIComponent(match[1]) }
  } catch {
    return undefined
  }
}

const edgeRequest = (request: Request) => {
  const clone = request.clone()
  const headers = Object.fromEntries(clone.headers.entries())
  delete headers[RIKA_DOWNSTREAM_CREDENTIAL]
  delete headers[RIKA_ORIGINAL_AUTHORIZATION]
  delete headers[RIKA_ORIGINAL_REQUEST_METHOD]
  delete headers[RIKA_ORIGINAL_REQUEST_URL]
  const init: RequestInit = { method: clone.method, headers }
  if (clone.method !== "GET" && clone.method !== "HEAD" && clone.body !== null)
    Object.assign(init, { body: clone.body, duplex: "half" })
  return new Request(request.url, init)
}

const upstreamRequest = (request: Request, pathname: string, downstreamCredential: string | undefined) => {
  const clone = request.clone()
  const headers = Object.fromEntries(clone.headers.entries())
  headers[RIKA_ORIGINAL_REQUEST_URL] = request.url
  headers[RIKA_ORIGINAL_REQUEST_METHOD] = clone.method
  delete headers[RIKA_ORIGINAL_AUTHORIZATION]
  if (downstreamCredential === undefined) delete headers[RIKA_DOWNSTREAM_CREDENTIAL]
  else headers[RIKA_DOWNSTREAM_CREDENTIAL] = downstreamCredential
  const init: RequestInit = { method: clone.method, headers }
  if (clone.method !== "GET" && clone.method !== "HEAD" && clone.body !== null)
    Object.assign(init, { body: clone.body, duplex: "half" })
  const target = new URL(pathname, request.url)
  target.search = new URL(request.url).search
  return new Request(target.toString(), init)
}

const upstreamResource = (pathname: string): Resource | undefined => {
  if (pathname === "/sessions") return { type: "session" }
  if (pathname === "/runs") return { type: "run" }
  if (pathname === "/artifacts") return { type: "artifact" }
  const session = /^\/sessions\/([^/]+)(?:\/|$)/.exec(pathname)?.[1]
  if (session !== undefined) return { type: "session", id: decodeURIComponent(session) }
  const run = /^\/runs\/([^/]+)(?:\/|$)/.exec(pathname)?.[1]
  if (run !== undefined) return { type: "run", id: decodeURIComponent(run) }
  const artifact = /^\/artifacts\/([^/]+)(?:\/|$)/.exec(pathname)?.[1]
  if (artifact !== undefined) return { type: "artifact", id: decodeURIComponent(artifact) }
  return undefined
}

const unauthorized = () => ApiV2HttpError.make({ status: 401, message: "Authentication required" })
const unavailable = () => ApiV2HttpError.make({ status: 503, message: "Rika service unavailable" })
const forbidden = () => ApiV2HttpError.make({ status: 403, message: "Execution resource is unavailable" })
const healthBody = JSON.stringify({ status: "ok" })
const receiptBody = (receipt: { readonly sessionId: string; readonly created: boolean }) => JSON.stringify(receipt)
const productBody = (value: ThreadMetadata | ThreadPage) => JSON.stringify(value)
const productResponse = (value: ThreadMetadata | ThreadPage, status = 200) =>
  new Response(productBody(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  })

interface AuthenticationContext {
  readonly threadId?: string
  readonly request: Request
}

const authenticateRequest = Effect.fn("RikaApiV2.Http.authenticateRequest")(function* (input: {
  readonly authority: ProductAuthorityService
  readonly request: Request
  readonly requestedThreadId: string | undefined
  readonly resourceThreadId: string | undefined
}) {
  const token = bearer(input.request)
  if (token === undefined) return yield* unauthorized()
  const context: AuthenticationContext = { request: input.request }
  if (input.requestedThreadId !== undefined) Object.assign(context, { threadId: input.requestedThreadId })
  else if (input.resourceThreadId !== undefined) Object.assign(context, { threadId: input.resourceThreadId })
  return yield* input.authority.authenticateBearer(token, context).pipe(
    Effect.mapError(() => unavailable()),
    Effect.flatMap((value) => (value === undefined ? unauthorized() : Effect.succeed(value))),
  )
})

const handleSessionRequest = Effect.fn("RikaApiV2.Http.handleSessionRequest")(function* (input: {
  readonly authority: ProductAuthorityService
  readonly gateway: RuntimeGateway
  readonly environment: string
  readonly request: Request
  readonly principal: Principal
  readonly threadId: string
}) {
  if (input.request.method !== "POST") return new Response("Method not allowed", { status: 405 })
  const binding = yield* input.authority
    .threadBinding(input.threadId, input.principal.tenantId)
    .pipe(Effect.mapError(() => unavailable()))
  if (binding === undefined) return yield* forbidden()
  const partition = threadPartition({
    environment: input.environment,
    ownerId: binding.partition.ownerId,
    threadId: input.threadId,
    target: binding.partition.target,
  })
  const allowed = yield* authorizeResource(input.authority, {
    principal: input.principal,
    resource: { type: "session", id: partition.rootSessionId },
    action: "mutate",
    threadId: input.threadId,
  }).pipe(Effect.mapError(() => unavailable()))
  if (!allowed) return yield* forbidden()
  const commandId = input.request.headers.get("x-command-id")
  if (commandId === null || commandId.length === 0)
    return yield* ApiV2HttpError.make({ status: 400, message: "x-command-id is required" })
  const receipt = yield* input.gateway
    .ensureRootSession(partition, commandId, input.request)
    .pipe(Effect.mapError(() => unavailable()))
  return new Response(receiptBody(receipt), {
    status: receipt.created ? 201 : 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  })
})

const handleResourceRequest = Effect.fn("RikaApiV2.Http.handleResourceRequest")(function* (input: {
  readonly authority: ProductAuthorityService
  readonly gateway: RuntimeGateway
  readonly environment: string
  readonly request: Request
  readonly principal: Principal
  readonly resource: Resource
  readonly threadId: string
  readonly websocket: RuntimeWebSocket | undefined
}) {
  const binding = yield* input.authority
    .threadBinding(input.threadId, input.principal.tenantId)
    .pipe(Effect.mapError(() => unavailable()))
  if (binding === undefined) return yield* forbidden()
  const partition = threadPartition({
    environment: input.environment,
    ownerId: binding.partition.ownerId,
    threadId: input.threadId,
    target: binding.partition.target,
  })
  const allowed = yield* authorizeResource(input.authority, {
    principal: input.principal,
    resource: input.resource,
    action: input.request.method === "GET" ? "observe" : "mutate",
    threadId: input.threadId,
  }).pipe(Effect.mapError(() => unavailable()))
  if (!allowed) return yield* forbidden()
  return yield* input.gateway
    .handle(partition, input.request, input.websocket)
    .pipe(Effect.mapError(() => unavailable()))
})

const parseProductLimit = (request: Request) => {
  const value = new URL(request.url).searchParams.get("limit")
  if (value === null) return 50
  if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(value)) return undefined
  return Number(value)
}

const productFailure = (error: ProductRouteError) => {
  if (error.kind === "invalid") return ApiV2HttpError.make({ status: 400, message: error.message })
  if (error.kind === "forbidden") return ApiV2HttpError.make({ status: 403, message: error.message })
  return unavailable()
}

const organizationPrefix = "organization:"

const productThreadScope = Effect.fn("RikaApiV2.Http.productThreadScope")(function* (request: Request) {
  const search = new URL(request.url).searchParams
  const scope: ProductThreadScope = {}
  const owner = search.get("owner")
  if (owner !== null && owner !== "personal") {
    if (!owner.startsWith(organizationPrefix) || owner.length === organizationPrefix.length)
      return yield* ApiV2HttpError.make({
        status: 400,
        message: 'owner must be "personal" or "organization:<organizationId>"',
      })
    Object.assign(scope, {
      owner: { kind: "organization" as const, organization_id: owner.slice(organizationPrefix.length) },
    })
  }
  const projectId = search.get("project_id")
  if (projectId !== null)
    Object.assign(scope, {
      projectId: yield* Schema.decodeEffect(ProjectId)(projectId).pipe(
        Effect.mapError(() => ApiV2HttpError.make({ status: 400, message: "project_id is invalid" })),
      ),
    })
  return scope
})

const handleProductRequest = Effect.fn("RikaApiV2.Http.handleProductRequest")(function* (input: {
  readonly product: ProductRouteService | undefined
  readonly request: Request
  readonly route: { readonly threadId: string | undefined }
  readonly principal: Principal
}) {
  if (input.request.method !== "GET") return new Response("Method not allowed", { status: 405 })
  if (input.product === undefined) return yield* unavailable()
  const scope = yield* productThreadScope(input.request)
  if (input.route.threadId === undefined) {
    const limit = parseProductLimit(input.request)
    if (limit === undefined)
      return yield* ApiV2HttpError.make({ status: 400, message: "limit must be between 1 and 100" })
    const cursor = new URL(input.request.url).searchParams.get("cursor") ?? undefined
    const listInput = { principal: input.principal, limit, scope }
    if (cursor !== undefined) Object.assign(listInput, { cursor })
    const page = yield* input.product.listThreads(listInput).pipe(Effect.mapError(productFailure))
    return productResponse(page)
  }
  const thread = yield* input.product
    .thread({ principal: input.principal, threadId: input.route.threadId, scope })
    .pipe(Effect.mapError(productFailure))
  if (thread === undefined) return new Response('{"message":"Thread is unavailable"}', { status: 404 })
  return productResponse(thread)
})

const handle = (input: {
  readonly authority: ProductAuthorityService
  readonly product?: ProductRouteService
  readonly gateway: RuntimeGateway
  readonly environment: string
  readonly request: Request
  readonly websocket?: RuntimeWebSocket
}) =>
  Effect.gen(function* () {
    const request = edgeRequest(input.request)
    const pathname = new URL(request.url).pathname
    if (pathname === "/healthz") return new Response(healthBody, { status: 200 })

    const productRoute = productThreadsPath(pathname)
    if (productRoute !== undefined) {
      const principal = yield* authenticateRequest({
        authority: input.authority,
        request,
        requestedThreadId: productRoute.threadId,
        resourceThreadId: undefined,
      })
      return yield* handleProductRequest({
        product: input.product,
        request,
        route: productRoute,
        principal,
      })
    }

    const route = runtimePath(pathname)
    const productSessionThreadId = productSessionPath(pathname)
    const requestedThreadId = productSessionThreadId ?? route?.threadId
    const upstreamPath = route?.upstreamPath ?? pathname
    const resource = upstreamResource(upstreamPath)
    const resourceThreadId =
      route?.threadId ??
      (resource === undefined
        ? undefined
        : yield* input.authority.resourceThread(resource).pipe(Effect.mapError(() => unavailable())))
    const principal = yield* authenticateRequest({
      authority: input.authority,
      request,
      requestedThreadId,
      resourceThreadId,
    })
    const downstream = (threadId: string | undefined): Effect.Effect<string | undefined, ProductAuthorizationError> => {
      if (threadId === undefined || input.authority.downstreamCredential === undefined)
        return Effect.map(Effect.void, () => undefined)
      return input.authority.downstreamCredential({ principal, ownerId: principal.tenantId, threadId, request })
    }
    if (productSessionThreadId !== undefined)
      return yield* downstream(productSessionThreadId).pipe(
        Effect.mapError(() => unavailable()),
        Effect.flatMap((downstreamCredential) =>
          handleSessionRequest({
            authority: input.authority,
            gateway: input.gateway,
            environment: input.environment,
            request: upstreamRequest(request, upstreamPath, downstreamCredential),
            principal,
            threadId: productSessionThreadId,
          }),
        ),
      )
    if (resource === undefined) return new Response("Not found", { status: 404 })
    if (resourceThreadId === undefined) return yield* forbidden()
    return yield* downstream(resourceThreadId).pipe(
      Effect.mapError(() => unavailable()),
      Effect.flatMap((downstreamCredential) =>
        handleResourceRequest({
          authority: input.authority,
          gateway: input.gateway,
          environment: input.environment,
          request: upstreamRequest(request, upstreamPath, downstreamCredential),
          principal,
          resource,
          threadId: resourceThreadId,
          websocket: input.websocket,
        }),
      ),
    )
  })

export const handleApiV2Request = (input: Parameters<typeof handle>[0]) =>
  handle(input).pipe(Effect.catchTag("RikaApiV2HttpError", (error) => Effect.succeed(errorResponse(error))))
