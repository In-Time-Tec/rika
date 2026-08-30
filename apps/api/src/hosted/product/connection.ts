import { Clock, Crypto, DateTime, Effect } from "effect"
import type { AuthorizationService } from "@rika/product/hosted-authorization"
import type { HostedClientAuthorityService } from "@rika/product/hosted-client-authority"
import {
  BetterAuthMemberId,
  BetterAuthUserId,
  ClientId,
  type ActorAttribution,
  type DeviceId,
  type JsonObject,
  OwnerId,
} from "@rika/product/hosted-model"
import type { OwnerAuthority, ProductRepositoryService } from "@rika/product-store/product-repository"
import type { hostedProductAuthorityOperations } from "./authority"
import {
  forbidden,
  HostedProductError,
  type HostedProductService,
  repositoryFailure,
  storeFailure,
  unavailable,
} from "./contract"
import type { HostedRepositoriesService } from "../repository-contract"

type CreateConnectionInput = Parameters<HostedProductService["createConnection"]>[0]
type AuthorityOperations = ReturnType<typeof hostedProductAuthorityOperations>

interface ConnectionDependencies {
  readonly clientAuthority: HostedClientAuthorityService
  readonly repository: ProductRepositoryService
  readonly repositories: HostedRepositoriesService
  readonly policy: AuthorizationService
  readonly crypto: Crypto.Crypto
  readonly activateClient: AuthorityOperations["activateClient"]
  readonly resolveOwner: AuthorityOperations["resolveOwner"]
  readonly orb?: {
    readonly templateBuildId: string
    readonly providerScope: string
  }
}

const incompatibleIdentity = () =>
  HostedProductError.make({ kind: "conflict", message: "Thread identity was reused with incompatible input" })

const connectionResult = Effect.fn("HostedProduct.createConnection.result")(function* (
  result: Effect.Success<ReturnType<ProductRepositoryService["createConnection"]>>,
) {
  if (result._tag === "Incompatible") return yield* incompatibleIdentity()
  if (result._tag === "RunnerMissing")
    return yield* HostedProductError.make({ kind: "not-found", message: "Runner is unavailable" })
  if (result._tag === "RunnerAuthorityMismatch") return yield* forbidden("Runner authority does not match the Thread")
  if (result._tag === "RunnerRemoteDenied") return yield* forbidden("Remote Thread creation is denied by the Runner")
  return { threadId: result.threadId }
})

export const hostedProductConnectionOperation = (dependencies: ConnectionDependencies) => {
  const { clientAuthority, repository, repositories, policy, crypto, activateClient, resolveOwner } = dependencies

  const authorizeProject = Effect.fn("HostedProduct.createConnection.authorizeProject")(function* (
    input: CreateConnectionInput,
  ) {
    const authority = yield* resolveOwner(input.principal, input.owner)
    if (input.projectId === undefined) return authority
    const project = yield* repository
      .projectAccess({ authority, projectId: input.projectId })
      .pipe(Effect.mapError(repositoryFailure))
    if (project === undefined)
      return yield* HostedProductError.make({ kind: "not-found", message: "Project is unavailable" })
    if (input.owner._tag !== "OrganizationOwner") return authority
    if (authority.membershipId === undefined) return yield* forbidden()
    yield* policy
      .authorize("project:update", {
        memberId: BetterAuthMemberId.make(authority.membershipId),
        projectRole: project.role,
      })
      .pipe(Effect.mapError(() => forbidden()))
    return authority
  })

  const actorFor = (
    authority: OwnerAuthority,
    input: CreateConnectionInput,
    deviceId: DeviceId,
  ): ActorAttribution | undefined => {
    const userId = BetterAuthUserId.make(authority.userId)
    const clientId = ClientId.make(input.principal.clientId)
    if (authority.owner._tag === "PersonalOwner")
      return { _tag: "PersonalActor", owner: authority.owner, userId, clientId, deviceId }
    if (authority.membershipId === undefined) return undefined
    return {
      _tag: "OrganizationActor",
      owner: authority.owner,
      userId,
      membershipId: BetterAuthMemberId.make(authority.membershipId),
      clientId,
      deviceId,
    }
  }

  const findExisting = Effect.fn("HostedProduct.createConnection.findExisting")(function* (
    input: CreateConnectionInput,
    authority: OwnerAuthority,
    threadId: string,
  ) {
    const existingInput = {
      authority,
      projectId: input.projectId ?? null,
      executorKind: input.executorKind,
      threadId,
    }
    if (input.runnerTarget !== undefined) Object.assign(existingInput, { runnerTarget: input.runnerTarget })
    if (input.archiveThreadId !== undefined) Object.assign(existingInput, { archiveThreadId: input.archiveThreadId })
    if (input.workspaceSeedId !== undefined) Object.assign(existingInput, { workspaceSeedId: input.workspaceSeedId })
    return yield* repository.existingConnection(existingInput).pipe(Effect.mapError(repositoryFailure))
  })

  const placementFor = (
    input: CreateConnectionInput,
    orb: ConnectionDependencies["orb"],
    deviceId: DeviceId,
  ): JsonObject | undefined => {
    if (orb !== undefined)
      return { _tag: "OrbPlacement", templateBuildId: orb.templateBuildId, providerScope: orb.providerScope }
    if (input.runnerTarget === undefined) return undefined
    return {
      _tag: "RunnerPlacement",
      deviceId: input.runnerTarget.deviceId,
      checkoutFingerprint: input.runnerTarget.checkoutFingerprint,
      requestingDeviceId: String(deviceId),
    }
  }

  const provisionConnection = Effect.fn("HostedProduct.createConnection.provision")(function* (
    input: CreateConnectionInput,
    authority: OwnerAuthority,
    threadId: string,
  ) {
    const orb = input.executorKind === "orb" ? dependencies.orb : undefined
    if (input.executorKind === "orb" && orb === undefined)
      return yield* HostedProductError.make({ kind: "unavailable", message: "Orb execution is not configured" })
    const checkout =
      input.executorKind === "orb" && input.projectId !== undefined
        ? yield* repositories.resolve({ ownerId: authority.ownerId, projectId: input.projectId })
        : null
    const currentTime = yield* Clock.currentTimeMillis
    const deviceId = yield* activateClient(input.principal, BetterAuthUserId.make(authority.userId))
    const actor = actorFor(authority, input, deviceId)
    if (actor === undefined) return yield* forbidden()
    const timestamp = DateTime.formatIso(DateTime.makeUnsafe(currentTime))
    yield* clientAuthority.grantClientAuthority({
      ownerId: OwnerId.make(authority.ownerId),
      actor,
      now: timestamp,
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(currentTime + 5 * 60 * 1000)),
    })
    const placement = placementFor(input, orb, deviceId)
    if (placement === undefined) return yield* unavailable()
    const workspaceId = input.threadId === undefined ? yield* crypto.randomUUIDv4 : `${input.threadId}-workspace`
    const connectionInput = {
      authority,
      projectId: input.projectId ?? null,
      executorKind: input.executorKind,
      requestingDeviceId: input.principal.deviceId,
      requestingClientId: input.principal.clientId,
      threadId,
      workspaceId,
      assignmentId: yield* crypto.randomUUIDv4,
      placement,
      checkout,
      now: DateTime.toDate(DateTime.makeUnsafe(currentTime)),
      nowMillis: currentTime,
    }
    if (input.runnerTarget !== undefined) Object.assign(connectionInput, { runnerTarget: input.runnerTarget })
    if (input.archiveThreadId !== undefined) Object.assign(connectionInput, { archiveThreadId: input.archiveThreadId })
    if (input.workspaceSeedId !== undefined) Object.assign(connectionInput, { workspaceSeedId: input.workspaceSeedId })
    const result = yield* repository.createConnection(connectionInput).pipe(Effect.mapError(repositoryFailure))
    return yield* connectionResult(result)
  })

  const createConnection: HostedProductService["createConnection"] = Effect.fn("HostedProduct.createConnection")(
    function* (input) {
      const authority = yield* authorizeProject(input)
      if ((input.executorKind === "runner") !== (input.runnerTarget !== undefined))
        return yield* HostedProductError.make({
          kind: "invalid",
          message: "Runner target is required only for Runner execution",
        })
      const threadId = input.threadId ?? (yield* crypto.randomUUIDv4)
      const existing = yield* findExisting(input, authority, threadId)
      if (existing?._tag === "Incompatible") return yield* incompatibleIdentity()
      if (existing?._tag === "Existing") return { threadId: existing.threadId }
      return yield* provisionConnection(input, authority, threadId)
    },
    Effect.mapError(storeFailure),
  )

  return createConnection
}
