import { Effect, Schema } from "effect"
import type { Principal, Resource } from "generalist/server"
import { threadPartition } from "./partition"
import { authorizeResource, type ProductAuthorityService } from "./product-authority"
import type { RuntimeGateway, RuntimeWebSocket } from "./runtime-gateway"

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
  const match = /^Bearer (\S+)$/.exec(value)
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

const upstreamResource = (pathname: string): Resource | undefined => {
  const session = /^\/sessions\/([^/]+)(?:\/|$)/.exec(pathname)?.[1]
  if (session !== undefined) return { type: "session", id: decodeURIComponent(session) }
  const run = /^\/runs\/([^/]+)(?:\/|$)/.exec(pathname)?.[1]
  if (run !== undefined) return { type: "run", id: decodeURIComponent(run) }
  return undefined
}

const unauthorized = () => ApiV2HttpError.make({ status: 401, message: "Authentication required" })
const unavailable = () => ApiV2HttpError.make({ status: 503, message: "Rika service unavailable" })
const forbidden = () => ApiV2HttpError.make({ status: 403, message: "Execution resource is unavailable" })
const healthBody = JSON.stringify({ status: "ok" })
const receiptBody = (receipt: { readonly sessionId: string; readonly created: boolean }) => JSON.stringify(receipt)

const authenticateRequest = Effect.fn("RikaApiV2.Http.authenticateRequest")(function* (input: {
  readonly authority: ProductAuthorityService
  readonly request: Request
  readonly requestedThreadId: string | undefined
  readonly resourceThreadId: string | undefined
}) {
  const token = bearer(input.request)
  if (token === undefined) return yield* unauthorized()
  let context: { readonly threadId: string; readonly request: Request } | undefined
  if (input.requestedThreadId !== undefined) context = { threadId: input.requestedThreadId, request: input.request }
  else if (input.resourceThreadId !== undefined) context = { threadId: input.resourceThreadId, request: input.request }
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
  }).pipe(Effect.mapError(() => unavailable()))
  if (!allowed) return yield* forbidden()
  const commandId = input.request.headers.get("x-command-id")
  if (commandId === null || commandId.length === 0)
    return yield* ApiV2HttpError.make({ status: 400, message: "x-command-id is required" })
  const receipt = yield* input.gateway
    .ensureRootSession(partition, commandId)
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
  }).pipe(Effect.mapError(() => unavailable()))
  if (!allowed) return yield* forbidden()
  return yield* input.gateway
    .handle(partition, input.request, input.websocket)
    .pipe(Effect.mapError(() => unavailable()))
})

const handle = (input: {
  readonly authority: ProductAuthorityService
  readonly gateway: RuntimeGateway
  readonly environment: string
  readonly request: Request
  readonly websocket?: RuntimeWebSocket
}) =>
  Effect.gen(function* () {
    const { request } = input
    const pathname = new URL(request.url).pathname
    if (pathname === "/healthz") return new Response(healthBody, { status: 200 })

    const requestedThreadId = productSessionPath(pathname)
    const resource = requestedThreadId === undefined ? upstreamResource(pathname) : undefined
    const resourceThreadId =
      resource === undefined
        ? undefined
        : yield* input.authority.resourceThread(resource).pipe(Effect.mapError(() => unavailable()))
    const principal = yield* authenticateRequest({
      authority: input.authority,
      request,
      requestedThreadId,
      resourceThreadId,
    })
    if (requestedThreadId !== undefined)
      return yield* handleSessionRequest({
        authority: input.authority,
        gateway: input.gateway,
        environment: input.environment,
        request,
        principal,
        threadId: requestedThreadId,
      })
    if (resource === undefined) return new Response("Not found", { status: 404 })
    if (resourceThreadId === undefined) return yield* forbidden()
    return yield* handleResourceRequest({
      authority: input.authority,
      gateway: input.gateway,
      environment: input.environment,
      request,
      principal,
      resource,
      threadId: resourceThreadId,
      websocket: input.websocket,
    })
  })

export const handleApiV2Request = (input: Parameters<typeof handle>[0]) =>
  handle(input).pipe(Effect.catchTag("RikaApiV2HttpError", (error) => Effect.succeed(errorResponse(error))))
