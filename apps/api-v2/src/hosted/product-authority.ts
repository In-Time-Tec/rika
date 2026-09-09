/* oxlint-disable effecttsgo/crypto-random-uuid, effecttsgo/crypto-random-uuid-in-effect -- downstream credentials require a process CSPRNG. */
/* oxlint-disable anti-slop-effect/no-service-constructor-imports -- this adapter composes the hosted product read bridge. */
import { Clock, Context, Effect, Option, Schema } from "effect"
import type { CliDeviceDirectory, IdentityPrincipal, IdentityRuntime } from "@rika/identity"
import type { HostedClientAuthorityService } from "@rika/product/hosted-client-authority"
import {
  BetterAuthMemberId,
  BetterAuthUserId,
  ClientId,
  DeviceId,
  OrganizationId,
  OwnerId,
  ThreadId,
  type ActorAttribution,
} from "@rika/product/hosted-model"
import type { Principal, Resource } from "generalist/server"
import type { ProductRepositoryService, ThreadAuthorityProjection } from "@rika/product-store/product-repository"
import {
  ThreadExecutionBinding,
  threadIdFromRootSession,
  type ThreadExecutionBinding as ThreadExecutionBindingType,
} from "./partition"
import { makeProductRouteService, makeRepositoryProductThreadReader, type ProductRouteService } from "./product-routes"

export class ProductAuthorizationError extends Schema.TaggedError<ProductAuthorizationError>()(
  "RikaApiV2ProductAuthorizationError",
  {
    kind: Schema.Literals(["unavailable", "invalid"]),
    message: Schema.String,
  },
) {}

export interface ProductAuthentication {
  /** Validate one bearer credential at request time. Revoked credentials must return `undefined`. */
  readonly authenticateBearer: (
    token: string,
    context?: { readonly threadId?: string; readonly ownerId?: string; readonly request?: Request },
  ) => Effect.Effect<Principal | undefined, ProductAuthorizationError>
  /** Resolve a process-local credential issued after edge authentication; this never re-verifies DPoP. */
  readonly authenticateDownstream?: (
    credential: string,
    context: { readonly threadId: string; readonly ownerId: string; readonly request: Request },
  ) => Effect.Effect<Principal | undefined, ProductAuthorizationError>
  /**
   * Issue a short-lived process-local credential for one authenticated forwarding request. The actor server must share
   * this authority instance; remote actor runtimes fail closed until a shared sealed assertion is configured.
   */
  readonly downstreamCredential?: (input: {
    readonly principal: Principal
    readonly ownerId: string
    readonly threadId: string
    readonly request: Request
  }) => Effect.Effect<string | undefined, ProductAuthorizationError>
}

export interface ProductAuthorityService extends ProductAuthentication {
  /** Public product metadata routes backed by the same repository and grant authority. */
  readonly product?: ProductRouteService
  /** Resolve a product Thread to its canonical execution binding without starting work. */
  readonly threadBinding: (
    threadId: string,
    ownerId?: string,
  ) => Effect.Effect<ThreadExecutionBinding | undefined, ProductAuthorizationError>
  /** Resolve a Generalist resource to the product Thread that owns it. */
  readonly resourceThread: (resource: Resource) => Effect.Effect<string | undefined, ProductAuthorizationError>
  /** Recheck current owner/grant/client revocation for every Host route and stream event. */
  readonly authorize: (input: {
    readonly principal: Principal
    readonly resource: Resource
    readonly action: "read" | "observe" | "mutate"
    /** Explicit Thread routing context; it selects a partition but never proves ownership by itself. */
    readonly threadId?: string
  }) => Effect.Effect<boolean, ProductAuthorizationError>
}

export class ProductAuthority extends Context.Service<ProductAuthority, ProductAuthorityService>()(
  "@rika/api-v2/hosted/product-authority/ProductAuthority",
) {}

const sessionThread = (resource: Resource) =>
  resource.type === "session" || resource.type === "run" ? resource.id : undefined

/**
 * Build the small product policy bridge used by the Generalist Server. The callbacks belong to Rika's identity and
 * product repositories; this module owns no execution state and cannot admit a Run.
 */
export const makeProductAuthority = (input: ProductAuthorityService) => ProductAuthority.of(input)

export interface RepositoryProductAuthorityOptions {
  readonly identity: IdentityRuntime
  readonly devices: CliDeviceDirectory
  readonly product: ProductRepositoryService
  readonly clientAuthority: HostedClientAuthorityService
  readonly environment: string
  /** Resolve the canonical workspace binding owned by the Runner/Orb execution layer. */
  readonly binding: (input: {
    readonly ownerId: string
    readonly threadId: string
  }) => Effect.Effect<ThreadExecutionBindingType, ProductAuthorizationError>
}

interface AuthenticatedActor {
  readonly identity: IdentityPrincipal
  readonly deviceId: string
  readonly principal: Principal
}

interface DownstreamGrant {
  readonly principal: Principal
  readonly identity: IdentityPrincipal
  readonly ownerId: string
  readonly threadId: string
  readonly requestUrl: string
  readonly requestMethod: string
  readonly expiresAt: number
  readonly remainingUses: number
}

const unavailable = (message: string) => ProductAuthorizationError.make({ kind: "unavailable", message })
const invalid = (message: string) => ProductAuthorizationError.make({ kind: "invalid", message })
const principalId = (input: {
  readonly userId: string
  readonly ownerId: string
  readonly clientId: string
  readonly deviceId: string
}) =>
  `rika-client:${encodeURIComponent(input.userId)}:${encodeURIComponent(input.ownerId)}:${encodeURIComponent(input.clientId)}:${encodeURIComponent(input.deviceId)}`

const roleRank = (role: ThreadAuthorityProjection["threadRole"]) => {
  if (role === "owner") return 4
  if (role === "operator") return 3
  if (role === "controller") return 2
  if (role === "viewer") return 1
  return 0
}

const generalistRole = (authority: ThreadAuthorityProjection, userId: string): Principal["role"] =>
  authority.createdByUserId === userId ||
  Math.max(
    roleRank(authority.threadRole),
    authority.executorKind === "orb" && authority.inheritProjectGrants ? roleRank(authority.projectRole) : 0,
  ) >= 2
    ? "controller"
    : "spectator"

const actorFor = (
  input: AuthenticatedActor & { readonly authority: ThreadAuthorityProjection },
): ActorAttribution | undefined => {
  const clientId = input.identity.clientId
  if (clientId === undefined) return undefined
  const userId = BetterAuthUserId.make(input.identity.userId)
  const client = ClientId.make(clientId)
  const device = DeviceId.make(input.deviceId)
  if (input.authority.kind === "personal" && input.authority.userId !== null)
    return {
      _tag: "PersonalActor",
      owner: { _tag: "PersonalOwner", userId: BetterAuthUserId.make(input.authority.userId) },
      userId,
      clientId: client,
      deviceId: device,
    }
  if (
    input.authority.kind === "organization" &&
    input.authority.organizationId !== null &&
    input.authority.membershipId !== null
  )
    return {
      _tag: "OrganizationActor",
      owner: { _tag: "OrganizationOwner", organizationId: OrganizationId.make(input.authority.organizationId) },
      userId,
      membershipId: BetterAuthMemberId.make(input.authority.membershipId),
      clientId: client,
      deviceId: device,
    }
  return undefined
}

const rememberActor = (
  actors: Map<string, AuthenticatedActor>,
  principal: Principal,
  identity: IdentityPrincipal,
  deviceId: string,
) => {
  const previous = actors.get(principal.id)
  if (previous !== undefined) actors.delete(principal.id)
  actors.set(principal.id, {
    identity,
    deviceId,
    principal,
  })
  if (actors.size > 256) {
    const oldest = actors.keys().next().value
    if (oldest !== undefined) actors.delete(oldest)
  }
}

/**
 * Adapt the released identity, device, product repository, and hosted authority services to the Generalist server
 * policy. The adapter keeps the authenticated actor on the exact Principal object passed through the Generalist
 * middleware, so concurrent clients cannot overwrite one another's client/device context.
 */
export interface RepositoryProductAuthorityService extends ProductAuthorityService {
  readonly product: ProductRouteService
}

export const makeRepositoryProductAuthority = (
  options: RepositoryProductAuthorityOptions,
): RepositoryProductAuthorityService => {
  // Generalist decodes CurrentPrincipal before invoking Authorization, so object identity is not stable across the
  // middleware boundary. This bounded identity key carries no credential material and is stable for one client/device.
  const actors = new Map<string, AuthenticatedActor>()
  const grants = new Map<string, DownstreamGrant>()
  const downstreamGrantLifetimeMillis = 10_000
  const downstreamGrantUses = 4
  const authenticateBearer: ProductAuthentication["authenticateBearer"] = Effect.fn(
    "RikaApiV2.RepositoryProductAuthority.authenticateBearer",
  )(function* (token, context) {
    const request =
      context?.request ??
      new Request("https://rika.invalid/api/auth/introspect", {
        headers: { authorization: `Bearer ${token}` },
      })
    const identity = yield* options.identity
      .identify(request)
      .pipe(
        Effect.mapError((error) =>
          error.kind === "invalid"
            ? invalid("Bearer credential is invalid")
            : unavailable("Identity service unavailable"),
        ),
      )
    if (identity === undefined || identity.clientId === undefined) return undefined
    const deviceId = yield* options.devices
      .authenticate(identity)
      .pipe(Effect.mapError(() => unavailable("Device authority is unavailable")))
    if (deviceId === undefined) return undefined
    const authority =
      context?.threadId === undefined
        ? undefined
        : yield* options.product
            .threadAuthority(identity.userId, context.threadId)
            .pipe(Effect.mapError((error) => unavailable(error.message)))
    const ownerId =
      authority?.ownerId ??
      (yield* options.product.personalOwnerId(identity.userId).pipe(Effect.mapError((error) => unavailable(error.message))))
    if (ownerId === undefined || (context?.ownerId !== undefined && ownerId !== context.ownerId)) return undefined
    const principal: Principal = {
      id: principalId({
        userId: identity.userId,
        ownerId,
        clientId: identity.clientId,
        deviceId,
      }),
      tenantId: ownerId,
      role: authority === undefined ? "controller" : generalistRole(authority, identity.userId),
    }
    rememberActor(actors, principal, identity, deviceId)
    return principal
  })

  const authenticateDownstream: NonNullable<ProductAuthentication["authenticateDownstream"]> = Effect.fn(
    "RikaApiV2.RepositoryProductAuthority.authenticateDownstream",
  )(function* (credential, context) {
    const grant = grants.get(credential)
    const now = yield* Clock.currentTimeMillis
    if (
      grant === undefined ||
      grant.expiresAt <= now ||
      grant.remainingUses <= 0 ||
      grant.ownerId !== context.ownerId ||
      grant.threadId !== context.threadId ||
      context.request.headers.get("x-rika-original-request-url") !== grant.requestUrl ||
      context.request.headers.get("x-rika-original-request-method") !== grant.requestMethod
    ) {
      if (grant?.expiresAt !== undefined && grant.expiresAt <= now) grants.delete(credential)
      return undefined
    }
    const deviceId = yield* options.devices
      .authenticate(grant.identity)
      .pipe(Effect.mapError(() => unavailable("Device authority is unavailable")))
    if (deviceId === undefined || deviceId !== actors.get(grant.principal.id)?.deviceId) {
      grants.delete(credential)
      return undefined
    }
    if (grant.remainingUses === 1) grants.delete(credential)
    else grants.set(credential, { ...grant, remainingUses: grant.remainingUses - 1 })
    return grant.principal
  })

  const downstreamCredential: NonNullable<ProductAuthentication["downstreamCredential"]> = Effect.fn(
    "RikaApiV2.RepositoryProductAuthority.downstreamCredential",
  )(function* (input) {
    const actor = actors.get(input.principal.id)
    if (actor === undefined || actor.principal.tenantId !== input.ownerId) return undefined
    const now = yield* Clock.currentTimeMillis
    // ast-grep-ignore: effect-prefer-random -- this process-local opaque credential uses the platform CSPRNG.
    const credential = `rika-ds-${crypto.randomUUID()}`
    grants.set(credential, {
      principal: input.principal,
      identity: actor.identity,
      ownerId: input.ownerId,
      threadId: input.threadId,
      requestUrl: input.request.url,
      requestMethod: input.request.method,
      expiresAt: now + downstreamGrantLifetimeMillis,
      remainingUses: downstreamGrantUses,
    })
    if (grants.size > 256) {
      const oldest = grants.keys().next().value
      if (oldest !== undefined) grants.delete(oldest)
    }
    return credential
  })

  const threadBinding: ProductAuthorityService["threadBinding"] = Effect.fn(
    "RikaApiV2.RepositoryProductAuthority.threadBinding",
  )(function* (threadId, ownerId) {
    if (ownerId === undefined) return undefined
    const binding = yield* options
      .binding({ ownerId, threadId })
      .pipe(
        Effect.flatMap((value) =>
          Schema.decodeEffect(ThreadExecutionBinding)(value).pipe(
            Effect.mapError(() => invalid("Canonical Thread execution binding is malformed")),
          ),
        ),
      )
    if (
      binding.partition.environment !== options.environment ||
      binding.partition.ownerId !== ownerId ||
      binding.partition.threadId !== threadId
    )
      return yield* invalid("Canonical Thread execution binding does not match the requested partition")
    return binding
  })

  const resourceThread: ProductAuthorityService["resourceThread"] = (resource) => {
    if (resource.type === "session" && resource.id !== undefined)
      return Effect.succeed(threadIdFromRootSession(resource.id)?.threadId)
    return Effect.succeed(Option.none<string>()).pipe(Effect.map(Option.getOrUndefined))
  }

  const authorize: ProductAuthorityService["authorize"] = Effect.fn("RikaApiV2.RepositoryProductAuthority.authorize")(
    function* (input) {
      const actor = actors.get(input.principal.id)
      const threadId = input.threadId ?? (yield* resourceThread(input.resource))
      if (actor === undefined || threadId === undefined) return false
      const authority = yield* options.product.threadAuthority(actor.identity.userId, threadId).pipe(
        Effect.mapError((error) => unavailable(error.message)),
        Effect.orElseSucceed(() => undefined),
      )
      if (authority === undefined || authority.ownerId !== input.principal.tenantId) return false
      const attribution = actorFor({ ...actor, authority })
      if (attribution === undefined) return false
      const action: "thread:view" | "thread:operate" = input.action === "mutate" ? "thread:operate" : "thread:view"
      return yield* options.clientAuthority
        .authorizeThread({
          ownerId: OwnerId.make(authority.ownerId),
          threadId: ThreadId.make(threadId),
          actor: attribution,
          action,
        })
        .pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        )
    },
  )

  const authority: ProductAuthorityService = {
    authenticateBearer,
    authenticateDownstream,
    downstreamCredential,
    threadBinding,
    resourceThread,
    authorize,
  }
  const product = makeProductRouteService({
    authority,
    reader: makeRepositoryProductThreadReader({ product: options.product, environment: options.environment }),
  })
  return { ...authority, product }
}

export const authorizeResource = Effect.fn("RikaApiV2.ProductAuthority.authorizeResource")(function* (
  authority: ProductAuthorityService,
  input: {
    readonly principal: Principal
    readonly resource: Resource
    readonly action: "read" | "observe" | "mutate"
    readonly threadId?: string
  },
) {
  const threadId = input.threadId ?? (yield* authority.resourceThread(input.resource))
  if (threadId === undefined) return false
  const binding = yield* authority.threadBinding(threadId, input.principal.tenantId)
  if (binding === undefined || binding.partition.ownerId !== input.principal.tenantId) return false
  return yield* authority.authorize(input)
})

export const resourceThreadId = (resource: Resource) => sessionThread(resource)
