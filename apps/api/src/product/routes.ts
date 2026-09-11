import { Clock, Crypto, DateTime, Effect, Option, Schema } from "effect"
import type { Principal, Resource } from "generalist/server"
import { OrganizationId } from "@rika/product/hosted-model"
import type { OwnerSelection } from "@rika/product/thread-creation"
import type { ProductRepositoryService, ProductThreadMetadataCursor } from "@rika/product-store/product-repository"
import { threadPartition } from "../runtime/partition"
import type { ProductAuthorityService } from "./authority"

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
  kind: Schema.Literals(["unavailable", "invalid", "forbidden"]),
  message: Schema.String,
}) {}

/** Caller-selected catalog scope: an explicit owner selection plus an optional Project filter. */
export interface ProductThreadScope {
  readonly owner?: OwnerSelection
  readonly projectId?: string
}

export interface ProductThreadReader {
  /** Return a bounded page of product Thread metadata for one owner. */
  readonly list: (input: {
    readonly ownerId: string
    readonly cursor?: string
    readonly limit: number
    readonly projectId?: string
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
  const metadata = (
    ownerId: string,
    value: {
      readonly id: string
      readonly title: string
      readonly target: "runner" | "orb"
      readonly updatedAt: number
    },
  ): ThreadMetadata => ({
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
    if (request.projectId !== undefined) Object.assign(repositoryInput, { projectId: request.projectId })
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
    readonly scope?: ProductThreadScope
  }) => Effect.Effect<ThreadPage, ProductRouteError>
  readonly thread: (input: {
    readonly principal: Principal
    readonly threadId: string
    readonly scope?: ProductThreadScope
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

const scopedForbidden = () =>
  ProductRouteError.make({ kind: "forbidden", message: "Thread owner scope is unavailable" })

/**
 * Keep product reads separate from the execution Host. The reader supplies product metadata, while the authority
 * rechecks the current Thread grant for every candidate so stale listings cannot disclose inaccessible Threads.
 * A caller-selected organization owner resolves through the product repository, which fails closed for organizations
 * the authenticated user cannot see; without scope support configured, organization listings are rejected rather than
 * silently read under the personal owner.
 */
export const makeProductRouteService = (input: {
  readonly authority: ProductAuthorityService
  readonly reader: ProductThreadReader
  readonly owners?: {
    readonly product: Pick<ProductRepositoryService, "resolveOwner">
    readonly crypto: Crypto.Crypto
    /** Recover the authenticated user behind one Principal; principals outside the actor map cannot scope. */
    readonly userId: (principal: Principal) => string | undefined
  }
}): ProductRouteService => {
  const scopedOwnerId = Effect.fn("RikaApiV2.ProductRoutes.scopedOwnerId")(function* (
    principal: Principal,
    owner: OwnerSelection | undefined,
  ): Effect.fn.Return<string, ProductRouteError> {
    if (owner === undefined || owner.kind === "personal") return principal.tenantId
    const owners = input.owners
    if (owners === undefined) return yield* scopedForbidden()
    const userId = owners.userId(principal)
    if (userId === undefined) return yield* scopedForbidden()
    const organizationId = yield* Schema.decodeEffect(OrganizationId)(owner.organization_id).pipe(
      Effect.mapError(() => ProductRouteError.make({ kind: "invalid", message: "Thread owner scope is invalid" })),
    )
    const authority = yield* owners.product
      .resolveOwner({
        userId,
        selection: { _tag: "OrganizationOwner", organizationId },
        proposedOwnerId: yield* owners.crypto.randomUUIDv4.pipe(Effect.mapError(repositoryFailure)),
        now: DateTime.toDate(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
      })
      .pipe(Effect.mapError((error) => (error.kind === "forbidden" ? scopedForbidden() : repositoryFailure(error))))
    if (authority.owner._tag === "OrganizationOwner" && authority.membershipId === undefined)
      return yield* scopedForbidden()
    return authority.ownerId
  })

  const scopedPrincipal = (principal: Principal, ownerId: string): Principal =>
    ownerId === principal.tenantId ? principal : { ...principal, tenantId: ownerId }

  const listThreads = Effect.fn("RikaApiV2.ProductRoutes.listThreads")(function* (request: ListThreadsInput) {
    const ownerId = yield* scopedOwnerId(request.principal, request.scope?.owner)
    const principal = scopedPrincipal(request.principal, ownerId)
    const threads: Array<ThreadMetadata> = []
    let cursor = request.cursor
    let nextCursor: string | null = null
    for (let pageIndex = 0; pageIndex < 4 && threads.length < request.limit; pageIndex += 1) {
      const readerInput: Parameters<ProductThreadReader["list"]>[0] = {
        ownerId,
        limit: request.limit - threads.length,
      }
      if (cursor !== undefined) Object.assign(readerInput, { cursor })
      if (request.scope?.projectId !== undefined) Object.assign(readerInput, { projectId: request.scope.projectId })
      const page = yield* input.reader.list(readerInput)
      const allowedThreads = yield* Effect.filter(page.threads, (thread) =>
        allowed(input.authority, principal, thread).pipe(Effect.mapError(authorizationFailure)),
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
    const ownerId = yield* scopedOwnerId(request.principal, request.scope?.owner)
    const value = yield* input.reader.get({ ownerId, threadId: request.threadId })
    if (value === undefined) return undefined
    return (yield* allowed(input.authority, scopedPrincipal(request.principal, ownerId), value).pipe(
      Effect.mapError(authorizationFailure),
    ))
      ? value
      : undefined
  })

  return { listThreads, thread }
}
