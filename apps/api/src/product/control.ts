import { Clock, Crypto, DateTime, Effect, Schema } from "effect"
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
  type ActorAttribution,
  type HostedOwner,
  type JsonObject,
} from "@rika/product/hosted-model"
import type { ProductProject } from "@rika/product/hosted-product"
import { ExecutorPolicy } from "@rika/product/executor-policy"
import { CheckoutFingerprint, type RunnerProfile, type RunnerTarget } from "@rika/product/runner-registration"
import type { ThreadArchiveReceipt } from "@rika/product/thread-creation"
import type {
  CreateConnectionResult,
  OwnerAuthority,
  ProductRepositoryService,
  ThreadAuthorityProjection,
} from "@rika/product-store/product-repository"
import type { RunnerRegistrationsService, SupervisorPoll } from "@rika/product-store/runner-registrations"

export interface ProductActor {
  readonly userId: string
  readonly clientId: string
  readonly deviceId: string
  readonly dpopJkt?: string
}

export class ProductControlError extends Schema.TaggedError<ProductControlError>()("RikaProductControlError", {
  kind: Schema.Literals(["invalid", "forbidden", "not-found", "conflict", "unavailable"]),
  message: Schema.String,
}) {}

export interface CreateThreadInput {
  readonly actor: ProductActor
  readonly owner: HostedOwner
  readonly threadId: string
  readonly target: "runner" | "orb"
  readonly projectId?: string
  readonly runnerTarget?: RunnerTarget
  readonly workspaceSeedId?: string
  readonly archiveThreadId?: string
}

export interface ArchiveThreadInput {
  readonly actor: ProductActor
  readonly threadId: string
}

export interface ProductControlOptions {
  readonly executorPolicy: ExecutorPolicy
  readonly product: ProductRepositoryService
  readonly runners: RunnerRegistrationsService
  readonly clientAuthority: HostedClientAuthorityService
  readonly authorization: AuthorizationService
  readonly crypto: Crypto.Crypto
  readonly repositories: {
    readonly resolve: (input: {
      readonly ownerId: string
      readonly projectId: string
    }) => Effect.Effect<JsonObject | null, ProductControlError>
  }
  readonly orb?: {
    readonly templateBuildId: string
    readonly providerScope: string
  }
}

const unavailable = () => ProductControlError.make({ kind: "unavailable", message: "Product service is unavailable" })
const forbidden = () => ProductControlError.make({ kind: "forbidden", message: "Product operation is not authorized" })
const repositoryFailure = (error: { readonly kind: "conflict" | "forbidden" | "not-found" | "unavailable" }) =>
  ProductControlError.make({ kind: error.kind, message: "Product metadata operation was rejected" })
const creationReceipt = (result: CreateConnectionResult) => {
  if (result._tag === "Incompatible")
    return ProductControlError.make({ kind: "conflict", message: "Thread identity has different creation input" })
  if (result._tag === "RunnerMissing")
    return ProductControlError.make({ kind: "not-found", message: "Runner is unavailable" })
  if (result._tag === "RunnerAuthorityMismatch" || result._tag === "RunnerRemoteDenied") return forbidden()
  return Effect.succeed({ threadId: result.threadId })
}

const ownerAuthorityForThread = (
  actor: ProductActor,
  thread: ThreadAuthorityProjection,
): OwnerAuthority | undefined => {
  if (thread.kind === "personal" && thread.userId === actor.userId)
    return {
      ownerId: thread.ownerId,
      owner: { _tag: "PersonalOwner", userId: BetterAuthUserId.make(thread.userId) },
      userId: actor.userId,
    }
  if (thread.kind === "organization" && thread.organizationId !== null && thread.membershipId !== null)
    return {
      ownerId: thread.ownerId,
      owner: { _tag: "OrganizationOwner", organizationId: OrganizationId.make(thread.organizationId) },
      userId: actor.userId,
      membershipId: thread.membershipId,
    }
  return undefined
}

export const makeProductControl = (options: ProductControlOptions) => {
  const resolveOwner = Effect.fn("Rika.ProductControl.resolveOwner")(function* (
    actor: ProductActor,
    selection: HostedOwner,
  ) {
    return yield* options.product
      .resolveOwner({
        userId: actor.userId,
        selection,
        proposedOwnerId: yield* options.crypto.randomUUIDv4.pipe(Effect.mapError(unavailable)),
        now: DateTime.toDate(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
      })
      .pipe(Effect.mapError(repositoryFailure))
  })

  const activateClient = Effect.fn("Rika.ProductControl.activateClient")(function* (actor: ProductActor) {
    const currentTime = yield* Clock.currentTimeMillis
    const now = DateTime.formatIso(DateTime.makeUnsafe(currentTime))
    const deviceId = DeviceId.make(actor.deviceId)
    const userId = BetterAuthUserId.make(actor.userId)
    yield* options.clientAuthority
      .registerDevice({
        id: deviceId,
        userId,
        displayName: "Rika CLI",
        publicKeyFingerprint: actor.dpopJkt ?? actor.clientId,
        now,
      })
      .pipe(Effect.mapError(unavailable))
    yield* options.clientAuthority
      .authenticateClient({
        id: ClientId.make(actor.clientId),
        userId,
        deviceId,
        now,
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(currentTime + 5 * 60 * 1000)),
      })
      .pipe(Effect.mapError(unavailable))
    return deviceId
  })

  const projects = Effect.fn("Rika.ProductControl.projects")(function* (actor: ProductActor) {
    const personal = yield* resolveOwner(actor, {
      _tag: "PersonalOwner",
      userId: BetterAuthUserId.make(actor.userId),
    })
    const organizations = yield* options.product.organizationIds(actor.userId).pipe(Effect.mapError(repositoryFailure))
    for (const organizationId of organizations)
      yield* resolveOwner(actor, { _tag: "OrganizationOwner", organizationId: OrganizationId.make(organizationId) })
    return yield* options.product
      .projects({
        userId: actor.userId,
        personalOwnerId: personal.ownerId,
      })
      .pipe(Effect.mapError(repositoryFailure))
  })

  const identity = Effect.fn("Rika.ProductControl.identity")(function* (actor: ProductActor) {
    const personal = yield* resolveOwner(actor, {
      _tag: "PersonalOwner",
      userId: BetterAuthUserId.make(actor.userId),
    })
    return { userId: actor.userId, ownerId: personal.ownerId }
  })

  const createProject = Effect.fn("Rika.ProductControl.createProject")(function* (input: {
    readonly actor: ProductActor
    readonly owner: HostedOwner
    readonly name: string
  }): Effect.fn.Return<ProductProject, ProductControlError> {
    const name = input.name.trim()
    if (name.length === 0 || name.length > 128)
      return yield* ProductControlError.make({ kind: "invalid", message: "Project name must contain 1–128 characters" })
    const authority = yield* resolveOwner(input.actor, input.owner)
    return yield* options.product
      .createProject({
        id: yield* options.crypto.randomUUIDv4.pipe(Effect.mapError(unavailable)),
        authority,
        name,
        now: DateTime.toDate(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
      })
      .pipe(Effect.mapError(repositoryFailure))
  })

  const authorizeProject = Effect.fn("Rika.ProductControl.authorizeProject")(function* (input: CreateThreadInput) {
    const authority = yield* resolveOwner(input.actor, input.owner)
    if (input.projectId === undefined) return authority
    const project = yield* options.product
      .projectAccess({ authority, projectId: input.projectId })
      .pipe(Effect.mapError(repositoryFailure))
    if (project === undefined)
      return yield* ProductControlError.make({ kind: "not-found", message: "Project is unavailable" })
    if (authority.owner._tag === "OrganizationOwner") {
      if (authority.membershipId === undefined) return yield* forbidden()
      yield* options.authorization
        .authorize("project:update", {
          memberId: BetterAuthMemberId.make(authority.membershipId),
          projectRole: project.role,
        })
        .pipe(Effect.mapError(forbidden))
    }
    return authority
  })

  const grantClient = Effect.fn("Rika.ProductControl.grantClient")(function* (
    actor: ProductActor,
    authority: OwnerAuthority,
  ) {
    const deviceId = yield* activateClient(actor)
    const userId = BetterAuthUserId.make(authority.userId)
    const clientId = ClientId.make(actor.clientId)
    let attribution: ActorAttribution
    if (authority.owner._tag === "PersonalOwner")
      attribution = { _tag: "PersonalActor", owner: authority.owner, userId, clientId, deviceId }
    else {
      if (authority.membershipId === undefined) return yield* forbidden()
      attribution = {
        _tag: "OrganizationActor",
        owner: authority.owner,
        userId,
        membershipId: BetterAuthMemberId.make(authority.membershipId),
        clientId,
        deviceId,
      }
    }
    const now = yield* Clock.currentTimeMillis
    yield* options.clientAuthority
      .grantClientAuthority({
        ownerId: OwnerId.make(authority.ownerId),
        actor: attribution,
        now: DateTime.formatIso(DateTime.makeUnsafe(now)),
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + 5 * 60 * 1000)),
      })
      .pipe(Effect.mapError(unavailable))
    return attribution
  })

  const creationPlacement = Effect.fn("Rika.ProductControl.creationPlacement")(function* (
    input: CreateThreadInput,
    authority: OwnerAuthority,
  ): Effect.fn.Return<{ readonly placement: JsonObject; readonly checkout: JsonObject | null }, ProductControlError> {
    if (input.runnerTarget !== undefined)
      return {
        placement: {
          _tag: "RunnerPlacement",
          deviceId: input.runnerTarget.deviceId,
          checkoutFingerprint: input.runnerTarget.checkoutFingerprint,
          requestingDeviceId: input.actor.deviceId,
          executorPolicy: yield* Schema.decodeEffect(ExecutorPolicy)(options.executorPolicy).pipe(
            Effect.mapError(unavailable),
          ),
        },
        checkout: null,
      }
    if (options.orb === undefined)
      return yield* ProductControlError.make({ kind: "unavailable", message: "Orb execution is not configured" })
    return {
      placement: {
        _tag: "OrbPlacement",
        templateBuildId: options.orb.templateBuildId,
        providerScope: options.orb.providerScope,
        executorPolicy: yield* Schema.decodeEffect(ExecutorPolicy)(options.executorPolicy).pipe(
          Effect.mapError(unavailable),
        ),
        lineageId: yield* options.crypto.randomUUIDv4.pipe(Effect.mapError(unavailable)),
      },
      checkout:
        input.projectId === undefined
          ? null
          : yield* options.repositories.resolve({ ownerId: authority.ownerId, projectId: input.projectId }),
    }
  })

  const createThread = Effect.fn("Rika.ProductControl.createThread")(function* (input: CreateThreadInput) {
    if (
      input.threadId.trim().length === 0 ||
      input.threadId.length > 512 ||
      (input.target === "runner") !== (input.runnerTarget !== undefined) ||
      (input.target === "runner" && input.workspaceSeedId !== undefined)
    )
      return yield* ProductControlError.make({ kind: "invalid", message: "Thread creation placement is invalid" })
    const authority = yield* authorizeProject(input)
    const existingInput: Parameters<ProductRepositoryService["existingConnection"]>[0] = {
      authority,
      projectId: input.projectId ?? null,
      executorKind: input.target,
      threadId: input.threadId,
    }
    if (input.runnerTarget !== undefined) Object.assign(existingInput, { runnerTarget: input.runnerTarget })
    if (input.workspaceSeedId !== undefined) Object.assign(existingInput, { workspaceSeedId: input.workspaceSeedId })
    if (input.archiveThreadId !== undefined) Object.assign(existingInput, { archiveThreadId: input.archiveThreadId })
    const existing = yield* options.product.existingConnection(existingInput).pipe(Effect.mapError(repositoryFailure))
    if (existing?._tag === "Incompatible") return yield* creationReceipt(existing)
    const attribution = yield* grantClient(input.actor, authority)
    if (existing !== undefined) return yield* creationReceipt(existing)
    if (input.archiveThreadId !== undefined)
      yield* options.clientAuthority
        .authorizeThread({
          ownerId: OwnerId.make(authority.ownerId),
          threadId: ThreadId.make(input.archiveThreadId),
          actor: attribution,
          action: "thread:operate",
        })
        .pipe(Effect.mapError((error) => (error.reason === "database" ? unavailable() : forbidden())))
    const { placement, checkout } = yield* creationPlacement(input, authority)
    const now = yield* Clock.currentTimeMillis
    const result = yield* options.product
      .createConnection({
        ...existingInput,
        requestingDeviceId: input.actor.deviceId,
        requestingClientId: input.actor.clientId,
        workspaceId: yield* options.crypto.randomUUIDv4.pipe(Effect.mapError(unavailable)),
        assignmentId: yield* options.crypto.randomUUIDv4.pipe(Effect.mapError(unavailable)),
        placement,
        checkout,
        now: DateTime.toDate(DateTime.makeUnsafe(now)),
        nowMillis: now,
      })
      .pipe(Effect.mapError(repositoryFailure))
    return yield* creationReceipt(result)
  })

  const archiveThread = Effect.fn("Rika.ProductControl.archiveThread")(function* (
    input: ArchiveThreadInput,
  ): Effect.fn.Return<ThreadArchiveReceipt, ProductControlError> {
    if (input.threadId.trim().length === 0 || input.threadId.length > 512)
      return yield* ProductControlError.make({ kind: "invalid", message: "Thread archive input is invalid" })
    const thread = yield* options.product
      .threadAuthority(input.actor.userId, input.threadId)
      .pipe(Effect.mapError(repositoryFailure))
    if (thread === undefined)
      return yield* ProductControlError.make({ kind: "not-found", message: "Thread is unavailable" })
    const authority = ownerAuthorityForThread(input.actor, thread)
    if (authority === undefined) return yield* forbidden()
    const attribution = yield* grantClient(input.actor, authority)
    yield* options.clientAuthority
      .authorizeThread({
        ownerId: OwnerId.make(authority.ownerId),
        threadId: ThreadId.make(input.threadId),
        actor: attribution,
        action: "thread:operate",
      })
      .pipe(Effect.mapError((error) => (error.reason === "database" ? unavailable() : forbidden())))
    const nowMillis = yield* Clock.currentTimeMillis
    yield* options.product
      .archiveThread({ ownerId: authority.ownerId, threadId: input.threadId, nowMillis })
      .pipe(Effect.mapError(repositoryFailure))
    return { threadId: input.threadId, archived: true }
  })

  const registerRunner = Effect.fn("Rika.ProductControl.registerRunner")(function* (input: {
    readonly actor: ProductActor
    readonly checkoutFingerprint: string
    readonly profile: RunnerProfile
  }): Effect.fn.Return<void, ProductControlError> {
    const deviceId = yield* activateClient(input.actor)
    const stored = yield* options.runners
      .upsert({
        deviceId,
        userId: input.actor.userId,
        checkoutFingerprint: input.checkoutFingerprint,
        profile: input.profile,
      })
      .pipe(Effect.mapError(unavailable))
    if (stored !== "stored") return yield* forbidden()
  })

  const setRemoteThreadCreation = Effect.fn("Rika.ProductControl.setRemoteThreadCreation")(function* (input: {
    readonly actor: ProductActor
    readonly checkoutFingerprint: string
    readonly allowed: boolean
  }): Effect.fn.Return<void, ProductControlError> {
    yield* activateClient(input.actor)
    const updated = yield* options.runners
      .setRemoteThreadCreation({
        deviceId: input.actor.deviceId,
        userId: input.actor.userId,
        checkoutFingerprint: input.checkoutFingerprint,
        allowed: input.allowed,
      })
      .pipe(Effect.mapError(unavailable))
    if (!updated) return yield* ProductControlError.make({ kind: "not-found", message: "Runner is unavailable" })
  })

  /**
   * Poll the checkout-scoped assignment queue on the supervisor lease. The actor is already device-authenticated, so
   * polling must not re-write device or client rows on every cycle.
   */
  const pollRunnerAssignment = Effect.fn("Rika.ProductControl.pollRunnerAssignment")(function* (input: {
    readonly actor: ProductActor
    readonly checkoutFingerprint: string
    readonly supervisorId: string
    readonly activeAssignmentIds: ReadonlyArray<string>
  }): Effect.fn.Return<SupervisorPoll, ProductControlError> {
    if (
      input.supervisorId.trim().length === 0 ||
      input.supervisorId.length > 256 ||
      input.activeAssignmentIds.length > 64 ||
      input.activeAssignmentIds.some((assignmentId) => assignmentId.trim().length === 0 || assignmentId.length > 512)
    )
      return yield* ProductControlError.make({ kind: "invalid", message: "Runner poll input is invalid" })
    const checkoutFingerprint = yield* Schema.decodeEffect(CheckoutFingerprint)(input.checkoutFingerprint).pipe(
      Effect.mapError(() => ProductControlError.make({ kind: "invalid", message: "Runner poll input is invalid" })),
    )
    return yield* options.runners
      .claimSupervisorAndPoll({
        deviceId: input.actor.deviceId,
        userId: input.actor.userId,
        checkoutFingerprint,
        supervisorId: input.supervisorId,
        activeAssignmentIds: input.activeAssignmentIds,
      })
      .pipe(Effect.mapError(unavailable))
  })

  return {
    identity,
    projects,
    createProject,
    createThread,
    archiveThread,
    registerRunner,
    setRemoteThreadCreation,
    pollRunnerAssignment,
  }
}

export type ProductControl = ReturnType<typeof makeProductControl>
