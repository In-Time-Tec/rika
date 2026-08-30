import { Clock, Crypto, DateTime, Effect } from "effect"
import type { AuthorizationService } from "@rika/product/hosted-authorization"
import type { HostedClientAuthorityService } from "@rika/product/hosted-client-authority"
import {
  BetterAuthMemberId,
  BetterAuthUserId,
  ClientId,
  DeviceId,
  OrganizationId,
  OwnerId,
  ThreadId,
} from "@rika/product/hosted-model"
import type { ProductRepositoryService } from "@rika/product-store/product-repository"
import {
  type AuthenticatedPrincipal,
  forbidden,
  HostedProductError,
  type HostedProductService,
  type OwnerSelection,
  repositoryFailure,
  storeFailure,
  unavailable,
} from "./contract"

interface AuthorityDependencies {
  readonly clientAuthority: HostedClientAuthorityService
  readonly repository: ProductRepositoryService
  readonly policy: AuthorizationService
  readonly crypto: Crypto.Crypto
}

export const hostedProductAuthorityOperations = ({
  clientAuthority,
  repository,
  policy,
  crypto,
}: AuthorityDependencies) => {
  const activateClient = Effect.fn("HostedProduct.activateClient")(function* (
    principal: AuthenticatedPrincipal,
    userId: BetterAuthUserId,
  ) {
    const currentTime = yield* Clock.currentTimeMillis
    const now = DateTime.formatIso(DateTime.makeUnsafe(currentTime))
    const deviceId = DeviceId.make(principal.deviceId)
    yield* clientAuthority.registerDevice({
      id: deviceId,
      userId,
      displayName: "Rika CLI",
      publicKeyFingerprint: principal.dpopJkt ?? principal.clientId,
      now,
    })
    yield* clientAuthority.authenticateClient({
      id: ClientId.make(principal.clientId),
      userId,
      deviceId,
      now,
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(currentTime + 5 * 60 * 1000)),
    })
    return deviceId
  })

  const resolveOwner = Effect.fn("HostedProduct.resolveOwner")(function* (
    principal: AuthenticatedPrincipal,
    selection: OwnerSelection,
  ) {
    return yield* repository
      .resolveOwner({
        userId: principal.userId,
        selection,
        proposedOwnerId: yield* crypto.randomUUIDv4.pipe(Effect.mapError(unavailable)),
        now: DateTime.toDate(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
      })
      .pipe(Effect.mapError(repositoryFailure))
  })

  const projects: HostedProductService["projects"] = Effect.fn("HostedProduct.projects")(function* (principal) {
    const personal = yield* resolveOwner(principal, {
      _tag: "PersonalOwner",
      userId: BetterAuthUserId.make(principal.userId),
    })
    const organizationIds = yield* repository.organizationIds(principal.userId).pipe(Effect.mapError(repositoryFailure))
    for (const organizationId of organizationIds)
      yield* resolveOwner(principal, {
        _tag: "OrganizationOwner",
        organizationId: OrganizationId.make(organizationId),
      })
    return yield* repository
      .projects({ userId: principal.userId, personalOwnerId: personal.ownerId })
      .pipe(Effect.mapError(repositoryFailure))
  })

  const createProject: HostedProductService["createProject"] = Effect.fn("HostedProduct.createProject")(function* (
    input,
  ) {
    const name = input.name.trim()
    if (name.length === 0 || name.length > 128)
      return yield* HostedProductError.make({
        kind: "invalid",
        message: "Project name must contain between 1 and 128 characters",
      })
    const authority = yield* resolveOwner(input.principal, input.owner)
    return yield* repository
      .createProject({
        id: yield* crypto.randomUUIDv4,
        authority,
        name,
        now: DateTime.toDate(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
      })
      .pipe(Effect.mapError(repositoryFailure))
  }, Effect.mapError(storeFailure))

  const authorizeOwner: HostedProductService["authorizeOwner"] = Effect.fn("HostedProduct.authorizeOwner")(function* (
    principal,
    owner,
  ) {
    yield* activateClient(principal, BetterAuthUserId.make(principal.userId))
    const authority = yield* resolveOwner(principal, owner)
    return { ownerId: OwnerId.make(authority.ownerId) }
  }, Effect.mapError(storeFailure))

  const authorizeThread: HostedProductService["authorizeThread"] = Effect.fn("HostedProduct.authorizeThread")(
    function* (principal, threadId, action) {
      yield* activateClient(principal, BetterAuthUserId.make(principal.userId))
      const resolved = yield* repository
        .threadAuthority(principal.userId, threadId)
        .pipe(Effect.mapError(repositoryFailure))
      if (resolved === undefined)
        return yield* HostedProductError.make({ kind: "not-found", message: "Thread is unavailable" })
      const userId = BetterAuthUserId.make(principal.userId)
      if (resolved.kind === "personal" && resolved.userId !== principal.userId) return yield* forbidden()
      if (resolved.kind === "organization" && resolved.membershipId === null) return yield* forbidden()
      if (resolved.kind === "organization") {
        const membershipId = BetterAuthMemberId.make(resolved.membershipId!)
        const authorization = {
          memberId: membershipId,
          executorKind: resolved.executorKind,
          inheritProjectGrants: resolved.inheritProjectGrants,
        }
        if (resolved.createdByUserId === principal.userId)
          Object.assign(authorization, { threadCreatorMemberId: membershipId })
        if (resolved.threadRole !== null) Object.assign(authorization, { threadRole: resolved.threadRole })
        if (resolved.projectRole !== null) Object.assign(authorization, { projectRole: resolved.projectRole })
        yield* policy.authorize(action, authorization).pipe(Effect.mapError(() => forbidden()))
      }
      const owner =
        resolved.kind === "personal"
          ? ({ _tag: "PersonalOwner", userId } as const)
          : ({ _tag: "OrganizationOwner", organizationId: OrganizationId.make(resolved.organizationId!) } as const)
      const actor =
        owner._tag === "PersonalOwner"
          ? ({
              _tag: "PersonalActor",
              owner,
              userId,
              clientId: ClientId.make(principal.clientId),
              deviceId: DeviceId.make(principal.deviceId),
            } as const)
          : ({
              _tag: "OrganizationActor",
              owner,
              userId,
              membershipId: BetterAuthMemberId.make(resolved.membershipId!),
              clientId: ClientId.make(principal.clientId),
              deviceId: DeviceId.make(principal.deviceId),
            } as const)
      const nowMillis = yield* Clock.currentTimeMillis
      yield* clientAuthority.grantClientAuthority({
        ownerId: OwnerId.make(resolved.ownerId),
        actor,
        now: DateTime.formatIso(DateTime.makeUnsafe(nowMillis)),
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(nowMillis + 5 * 60 * 1000)),
      })
      yield* clientAuthority.authorizeThread({
        ownerId: OwnerId.make(resolved.ownerId),
        threadId: ThreadId.make(threadId),
        actor,
        action,
        at: DateTime.formatIso(DateTime.makeUnsafe(nowMillis)),
      })
      return { ownerId: OwnerId.make(resolved.ownerId), actor }
    },
    Effect.mapError(storeFailure),
  )

  const activatePrincipal: HostedProductService["activatePrincipal"] = Effect.fn("HostedProduct.activatePrincipal")(
    function* (principal) {
      yield* activateClient(principal, BetterAuthUserId.make(principal.userId))
    },
    Effect.mapError(storeFailure),
  )

  return { activateClient, resolveOwner, projects, createProject, authorizeOwner, authorizeThread, activatePrincipal }
}
