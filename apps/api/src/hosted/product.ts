import { Clock, Context, Crypto, DateTime, Effect, Layer, Option, Schema } from "effect"
import { AuthorizationPolicy, type AuthorizationAction } from "@rika/product/hosted-authorization"
import {
  BetterAuthMemberId,
  BetterAuthUserId,
  ClientId,
  CommandId,
  DeviceId,
  type ActorAttribution,
  type HostedOwner,
  IdempotencyKey,
  JsonObject,
  OrganizationId,
  OwnerId,
  ThreadId,
} from "@rika/product/hosted-model"
import { HostedStore, StoreError } from "@rika/product/hosted-store"
import type { PromptPart } from "@rika/product/execution-request"
import { TurnId } from "@rika/product/turn-record"
import type { RunnerProfile, RunnerTarget, RemoteThreadCreationPreference } from "@rika/product/runner-registration"
import { layer as postgresLayer } from "@rika/product-store/layer"
import { ProductRepository, ProductRepositoryError } from "@rika/product-store/product-repository"
import { RunnerRegistrations, RunnerRegistrationsError } from "@rika/product-store/runner-registrations"
import {
  HostedModelRegistry,
  HostedModelRegistryError,
  testLayer as hostedModelRegistryTestLayer,
} from "./environment/model-registry"
import { HostedRepositories, unavailableLayer as hostedRepositoriesUnavailableLayer } from "./repositories"

export interface AuthenticatedPrincipal {
  readonly userId: string
  readonly deviceId: string
  readonly clientId: string
  readonly dpopJkt?: string
}

export type OwnerSelection = HostedOwner

export interface ProjectContext {
  readonly id: string
  readonly ownerId: string
  readonly owner: HostedOwner
  readonly name: string
  readonly role: "viewer" | "controller" | "operator" | "owner"
}

export type AdmittedRun =
  | {
      readonly _tag: "Admitted"
      readonly commandId: string
      readonly turnId: string
      readonly status: "accepted" | "queued"
    }
  | { readonly _tag: "Cancelled"; readonly commandId: string }

export interface ThreadAuthority {
  readonly ownerId: OwnerId
  readonly actor: ActorAttribution
}

export interface OwnerAuthority {
  readonly ownerId: OwnerId
}

export interface ThreadExecutionContext {
  readonly repository: JsonObject | null
  readonly branch: string | null
  readonly executor: JsonObject
}

export class HostedProductError extends Schema.TaggedError<HostedProductError>()("HostedProductError", {
  kind: Schema.optionalKey(Schema.Literals(["conflict", "not-found", "forbidden", "invalid", "unavailable"])),
  message: Schema.String,
}) {}

const unavailable = () => HostedProductError.make({ kind: "unavailable", message: "Rika service is unavailable" })

const forbidden = (message = "Resource is unavailable") => HostedProductError.make({ kind: "forbidden", message })

type ProductOperationError = HostedProductError | StoreError | { readonly _tag: string }

const storeFailure = (error: ProductOperationError) => {
  if (Schema.is(HostedProductError)(error)) return error
  if (!Schema.is(StoreError)(error)) return unavailable()
  let kind: NonNullable<HostedProductError["kind"]> = "unavailable"
  if (error.reason === "conflict" || error.reason === "stale-fence") kind = "conflict"
  else if (error.reason === "not-found") kind = "not-found"
  else if (error.reason === "invalid-authority") kind = "forbidden"
  return HostedProductError.make({ kind, message: "Rika operation was rejected" })
}

const modelFailure = (error: HostedModelRegistryError) =>
  HostedProductError.make({
    kind: error.kind === "unavailable" ? "unavailable" : "invalid",
    message: error.message,
  })

const repositoryFailure = (error: ProductRepositoryError | RunnerRegistrationsError) =>
  Schema.is(ProductRepositoryError)(error)
    ? HostedProductError.make({ kind: error.kind, message: error.message })
    : unavailable()

export interface HostedProductService {
  readonly ready: Effect.Effect<void, HostedProductError>
  readonly projects: (
    principal: AuthenticatedPrincipal,
  ) => Effect.Effect<ReadonlyArray<ProjectContext>, HostedProductError>
  readonly createProject: (input: {
    readonly principal: AuthenticatedPrincipal
    readonly owner: OwnerSelection
    readonly name: string
  }) => Effect.Effect<ProjectContext, HostedProductError>
  readonly createConnection: (input: {
    readonly principal: AuthenticatedPrincipal
    readonly owner: OwnerSelection
    readonly projectId?: string
    readonly executorKind: "runner" | "orb"
    readonly runnerTarget?: RunnerTarget
    readonly workspaceSeedId?: string
    readonly threadId?: string
    readonly archiveThreadId?: string
  }) => Effect.Effect<{ readonly threadId: string }, HostedProductError>
  readonly registerRunner: (input: {
    readonly principal: AuthenticatedPrincipal
    readonly checkoutFingerprint: string
    readonly registration: RunnerProfile
  }) => Effect.Effect<void, HostedProductError>
  readonly setRemoteThreadCreation: (input: {
    readonly principal: AuthenticatedPrincipal
    readonly checkoutFingerprint: string
    readonly preference: RemoteThreadCreationPreference
  }) => Effect.Effect<void, HostedProductError>
  readonly pollRunner: (input: {
    readonly principal: AuthenticatedPrincipal
    readonly checkoutFingerprint: string
    readonly supervisorId: string
    readonly activeAssignmentIds: ReadonlyArray<string>
  }) => Effect.Effect<
    {
      readonly claimed: boolean
      readonly assignment?: {
        readonly assignmentId: string
        readonly threadId: string
        readonly workspaceId: string
        readonly resume: boolean
        readonly leaseExpiresAt: number | null
      }
    },
    HostedProductError
  >
  readonly admitRun: (input: {
    readonly principal: AuthenticatedPrincipal
    readonly threadId: string
    readonly operationKey: string
    readonly prompt: string
    readonly promptParts?: ReadonlyArray<PromptPart>
    readonly mode?: string
  }) => Effect.Effect<AdmittedRun, HostedProductError>
  readonly admitAuthorizedRun: (input: {
    readonly authority: ThreadAuthority
    readonly threadId: string
    readonly operationKey: string
    readonly turnId: string
    readonly prompt: string
    readonly promptParts?: ReadonlyArray<PromptPart>
    readonly mode?: string
  }) => Effect.Effect<AdmittedRun, HostedProductError>
  readonly cancelRunAdmission: (input: {
    readonly principal: AuthenticatedPrincipal
    readonly threadId: string
    readonly cancelCommandId: string
    readonly targetCommandId: string
  }) => Effect.Effect<{ readonly turnId?: string }, HostedProductError>
  readonly cancelAuthorizedRunAdmission: (input: {
    readonly authority: ThreadAuthority
    readonly threadId: string
    readonly cancelCommandId: string
    readonly targetCommandId: string
  }) => Effect.Effect<{ readonly turnId?: string }, HostedProductError>
  readonly authorizeOwner: (
    principal: AuthenticatedPrincipal,
    owner: OwnerSelection,
  ) => Effect.Effect<OwnerAuthority, HostedProductError>
  readonly authorizeThread: (
    principal: AuthenticatedPrincipal,
    threadId: string,
    action: AuthorizationAction,
  ) => Effect.Effect<ThreadAuthority, HostedProductError>
  readonly threadExecutionContext: (
    ownerId: OwnerId,
    threadId: ThreadId,
  ) => Effect.Effect<ThreadExecutionContext, HostedProductError>
  readonly activatePrincipal: (principal: AuthenticatedPrincipal) => Effect.Effect<void, HostedProductError>
}

export class HostedProduct extends Context.Service<HostedProduct, HostedProductService>()(
  "@rika/api/hosted/product/HostedProduct",
) {}

export const layer = (options: {
  readonly orb?: {
    readonly templateBuildId: string
    readonly providerScope: string
  }
  readonly promptAdmissionReadiness: Effect.Effect<boolean>
}) =>
  Layer.effect(
    HostedProduct,
    Effect.gen(function* () {
      const store = yield* HostedStore
      const repository = yield* ProductRepository
      const runners = yield* RunnerRegistrations
      const policy = yield* AuthorizationPolicy
      const crypto = yield* Crypto.Crypto
      const modelRegistry = yield* HostedModelRegistry
      const repositories = yield* HostedRepositories

      const activateClient = Effect.fn("HostedProduct.activateClient")(function* (
        principal: AuthenticatedPrincipal,
        userId: BetterAuthUserId,
      ) {
        const currentTime = yield* Clock.currentTimeMillis
        const now = DateTime.formatIso(DateTime.makeUnsafe(currentTime))
        const deviceId = DeviceId.make(principal.deviceId)
        yield* store.registerDevice({
          id: deviceId,
          userId,
          displayName: "Rika CLI",
          publicKeyFingerprint: principal.dpopJkt ?? principal.clientId,
          now,
        })
        yield* store.authenticateClient({
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
        const organizationIds = yield* repository
          .organizationIds(principal.userId)
          .pipe(Effect.mapError(repositoryFailure))
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

      const createConnection: HostedProductService["createConnection"] = Effect.fn("HostedProduct.createConnection")(
        function* (input) {
          const authority = yield* resolveOwner(input.principal, input.owner)
          const selected =
            input.projectId === undefined
              ? undefined
              : yield* repository
                  .projectAccess({ authority, projectId: input.projectId })
                  .pipe(Effect.mapError(repositoryFailure))
          if (input.projectId !== undefined && selected === undefined)
            return yield* HostedProductError.make({ kind: "not-found", message: "Project is unavailable" })
          if (input.owner._tag === "OrganizationOwner" && selected !== undefined) {
            if (authority.membershipId === undefined) return yield* forbidden()
            yield* policy
              .authorize("project:update", {
                memberId: BetterAuthMemberId.make(authority.membershipId),
                projectRole: selected.role,
              })
              .pipe(Effect.mapError(() => forbidden()))
          }
          if ((input.executorKind === "runner") !== (input.runnerTarget !== undefined))
            return yield* HostedProductError.make({
              kind: "invalid",
              message: "Runner target is required only for Runner execution",
            })
          const threadId = input.threadId ?? (yield* crypto.randomUUIDv4)
          const existingInput = {
            authority,
            projectId: input.projectId ?? null,
            executorKind: input.executorKind,
            threadId,
          }
          if (input.runnerTarget !== undefined) Object.assign(existingInput, { runnerTarget: input.runnerTarget })
          if (input.archiveThreadId !== undefined)
            Object.assign(existingInput, { archiveThreadId: input.archiveThreadId })
          if (input.workspaceSeedId !== undefined)
            Object.assign(existingInput, { workspaceSeedId: input.workspaceSeedId })
          const existing = yield* repository.existingConnection(existingInput).pipe(Effect.mapError(repositoryFailure))
          if (existing?._tag === "Incompatible")
            return yield* HostedProductError.make({
              kind: "conflict",
              message: "Thread identity was reused with incompatible input",
            })
          if (existing?._tag === "Existing") return { threadId: existing.threadId }
          const orb = input.executorKind === "orb" ? options.orb : undefined
          if (input.executorKind === "orb" && orb === undefined)
            return yield* HostedProductError.make({ kind: "unavailable", message: "Orb execution is not configured" })
          const checkout =
            input.executorKind === "orb" && input.projectId !== undefined
              ? yield* repositories.resolve({ ownerId: authority.ownerId, projectId: input.projectId })
              : null
          const currentTime = yield* Clock.currentTimeMillis
          const deviceId = yield* activateClient(input.principal, BetterAuthUserId.make(authority.userId))
          const timestamp = DateTime.formatIso(DateTime.makeUnsafe(currentTime))
          let actor: ActorAttribution | undefined
          if (authority.owner._tag === "PersonalOwner") {
            actor = {
              _tag: "PersonalActor" as const,
              owner: authority.owner,
              userId: BetterAuthUserId.make(authority.userId),
              clientId: ClientId.make(input.principal.clientId),
              deviceId,
            }
          } else if (authority.membershipId !== undefined) {
            actor = {
              _tag: "OrganizationActor" as const,
              owner: authority.owner,
              userId: BetterAuthUserId.make(authority.userId),
              membershipId: BetterAuthMemberId.make(authority.membershipId),
              clientId: ClientId.make(input.principal.clientId),
              deviceId,
            }
          }
          if (actor === undefined) return yield* forbidden()
          yield* store.grantClientAuthority({
            ownerId: OwnerId.make(authority.ownerId),
            actor,
            now: timestamp,
            expiresAt: DateTime.formatIso(DateTime.makeUnsafe(currentTime + 5 * 60 * 1000)),
          })
          const fallbackWorkspaceId =
            input.threadId === undefined ? yield* crypto.randomUUIDv4 : `${input.threadId}-workspace`
          let placement: JsonObject | undefined
          if (orb === undefined && input.runnerTarget !== undefined) {
            placement = {
              _tag: "RunnerPlacement" as const,
              deviceId: input.runnerTarget.deviceId,
              checkoutFingerprint: input.runnerTarget.checkoutFingerprint,
              requestingDeviceId: String(deviceId),
            }
          } else if (orb !== undefined) {
            placement = {
              _tag: "OrbPlacement" as const,
              templateBuildId: orb.templateBuildId,
              providerScope: orb.providerScope,
            }
          }
          if (placement === undefined) return yield* unavailable()
          const connectionInput = {
            authority,
            projectId: input.projectId ?? null,
            executorKind: input.executorKind,
            requestingDeviceId: input.principal.deviceId,
            requestingClientId: input.principal.clientId,
            threadId,
            workspaceId: fallbackWorkspaceId,
            assignmentId: yield* crypto.randomUUIDv4,
            placement,
            checkout,
            now: DateTime.toDate(DateTime.makeUnsafe(currentTime)),
            nowMillis: currentTime,
          }
          if (input.runnerTarget !== undefined) Object.assign(connectionInput, { runnerTarget: input.runnerTarget })
          if (input.archiveThreadId !== undefined)
            Object.assign(connectionInput, { archiveThreadId: input.archiveThreadId })
          if (input.workspaceSeedId !== undefined)
            Object.assign(connectionInput, { workspaceSeedId: input.workspaceSeedId })
          const result = yield* repository.createConnection(connectionInput).pipe(Effect.mapError(repositoryFailure))
          if (result._tag === "Incompatible")
            return yield* HostedProductError.make({
              kind: "conflict",
              message: "Thread identity was reused with incompatible input",
            })
          if (result._tag === "RunnerMissing")
            return yield* HostedProductError.make({ kind: "not-found", message: "Runner is unavailable" })
          if (result._tag === "RunnerAuthorityMismatch")
            return yield* forbidden("Runner authority does not match the Thread")
          if (result._tag === "RunnerRemoteDenied")
            return yield* forbidden("Remote Thread creation is denied by the Runner")
          return { threadId: result.threadId }
        },
        Effect.mapError(storeFailure),
      )

      const registerRunner: HostedProductService["registerRunner"] = Effect.fn("HostedProduct.registerRunner")(
        function* (input) {
          const userId = BetterAuthUserId.make(input.principal.userId)
          const deviceId = yield* activateClient(input.principal, userId)
          yield* runners
            .upsert({ deviceId, userId, checkoutFingerprint: input.checkoutFingerprint, profile: input.registration })
            .pipe(Effect.mapError(repositoryFailure))
        },
        Effect.mapError(storeFailure),
      )

      const setRemoteThreadCreation: HostedProductService["setRemoteThreadCreation"] = Effect.fn(
        "HostedProduct.setRemoteThreadCreation",
      )(function* (input) {
        yield* activateClient(input.principal, BetterAuthUserId.make(input.principal.userId))
        const updated = yield* runners
          .setRemoteThreadCreation({
            deviceId: input.principal.deviceId,
            userId: input.principal.userId,
            checkoutFingerprint: input.checkoutFingerprint,
            allowed: input.preference.preference === "allowed",
          })
          .pipe(Effect.mapError(repositoryFailure))
        if (!updated) return yield* HostedProductError.make({ kind: "not-found", message: "Runner is unavailable" })
      }, Effect.mapError(storeFailure))

      const pollRunner: HostedProductService["pollRunner"] = Effect.fn("HostedProduct.pollRunner")(function* (input) {
        yield* activateClient(input.principal, BetterAuthUserId.make(input.principal.userId))
        return yield* runners
          .claimSupervisorAndPoll({
            deviceId: input.principal.deviceId,
            userId: input.principal.userId,
            checkoutFingerprint: input.checkoutFingerprint,
            supervisorId: input.supervisorId,
            activeAssignmentIds: input.activeAssignmentIds,
          })
          .pipe(Effect.mapError(repositoryFailure))
      }, Effect.mapError(storeFailure))

      const authorizeOwner: HostedProductService["authorizeOwner"] = Effect.fn("HostedProduct.authorizeOwner")(
        function* (principal, owner) {
          yield* activateClient(principal, BetterAuthUserId.make(principal.userId))
          const authority = yield* resolveOwner(principal, owner)
          return { ownerId: OwnerId.make(authority.ownerId) }
        },
        Effect.mapError(storeFailure),
      )

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
          yield* store.grantClientAuthority({
            ownerId: OwnerId.make(resolved.ownerId),
            actor,
            now: DateTime.formatIso(DateTime.makeUnsafe(nowMillis)),
            expiresAt: DateTime.formatIso(DateTime.makeUnsafe(nowMillis + 5 * 60 * 1000)),
          })
          yield* store.authorizeThread({
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

      const threadExecutionContext: HostedProductService["threadExecutionContext"] = Effect.fn(
        "HostedProduct.threadExecutionContext",
      )(function* (ownerId, threadId) {
        const row = yield* repository.threadExecutionContext(ownerId, threadId).pipe(Effect.mapError(repositoryFailure))
        if (row === undefined)
          return yield* HostedProductError.make({ kind: "not-found", message: "Thread executor is unavailable" })
        const repositoryValue = row.checkout ?? row.localRepository
        const decodedRepository =
          repositoryValue === null
            ? null
            : yield* Schema.decodeUnknownEffect(JsonObject)(repositoryValue).pipe(Effect.mapError(unavailable))
        const decodedBranch =
          decodedRepository === null
            ? Option.none()
            : Schema.decodeUnknownOption(Schema.NonEmptyString)(decodedRepository.branch)
        const branch = Option.getOrNull(decodedBranch)
        return {
          repository: decodedRepository,
          branch,
          executor: {
            assignmentId: row.assignmentId,
            kind: row.executorKind,
            generation: row.generation,
            lifecycle: row.lifecycle,
            executorInstanceId: row.executorInstanceId,
            providerInstanceId: row.providerInstanceId,
          },
        }
      }, Effect.mapError(storeFailure))

      const activatePrincipal: HostedProductService["activatePrincipal"] = Effect.fn("HostedProduct.activatePrincipal")(
        function* (principal) {
          yield* activateClient(principal, BetterAuthUserId.make(principal.userId))
        },
        Effect.mapError(storeFailure),
      )

      const admitAuthorizedRun: HostedProductService["admitAuthorizedRun"] = Effect.fn(
        "HostedProduct.admitAuthorizedRun",
      )(function* (input) {
        const executionRoute = yield* modelRegistry
          .resolve(input.authority.ownerId, input.mode)
          .pipe(Effect.mapError(modelFailure))
        const commandId = CommandId.make(input.operationKey)
        const turnId = TurnId.make(input.turnId)
        const admittedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))
        const readinessProof = yield* options.promptAdmissionReadiness
        const promptInput = {
          ownerId: input.authority.ownerId,
          threadId: ThreadId.make(input.threadId),
          commandId,
          idempotencyKey: IdempotencyKey.make(input.operationKey),
          turnId,
          actor: input.authority.actor,
          prompt: input.prompt,
          executionRoute,
          admittedAt,
          queueCapacity: 32,
          readinessProof,
        }
        if (input.promptParts !== undefined) Object.assign(promptInput, { promptParts: input.promptParts })
        const admitted = yield* store.admitPrompt(promptInput)
        if (admitted._tag === "Cancelled") return { _tag: "Cancelled" as const, commandId: input.operationKey }
        return {
          _tag: "Admitted" as const,
          commandId: String(admitted.command.commandId),
          turnId: String(admitted.turnId),
          status: admitted.status,
        }
      }, Effect.mapError(storeFailure))

      const admitRun: HostedProductService["admitRun"] = Effect.fn("HostedProduct.admitRun")(function* (input) {
        const authority = yield* authorizeThread(input.principal, input.threadId, "thread:operate")
        const turnId = yield* crypto.randomUUIDv4.pipe(Effect.mapError(unavailable))
        return yield* admitAuthorizedRun({ ...input, authority, turnId })
      })

      const cancelAuthorizedRunAdmission: HostedProductService["cancelAuthorizedRunAdmission"] = Effect.fn(
        "HostedProduct.cancelAuthorizedRunAdmission",
      )(function* (input) {
        const cancelledAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))
        const cancellation = yield* store.cancelPrompt({
          ownerId: input.authority.ownerId,
          threadId: ThreadId.make(input.threadId),
          cancelCommandId: CommandId.make(input.cancelCommandId),
          targetCommandId: CommandId.make(input.targetCommandId),
          actor: input.authority.actor,
          cancelledAt,
        })
        return cancellation._tag === "Turn" ? { turnId: String(cancellation.turnId) } : {}
      }, Effect.mapError(storeFailure))

      const cancelRunAdmission: HostedProductService["cancelRunAdmission"] = Effect.fn(
        "HostedProduct.cancelRunAdmission",
      )(function* (input) {
        const authority = yield* authorizeThread(input.principal, input.threadId, "thread:operate")
        return yield* cancelAuthorizedRunAdmission({ ...input, authority })
      })

      return HostedProduct.of({
        ready: repository.ready.pipe(Effect.mapError(repositoryFailure)),
        projects,
        createProject,
        createConnection,
        registerRunner,
        setRemoteThreadCreation,
        pollRunner,
        admitRun,
        admitAuthorizedRun,
        cancelRunAdmission,
        cancelAuthorizedRunAdmission,
        authorizeOwner,
        authorizeThread,
        threadExecutionContext,
        activatePrincipal,
      })
    }),
  )

export const postgresTest = (options: {
  readonly database: Parameters<typeof postgresLayer>[0]
  readonly templateBuildId: string
  readonly providerScope: string
  readonly promptAdmissionReadiness?: Effect.Effect<boolean>
}) =>
  layer({
    orb: {
      templateBuildId: options.templateBuildId,
      providerScope: options.providerScope,
    },
    promptAdmissionReadiness: options.promptAdmissionReadiness ?? Effect.succeed(true),
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        postgresLayer(options.database),
        AuthorizationPolicy.layer,
        hostedModelRegistryTestLayer,
        hostedRepositoriesUnavailableLayer,
      ),
    ),
  )
