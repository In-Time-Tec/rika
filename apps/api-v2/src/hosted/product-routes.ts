import { DateTime, Effect, Option, Schema } from "effect"
import type { Principal, Resource } from "generalist/server"
import type {
  ProductRepositoryService,
  ProductThreadMetadataCursor,
} from "@rika/product-store/product-repository"
import { threadPartition } from "./partition"
import type { ProductAuthorityService } from "./product-authority"

const id = Schema.String

export const ThreadMetadata = Schema.Struct({
  id,
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

export class ProductRouteError extends Schema.TaggedError<ProductRouteError>()("RikaApiV2ProductRouteError", {
  kind: Schema.Literals(["unavailable", "invalid"]),
  message: Schema.String,
}) {}

export interface ProductThreadReader {
  /** Return a bounded page of product Thread metadata for one owner. */
  readonly list: (input: {
    readonly ownerId: string
    readonly cursor?: string
    readonly limit: number
  }) => Effect.Effect<ThreadPage, ProductRouteError>
  /** Return product Thread metadata only when it belongs to the requested owner. */
  readonly get: (input: {
    readonly ownerId: string
    readonly threadId: string
  }) => Effect.Effect<ThreadMetadata | undefined, ProductRouteError>
}

const Cursor = Schema.Struct({
  pinned: Schema.Boolean,
  updatedAt: Schema.Finite,
  threadId: Schema.NonEmptyString,
})
type Cursor = typeof Cursor.Type

const decodeCursor = (value: string): Cursor | undefined => {
  try {
    const decoded = Buffer.from(value, "base64url").toString()
    return Option.getOrUndefined(Schema.decodeOption(Schema.fromJsonString(Cursor))(decoded))
  } catch {
    return undefined
  }
}

const encodeCursor = (value: ProductThreadMetadataCursor): string =>
  Buffer.from(Schema.encodeSync(Schema.fromJsonString(Cursor))(value)).toString("base64url")

const repositoryFailure = (error: { readonly message: string }) =>
  ProductRouteError.make({ kind: "unavailable", message: error.message })

/**
 * Adapt the canonical product Thread repository to the public v2 metadata shape. The repository owns ordering and
 * cursor boundaries; this adapter only adds the deterministic Session identity and wire timestamp.
 */
export const makeRepositoryProductThreadReader = (input: {
  readonly product: ProductRepositoryService
  readonly environment: string
}): ProductThreadReader => {
  const metadata = (ownerId: string, value: {
    readonly id: string
    readonly title: string
    readonly target: "runner" | "orb"
    readonly updatedAt: number
  }): ThreadMetadata => ({
    id: value.id,
    title: value.title,
    target: value.target,
    sessionId: threadPartition({
      environment: input.environment,
      ownerId,
      threadId: value.id,
      target: value.target,
    }).rootSessionId,
    updatedAt: DateTime.formatIso(DateTime.makeUnsafe(value.updatedAt)),
  })

  const list: ProductThreadReader["list"] = (request) => {
    const cursor = request.cursor === undefined ? undefined : decodeCursor(request.cursor)
    if (request.cursor !== undefined && cursor === undefined)
      return Effect.fail(ProductRouteError.make({ kind: "invalid", message: "Thread cursor is invalid" }))
    const repositoryInput: Parameters<ProductRepositoryService["threadMetadataList"]>[0] = {
      ownerId: request.ownerId,
      limit: request.limit,
    }
    if (cursor !== undefined) Object.assign(repositoryInput, { cursor })
    return input.product.threadMetadataList(repositoryInput).pipe(
      Effect.map((page) => {
        const threads = page.threads.map((thread) => metadata(request.ownerId, thread))
        let nextCursor: string | null = null
        if (page.nextCursor !== undefined) nextCursor = encodeCursor(page.nextCursor)
        return { threads, nextCursor }
      }),
      Effect.mapError(repositoryFailure),
    )
  }

  const get: ProductThreadReader["get"] = (request) =>
    input.product.threadMetadata(request.ownerId, request.threadId).pipe(
      Effect.map((value) => (value === undefined ? undefined : metadata(request.ownerId, value))),
      Effect.mapError(repositoryFailure),
    )

  return { list, get }
}

export interface ProductRouteService {
  readonly listThreads: (input: {
    readonly principal: Principal
    readonly cursor?: string
    readonly limit: number
  }) => Effect.Effect<ThreadPage, ProductRouteError>
  readonly thread: (input: {
    readonly principal: Principal
    readonly threadId: string
  }) => Effect.Effect<ThreadMetadata | undefined, ProductRouteError>
}

type ListThreadsInput = Parameters<ProductRouteService["listThreads"]>[0]
type ThreadInput = Parameters<ProductRouteService["thread"]>[0]

const sessionResource = (thread: ThreadMetadata): Resource =>
  thread.sessionId === undefined ? { type: "session" } : { type: "session", id: thread.sessionId }

const allowed = (authority: ProductAuthorityService, principal: Principal, thread: ThreadMetadata) =>
  authority.authorize({
    principal,
    resource: sessionResource(thread),
    action: "observe",
    threadId: thread.id,
  })

const authorizationFailure = (error: { readonly kind: "unavailable" | "invalid"; readonly message: string }) =>
  ProductRouteError.make({ kind: error.kind, message: error.message })

/**
 * Keep product reads separate from the execution Host. The reader supplies product metadata, while the authority
 * rechecks the current Thread grant for every candidate so stale listings cannot disclose inaccessible Threads.
 */
export const makeProductRouteService = (input: {
  readonly authority: ProductAuthorityService
  readonly reader: ProductThreadReader
}): ProductRouteService => {
  const listThreads = Effect.fn("RikaApiV2.ProductRoutes.listThreads")(function* (request: ListThreadsInput) {
    const threads: Array<ThreadMetadata> = []
    let cursor = request.cursor
    let nextCursor: string | null = null
    for (let pageIndex = 0; pageIndex < 4 && threads.length < request.limit; pageIndex += 1) {
      const readerInput: Parameters<ProductThreadReader["list"]>[0] = {
        ownerId: request.principal.tenantId,
        limit: request.limit,
      }
      if (cursor !== undefined) Object.assign(readerInput, { cursor })
      const page = yield* input.reader.list(readerInput)
      const allowedThreads = yield* Effect.filter(page.threads, (thread) =>
        allowed(input.authority, request.principal, thread).pipe(Effect.mapError(authorizationFailure)),
      )
      threads.push(...allowedThreads.slice(0, request.limit - threads.length))
      nextCursor = page.nextCursor
      if (page.nextCursor === null) break
      if (page.nextCursor === cursor) break
      cursor = page.nextCursor
    }
    return { threads, nextCursor }
  })

  const thread = Effect.fn("RikaApiV2.ProductRoutes.thread")(function* (request: ThreadInput) {
    const value = yield* input.reader.get({ ownerId: request.principal.tenantId, threadId: request.threadId })
    if (value === undefined) return undefined
    return (yield* allowed(input.authority, request.principal, value).pipe(Effect.mapError(authorizationFailure)))
      ? value
      : undefined
  })

  return { listThreads, thread }
}
