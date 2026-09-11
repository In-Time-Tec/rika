import { Effect, Schema } from "effect"
import {
  ThreadArchiveReceipt,
  ThreadArchiveRequest,
  ThreadCreateRequest,
  ThreadCreationReceipt,
  type ThreadCreateRequestEncoded,
} from "@rika/product/thread-creation"

export const ProductIdentity = Schema.Struct({
  userId: Schema.String,
  ownerId: Schema.String,
  displayName: Schema.optionalKey(Schema.String),
})
export type ProductIdentity = typeof ProductIdentity.Type

export const ThreadAccess = Schema.Struct({
  threadId: Schema.String,
  role: Schema.Literals(["viewer", "controller", "operator", "owner"]),
})
export type ThreadAccess = typeof ThreadAccess.Type

export const ThreadMetadata = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  target: Schema.Literals(["runner", "orb"]),
  sessionId: Schema.optionalKey(Schema.String),
  updatedAt: Schema.optionalKey(Schema.String),
})
export type ThreadMetadata = typeof ThreadMetadata.Type

export const ThreadPage = Schema.Struct({
  threads: Schema.Array(ThreadMetadata),
  nextCursor: Schema.NullOr(Schema.String),
})
export type ThreadPage = typeof ThreadPage.Type

export const ModelCatalogEntry = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  model: Schema.String,
  reasoning: Schema.String,
})
export type ModelCatalogEntry = typeof ModelCatalogEntry.Type

export const ModelCatalog = Schema.Struct({
  modes: Schema.Array(ModelCatalogEntry),
})
export type ModelCatalog = typeof ModelCatalog.Type

export const SessionReceipt = Schema.Struct({
  sessionId: Schema.String,
  created: Schema.Boolean,
})
export type SessionReceipt = typeof SessionReceipt.Type

export class ProductClientError extends Schema.TaggedError<ProductClientError>()("RikaClientV2ProductError", {
  kind: Schema.Literals(["network", "unauthorized", "forbidden", "protocol"]),
  message: Schema.String,
  status: Schema.optionalKey(Schema.Int),
}) {}

export interface ProductTransport {
  readonly request: (request: Request) => Effect.Effect<Response, ProductClientError>
}

type HeaderInput = Record<string, string>
type ProductRequestBody = ThreadCreateRequestEncoded

export interface ProductRequestHeadersInput {
  readonly method: string
  readonly url: string
}

export type ProductRequestHeaders = (
  input: ProductRequestHeadersInput,
) => Effect.Effect<Readonly<Record<string, string>>, never>

export interface ProductPaths {
  readonly identity: string
  readonly threads: string
  readonly thread: (threadId: string) => string
  readonly archive: (threadId: string) => string
  readonly access: (threadId: string) => string
  readonly catalog: string
  readonly session: (threadId: string) => string
}

/** Catalog scoping for `GET /api/v2/threads`: `owner` defaults to `personal` when omitted. */
export interface ThreadCatalogScope {
  readonly owner?:
    | { readonly kind: "personal" }
    | { readonly kind: "organization"; readonly organization_id: string }
    | undefined
  readonly projectId?: string | undefined
}

export interface ProductClient {
  readonly identity: Effect.Effect<ProductIdentity, ProductClientError>
  readonly listThreads: (input?: {
    readonly cursor?: string
    readonly limit?: number
    readonly scope?: ThreadCatalogScope | undefined
  }) => Effect.Effect<ThreadPage, ProductClientError>
  readonly thread: (threadId: string) => Effect.Effect<ThreadMetadata, ProductClientError>
  readonly access: (threadId: string) => Effect.Effect<ThreadAccess, ProductClientError>
  readonly catalog: Effect.Effect<ModelCatalog, ProductClientError>
  readonly createThread: (input: ThreadCreateRequestEncoded) => Effect.Effect<ThreadCreationReceipt, ProductClientError>
  readonly archiveThread: (threadId: string) => Effect.Effect<ThreadArchiveReceipt, ProductClientError>
  readonly ensureSession: (threadId: string, commandId: string) => Effect.Effect<SessionReceipt, ProductClientError>
}

const defaultPaths: ProductPaths = {
  identity: "/api/v2/identity",
  threads: "/api/v2/threads",
  thread: (threadId) => `/api/v2/threads/${encodeURIComponent(threadId)}`,
  archive: (threadId) => `/api/v2/threads/${encodeURIComponent(threadId)}/archive`,
  access: (threadId) => `/api/v2/threads/${encodeURIComponent(threadId)}/access`,
  catalog: "/api/v2/catalog",
  session: (threadId) => `/api/v2/threads/${encodeURIComponent(threadId)}/session`,
}

const joinUrl = (baseUrl: string | URL, path: string): string => {
  const base = new URL(baseUrl)
  if (path.startsWith("http://") || path.startsWith("https://")) return path
  return new URL(path.replace(/^\//, ""), `${base.toString().replace(/\/$/, "")}/`).toString()
}

const decodeJson = <A, S extends Schema.Schema<A>>(schema: S, response: Response, message: string) =>
  Effect.tryPromise({
    try: () => response.json(),
    catch: () => ProductClientError.make({ kind: "protocol", message, status: response.status }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError(() => ProductClientError.make({ kind: "protocol", message, status: response.status })),
  )

const statusError = (response: Response) => {
  let kind: ProductClientError["kind"] = "protocol"
  if (response.status === 401) kind = "unauthorized"
  else if (response.status === 403) kind = "forbidden"
  return ProductClientError.make({
    kind,
    message: `Product request failed (${response.status})`,
    status: response.status,
  })
}

const makeRequest = (input: {
  readonly transport: ProductTransport
  readonly baseUrl: string | URL
  readonly bearerToken?: string
  readonly requestHeaders?: ProductRequestHeaders
  readonly paths: ProductPaths
}) => {
  const request = (method: string, path: string, body?: ProductRequestBody, headers?: HeaderInput) => {
    const url = joinUrl(input.baseUrl, path)
    const auth =
      input.requestHeaders === undefined
        ? Effect.succeed<Readonly<Record<string, string>>>({})
        : input.requestHeaders({ method, url })
    return auth.pipe(
      Effect.flatMap((extra) => {
        const requestHeaders = new Headers(headers)
        for (const [name, value] of Object.entries(extra)) requestHeaders.set(name, value)
        if (input.bearerToken !== undefined && !requestHeaders.has("authorization"))
          requestHeaders.set("authorization", `Bearer ${input.bearerToken}`)
        if (body !== undefined) requestHeaders.set("content-type", "application/json")
        const init: RequestInit = { method, headers: requestHeaders }
        if (body !== undefined) init.body = JSON.stringify(body)
        return input.transport.request(new Request(url, init))
      }),
    )
  }
  return <A, S extends Schema.Schema<A>>(
    method: string,
    path: string,
    schema: S,
    body?: ProductRequestBody,
    headers?: HeaderInput,
  ) =>
    request(method, path, body, headers).pipe(
      Effect.flatMap((response) =>
        response.ok ? decodeJson(schema, response, "Product response was invalid") : Effect.fail(statusError(response)),
      ),
    )
}

export const makeProductClient = (options: {
  readonly baseUrl: string | URL
  readonly transport: ProductTransport
  readonly requestHeaders?: ProductRequestHeaders
  readonly bearerToken?: string
  readonly paths?: Partial<ProductPaths>
}): ProductClient => {
  const paths = { ...defaultPaths, ...options.paths }
  const request = makeRequest({ ...options, paths })
  return {
    identity: request("GET", paths.identity, ProductIdentity),
    listThreads: (input = {}) => {
      const query = new URLSearchParams()
      if (input.cursor !== undefined) query.set("cursor", input.cursor)
      if (input.limit !== undefined) query.set("limit", String(input.limit))
      const owner = input.scope?.owner
      query.set("owner", owner?.kind === "organization" ? `organization:${owner.organization_id}` : "personal")
      if (input.scope?.projectId !== undefined) query.set("project_id", input.scope.projectId)
      return request("GET", `${paths.threads}?${query.toString()}`, ThreadPage)
    },
    thread: (threadId) => request("GET", paths.thread(threadId), ThreadMetadata),
    access: (threadId) => request("GET", paths.access(threadId), ThreadAccess),
    catalog: request("GET", paths.catalog, ModelCatalog),
    createThread: (input) =>
      Schema.decodeEffect(ThreadCreateRequest)(input).pipe(
        Effect.mapError(() =>
          ProductClientError.make({ kind: "protocol", message: "Thread creation request was invalid" }),
        ),
        Effect.flatMap((validated) =>
          Schema.encodeEffect(ThreadCreateRequest)(validated).pipe(
            Effect.mapError(() =>
              ProductClientError.make({ kind: "protocol", message: "Thread creation request was invalid" }),
            ),
            Effect.flatMap((body) =>
              request("POST", paths.threads, ThreadCreationReceipt, body).pipe(
                Effect.flatMap((receipt) =>
                  receipt.threadId === validated.threadId
                    ? Effect.succeed(receipt)
                    : Effect.fail(
                        ProductClientError.make({
                          kind: "protocol",
                          message: "Thread creation response did not match its request",
                        }),
                      ),
                ),
              ),
            ),
          ),
        ),
      ),
    archiveThread: (threadId) =>
      Schema.decodeEffect(ThreadArchiveRequest)({ threadId }).pipe(
        Effect.mapError(() =>
          ProductClientError.make({ kind: "protocol", message: "Thread archive request was invalid" }),
        ),
        Effect.flatMap((validated) =>
          request("POST", paths.archive(validated.threadId), ThreadArchiveReceipt).pipe(
            Effect.flatMap((receipt) =>
              receipt.threadId === validated.threadId
                ? Effect.succeed(receipt)
                : Effect.fail(
                    ProductClientError.make({
                      kind: "protocol",
                      message: "Thread archive response did not match its request",
                    }),
                  ),
            ),
          ),
        ),
      ),
    ensureSession: (threadId, commandId) =>
      request("POST", paths.session(threadId), SessionReceipt, undefined, { "x-command-id": commandId }),
  }
}

// ast-grep-ignore: effect-prefer-effect-signatures -- this is the explicit Web Fetch foreign adapter boundary.
export const makeFetchTransport = (fetch: (request: Request) => Promise<Response>): ProductTransport => ({
  request: (request) =>
    Effect.tryPromise({
      // ast-grep-ignore: effect-prefer-http -- callers supply the Web Fetch implementation at this transport boundary.
      try: () => fetch(request),
      catch: () => ProductClientError.make({ kind: "network", message: "Product request could not be sent" }),
    }),
})
