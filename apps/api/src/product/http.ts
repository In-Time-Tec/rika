import { Effect, Schema } from "effect"
import { BetterAuthUserId, OrganizationId, type HostedOwner } from "@rika/product/hosted-model"
import type { ProductProject } from "@rika/product/hosted-product"
import { CheckoutFingerprint, RemoteThreadCreationPreference, RunnerProfile } from "@rika/product/runner-registration"
import { OwnerSelection, ThreadArchiveRequest, ThreadCreateRequest } from "@rika/product/thread-creation"
import { readBoundedHttpText } from "../transport/body"
import { authenticateIdentityRequest, type IdentityHttpOptions, type IdentityRequestAccess } from "../identity/http"
import type { CreateThreadInput, ProductActor, ProductControl, ProductControlError } from "./control"

export interface ProductHttpOptions extends IdentityHttpOptions {
  readonly product: ProductControl
}

class ProductHttpError extends Schema.TaggedError<ProductHttpError>()("RikaProductHttpError", {
  status: Schema.Int,
  message: Schema.String,
}) {}

const strict = <S extends Schema.Top>(schema: S) => schema.annotate({ parseOptions: { onExcessProperty: "error" } })
const ProjectCreateRequest = strict(
  Schema.Struct({
    owner: OwnerSelection,
    name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  }),
)
const RunnerAssignmentPollRequest = strict(
  Schema.Struct({
    supervisorId: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
    activeAssignmentIds: Schema.Array(Schema.NonEmptyString.check(Schema.isMaxLength(512))).check(
      Schema.isMaxLength(64),
    ),
  }),
)

const productStatus = {
  invalid: 400,
  forbidden: 403,
  "not-found": 404,
  conflict: 409,
  unavailable: 503,
} as const
const productFailure = (error: ProductControlError) =>
  ProductHttpError.make({ status: productStatus[error.kind], message: error.message })
const unauthorized = () => ProductHttpError.make({ status: 401, message: "CLI device authentication required" })
const invalid = () => ProductHttpError.make({ status: 400, message: "Invalid product request" })

const json = <A>(value: A, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  })
const noContent = () => new Response(null, { status: 204, headers: { "cache-control": "no-store" } })
const errorResponse = (error: ProductHttpError) => {
  const response = json({ message: error.message }, error.status)
  if (error.status === 401) response.headers.set("www-authenticate", 'Bearer realm="rika"')
  return response
}

const decodeBody = <A>(schema: Schema.ConstraintDecoder<A>, request: Request) =>
  Effect.gen(function* () {
    if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers.get("content-type") ?? "")) return yield* invalid()
    const text = yield* readBoundedHttpText(request.body, request.headers.get("content-length")).pipe(
      Effect.mapError((error) =>
        error.kind === "too-large"
          ? ProductHttpError.make({ status: 413, message: "Request body is too large" })
          : invalid(),
      ),
    )
    return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(Effect.mapError(invalid))
  })

const actorFor = (access: IdentityRequestAccess): Effect.Effect<ProductActor, ProductHttpError> => {
  if (access.deviceId === undefined || access.principal.clientId === undefined) return unauthorized()
  const actor: ProductActor = {
    userId: access.principal.userId,
    clientId: access.principal.clientId,
    deviceId: access.deviceId,
  }
  if (access.principal.dpopJkt !== undefined) Object.assign(actor, { dpopJkt: access.principal.dpopJkt })
  return Effect.succeed(actor)
}

const ownerFor = (actor: ProductActor, selection: OwnerSelection): HostedOwner =>
  selection.kind === "personal"
    ? { _tag: "PersonalOwner", userId: BetterAuthUserId.make(actor.userId) }
    : { _tag: "OrganizationOwner", organizationId: OrganizationId.make(selection.organization_id) }

const projectView = (project: ProductProject) => ({
  id: project.id,
  ownerId: project.ownerId,
  owner:
    project.owner._tag === "PersonalOwner"
      ? { kind: "personal" as const, userId: project.owner.userId }
      : { kind: "organization" as const, organizationId: project.owner.organizationId },
  name: project.name,
  slug: project.name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, ""),
})

const createThread = Effect.fn("Rika.ProductHttp.createThread")(function* (
  request: Request,
  actor: ProductActor,
  product: ProductControl,
) {
  const body = yield* decodeBody(ThreadCreateRequest, request)
  const input: CreateThreadInput = {
    actor,
    owner: ownerFor(actor, body.owner),
    threadId: body.threadId,
    target: body.target,
  }
  if (body.projectId !== undefined) Object.assign(input, { projectId: body.projectId })
  if (body.target === "runner") Object.assign(input, { runnerTarget: body.runnerTarget })
  else if (body.workspaceSeedId !== undefined) Object.assign(input, { workspaceSeedId: body.workspaceSeedId })
  if (body.archiveThreadId !== undefined) Object.assign(input, { archiveThreadId: body.archiveThreadId })
  return json(yield* product.createThread(input).pipe(Effect.mapError(productFailure)), 201)
})

const archiveThread = Effect.fn("Rika.ProductHttp.archiveThread")(function* (
  actor: ProductActor,
  product: ProductControl,
  path: RegExpExecArray,
) {
  const encoded = path[1]
  if (encoded === undefined) return yield* invalid()
  const threadId = yield* Effect.try({ try: () => decodeURIComponent(encoded), catch: invalid })
  const input = yield* Schema.decodeEffect(ThreadArchiveRequest)({ threadId }).pipe(Effect.mapError(invalid))
  return json(yield* product.archiveThread({ actor, threadId: input.threadId }).pipe(Effect.mapError(productFailure)))
})

const runnerRequest = Effect.fn("Rika.ProductHttp.runnerRequest")(function* (
  request: Request,
  actor: ProductActor,
  product: ProductControl,
  path: RegExpExecArray,
) {
  const encoded = path[1]
  if (encoded === undefined) return yield* invalid()
  const decoded = yield* Effect.try({ try: () => decodeURIComponent(encoded), catch: invalid })
  const checkoutFingerprint = yield* Schema.decodeEffect(CheckoutFingerprint)(decoded).pipe(Effect.mapError(invalid))
  if (request.method === "POST") {
    const body = yield* decodeBody(RunnerAssignmentPollRequest, request)
    const result = yield* product
      .pollRunnerAssignment({
        actor,
        checkoutFingerprint,
        supervisorId: body.supervisorId,
        activeAssignmentIds: body.activeAssignmentIds,
      })
      .pipe(Effect.mapError(productFailure))
    return json({ claimed: result.claimed, assignment: result.claimed ? (result.assignment ?? null) : null })
  }
  if (path[2] === undefined) {
    const profile = yield* decodeBody(RunnerProfile, request)
    yield* product.registerRunner({ actor, checkoutFingerprint, profile }).pipe(Effect.mapError(productFailure))
  } else {
    const body = yield* decodeBody(RemoteThreadCreationPreference, request)
    yield* product
      .setRemoteThreadCreation({
        actor,
        checkoutFingerprint,
        allowed: body.preference === "allowed",
      })
      .pipe(Effect.mapError(productFailure))
  }
  return noContent()
})

type ProductRoute =
  | { readonly _tag: "identity" }
  | { readonly _tag: "context" }
  | { readonly _tag: "project" }
  | { readonly _tag: "thread" }
  | { readonly _tag: "archive"; readonly path: RegExpExecArray | null }
  | { readonly _tag: "runner"; readonly path: RegExpExecArray }

const productRoute = (request: Request): ProductRoute | undefined => {
  const pathname = new URL(request.url).pathname
  if (request.method === "GET" && pathname === "/api/v2/identity") return { _tag: "identity" }
  if (request.method === "GET" && pathname === "/api/v1/me/context") return { _tag: "context" }
  if (request.method === "POST" && pathname === "/api/v1/projects") return { _tag: "project" }
  if (request.method === "POST" && pathname === "/api/v2/threads") return { _tag: "thread" }
  if (request.method === "POST" && pathname.startsWith("/api/v2/threads/") && pathname.endsWith("/archive"))
    return { _tag: "archive", path: /^\/api\/v2\/threads\/([^/]+)\/archive$/.exec(pathname) }
  const runner = (() => {
    if (request.method === "PUT") return /^\/api\/v2\/runners\/([^/]+)(\/remote-thread-creation)?$/.exec(pathname)
    if (request.method === "POST") return /^\/api\/v2\/runners\/([^/]+)\/poll$/.exec(pathname)
    return null
  })()
  return runner === null ? undefined : { _tag: "runner", path: runner }
}

const productResponse = Effect.fn("Rika.ProductHttp.productResponse")(function* (
  route: ProductRoute,
  request: Request,
  access: IdentityRequestAccess,
  actor: ProductActor,
  product: ProductControl,
) {
  switch (route._tag) {
    case "identity": {
      const identity = yield* product.identity(actor).pipe(Effect.mapError(productFailure))
      return json({ ...identity, displayName: access.account.user.name })
    }
    case "context": {
      const projects = yield* product.projects(actor).pipe(Effect.mapError(productFailure))
      return json({
        account: { id: access.account.user.id, email: access.account.user.email, name: access.account.user.name },
        organizations: access.account.memberships.map((membership) => membership.organization),
        projects: projects.map(projectView),
      })
    }
    case "project": {
      const body = yield* decodeBody(ProjectCreateRequest, request)
      const created = yield* product
        .createProject({ actor, owner: ownerFor(actor, body.owner), name: body.name })
        .pipe(Effect.mapError(productFailure))
      return json(projectView(created), 201)
    }
    case "thread":
      return yield* createThread(request, actor, product)
    case "archive":
      if (route.path === null) return yield* invalid()
      return yield* archiveThread(actor, product, route.path)
    case "runner":
      return yield* runnerRequest(request, actor, product, route.path)
  }
})

export const makeProductRequestHandler = (options: ProductHttpOptions) => (request: Request) =>
  Effect.gen(function* () {
    const route = productRoute(request)
    if (route === undefined) return undefined
    const access = yield* authenticateIdentityRequest(request, options).pipe(
      Effect.mapError((error) =>
        error.kind === "unavailable"
          ? ProductHttpError.make({ status: 503, message: "Identity service unavailable" })
          : unauthorized(),
      ),
    )
    const actor = yield* actorFor(access)
    return yield* productResponse(route, request, access, actor, options.product)
  }).pipe(Effect.catchTag("RikaProductHttpError", (error) => Effect.succeed(errorResponse(error))))
