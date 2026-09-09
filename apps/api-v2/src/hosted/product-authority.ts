/* oxlint-disable effecttsgo/crypto-random-uuid -- downstream credentials require a process CSPRNG. */
import { Context, Effect, Option, Schema } from "effect"
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
import type { ThreadExecutionBinding } from "./partition"
import { threadIdFromRootSession } from "./partition"

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
    context: { readonly threadId: string; readonly ownerId: string },
  ) => Effect.Effect<Principal | undefined, ProductAuthorizationError>
  /** Issue the process-local credential used by the Rivet actor transport. */
  readonly downstreamCredential?: (principal: Principal) => string | undefined
}

export interface ProductAuthorityService extends ProductAuthentication {
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
  }) => Effect.Effect<ThreadExecutionBinding, ProductAuthorizationError>
}

interface AuthenticatedActor {
  readonly identity: IdentityPrincipal
  readonly deviceId: string
  readonly principal: Principal
  readonly downstreamCredential: string
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
    // ast-grep-ignore: effect-prefer-random -- this process-local opaque credential uses the platform CSPRNG.
    downstreamCredential: previous?.downstreamCredential ?? `rika-ds-${crypto.randomUUID()}`,
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
export const makeRepositoryProductAuthority = (options: RepositoryProductAuthorityOptions): ProductAuthorityService => {
  // Generalist decodes CurrentPrincipal before invoking Authorization, so object identity is not stable across the
  // middleware boundary. This bounded identity key carries no credential material and is stable for one client/device.
  const actors = new Map<string, AuthenticatedActor>()
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
    if (identity === undefined || identity.clientId === undefined || context?.threadId === undefined) return undefined
    const deviceId = yield* options.devices
      .authenticate(identity)
      .pipe(Effect.mapError(() => unavailable("Device authority is unavailable")))
    if (deviceId === undefined) return undefined
    const authority = yield* options.product
      .threadAuthority(identity.userId, context.threadId)
      .pipe(Effect.mapError((error) => unavailable(error.message)))
    if (authority === undefined || (context.ownerId !== undefined && authority.ownerId !== context.ownerId))
      return undefined
    const principal: Principal = {
      id: principalId({
        userId: identity.userId,
        ownerId: authority.ownerId,
        clientId: identity.clientId,
        deviceId,
      }),
      tenantId: authority.ownerId,
      role: generalistRole(authority, identity.userId),
    }
    rememberActor(actors, principal, identity, deviceId)
    return principal
  })

  const authenticateDownstream: NonNullable<ProductAuthentication["authenticateDownstream"]> = Effect.fn(
    "RikaApiV2.RepositoryProductAuthority.authenticateDownstream",
  )((credential, context) => {
    const actor = [...actors.values()].find((candidate) => candidate.downstreamCredential === credential)
    return Effect.succeed(
      actor === undefined || actor.principal.tenantId !== context.ownerId ? undefined : actor.principal,
    )
  })

  const downstreamCredential: NonNullable<ProductAuthentication["downstreamCredential"]> = (principal) =>
    actors.get(principal.id)?.downstreamCredential

  const threadBinding: ProductAuthorityService["threadBinding"] = Effect.fn(
    "RikaApiV2.RepositoryProductAuthority.threadBinding",
  )(function* (threadId, ownerId) {
    if (ownerId === undefined) return undefined
    const binding = yield* options.binding({ ownerId, threadId })
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

  return { authenticateBearer, authenticateDownstream, downstreamCredential, threadBinding, resourceThread, authorize }
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
