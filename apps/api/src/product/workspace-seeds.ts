import type { AuthorizationService } from "@rika/product/hosted-authorization"
import { WorkspaceSeed, WorkspaceSeedRepository } from "@rika/product/executor-assignment"
import { BetterAuthMemberId, type HostedOwner } from "@rika/product/hosted-model"
import type { OwnerAuthority, ProductRepositoryService } from "@rika/product-store/product-repository"
import type { RepositoryStoreService } from "@rika/product-store/repositories"
import type { EncodedArchive } from "@rika/workspace-input/contract"
import type { WorkspaceSeedVaultContract } from "@rika/workspace-input/vault"
import { WorkspaceSeedStageReceipt } from "@rika/workspace-input/workspace-seed-http-contract"
import { Clock, Crypto, DateTime, Effect, Exit, Schema } from "effect"

export interface WorkspaceSeedActor {
  readonly userId: string
  readonly clientId: string
  readonly deviceId: string
}

export interface StageWorkspaceSeedInput {
  readonly actor: WorkspaceSeedActor
  readonly owner: HostedOwner
  readonly projectId?: string
  readonly archive: EncodedArchive
}

export class WorkspaceSeedServiceError extends Schema.TaggedError<WorkspaceSeedServiceError>()(
  "RikaApiV2WorkspaceSeedServiceError",
  {
    kind: Schema.Literals(["invalid", "forbidden", "not-found", "conflict", "unavailable"]),
    message: Schema.String,
  },
) {}

export interface WorkspaceSeedService {
  readonly stage: (
    input: StageWorkspaceSeedInput,
  ) => Effect.Effect<WorkspaceSeedStageReceipt, WorkspaceSeedServiceError>
}

export interface WorkspaceSeedServiceOptions {
  readonly product: Pick<ProductRepositoryService, "resolveOwner" | "projectAccess" | "stageWorkspaceSeed">
  readonly repositories: Pick<RepositoryStoreService, "loadBinding">
  readonly authorization: AuthorizationService
  readonly vault: WorkspaceSeedVaultContract
  readonly crypto: Crypto.Crypto
  readonly clock: Clock.Clock
}

interface AuthorizedSeedScope {
  readonly authority: OwnerAuthority
  readonly sourceRepository: WorkspaceSeedRepository | null
}

const seedLifetimeMillis = 10 * 60 * 1_000
const failure = (kind: WorkspaceSeedServiceError["kind"], message: string) =>
  WorkspaceSeedServiceError.make({ kind, message })
const unavailable = () => failure("unavailable", "Workspace seed service is unavailable")
const forbidden = () => failure("forbidden", "Workspace seed operation is not authorized")
const notFound = () => failure("not-found", "Project is unavailable")

const productFailure = (error: { readonly kind: "conflict" | "forbidden" | "not-found" | "unavailable" }) => {
  if (error.kind === "forbidden") return forbidden()
  if (error.kind === "not-found") return notFound()
  if (error.kind === "conflict") return failure("conflict", "Workspace seed metadata conflicts with existing state")
  return unavailable()
}

const repositoryFailure = (error: {
  readonly reason: "authorization" | "configuration" | "database" | "stale-fence"
}) => {
  if (error.reason === "authorization") return forbidden()
  if (error.reason === "configuration") return notFound()
  return unavailable()
}

const vaultFailure = (error: { readonly kind: "corrupt" | "crypto" | "missing" | "object" | "scope" | "size" }) =>
  error.kind === "corrupt" || error.kind === "scope" || error.kind === "size"
    ? failure("invalid", "Workspace archive is invalid")
    : unavailable()

const writableProjectRole = (role: "viewer" | "controller" | "operator" | "owner") =>
  role === "operator" || role === "owner"

const sameRepository = (left: WorkspaceSeedRepository | null, right: WorkspaceSeedRepository | null) =>
  left === null ? right === null : right !== null && left.owner === right.owner && left.name === right.name

export const makeWorkspaceSeedService = (options: WorkspaceSeedServiceOptions): WorkspaceSeedService => {
  const randomId = () => options.crypto.randomUUIDv4.pipe(Effect.mapError(unavailable))

  const authorizeScope = Effect.fn("RikaApiV2.WorkspaceSeeds.authorizeScope")(function* (
    input: StageWorkspaceSeedInput,
    proposedOwnerId: string,
    now: Date,
  ): Effect.fn.Return<AuthorizedSeedScope, WorkspaceSeedServiceError> {
    const authority = yield* options.product
      .resolveOwner({ userId: input.actor.userId, selection: input.owner, proposedOwnerId, now })
      .pipe(Effect.mapError(productFailure))
    if (authority.owner._tag === "OrganizationOwner" && authority.membershipId === undefined) return yield* forbidden()
    if (input.projectId === undefined) return { authority, sourceRepository: null }

    const project = yield* options.product
      .projectAccess({ authority, projectId: input.projectId })
      .pipe(Effect.mapError(productFailure))
    if (project === undefined) return yield* notFound()
    if (!writableProjectRole(project.role)) return yield* forbidden()
    if (authority.owner._tag === "OrganizationOwner") {
      const membershipId = authority.membershipId
      if (membershipId === undefined) return yield* forbidden()
      yield* options.authorization
        .authorize("project:update", {
          memberId: BetterAuthMemberId.make(membershipId),
          projectRole: project.role,
        })
        .pipe(Effect.mapError(forbidden))
    }

    const binding = yield* options.repositories
      .loadBinding(authority.ownerId, input.projectId)
      .pipe(Effect.mapError(repositoryFailure))
    if (binding.ownerId !== authority.ownerId || binding.projectId !== input.projectId) return yield* forbidden()
    const sourceRepository = yield* Schema.decodeEffect(WorkspaceSeedRepository)({
      owner: binding.repositoryOwner,
      name: binding.repositoryName,
    }).pipe(Effect.mapError(unavailable))
    return { authority, sourceRepository }
  })

  const stage: WorkspaceSeedService["stage"] = Effect.fn("RikaApiV2.WorkspaceSeeds.stage")(function* (input) {
    const proposedOwnerId = yield* randomId()
    const firstNowMillis = yield* options.clock.currentTimeMillis
    const authorized = yield* authorizeScope(
      input,
      proposedOwnerId,
      DateTime.toDate(DateTime.makeUnsafe(firstNowMillis)),
    )
    const workspaceSeedId = yield* randomId()

    return yield* Effect.acquireUseRelease(
      options.vault.store(workspaceSeedId, input.archive).pipe(Effect.mapError(vaultFailure)),
      (stored) =>
        Effect.gen(function* () {
          const nowMillis = yield* options.clock.currentTimeMillis
          const now = DateTime.toDate(DateTime.makeUnsafe(nowMillis))
          const rechecked = yield* authorizeScope(input, proposedOwnerId, now)
          if (
            rechecked.authority.ownerId !== authorized.authority.ownerId ||
            !sameRepository(rechecked.sourceRepository, authorized.sourceRepository)
          )
            return yield* forbidden()
          const manifest = yield* Schema.decodeEffect(WorkspaceSeed)({
            id: workspaceSeedId,
            sourceRepository: rechecked.sourceRepository,
            ...stored,
          }).pipe(Effect.mapError(unavailable))
          const expiresAt = DateTime.toDate(DateTime.makeUnsafe(nowMillis + seedLifetimeMillis))
          yield* options.product
            .stageWorkspaceSeed({
              id: workspaceSeedId,
              ownerId: rechecked.authority.ownerId,
              userId: input.actor.userId,
              deviceId: input.actor.deviceId,
              clientId: input.actor.clientId,
              manifest,
              expiresAt,
              now,
            })
            .pipe(Effect.mapError(productFailure))
          return WorkspaceSeedStageReceipt.make({ workspaceSeedId })
        }),
      (stored, exit) =>
        Exit.isSuccess(exit) ? Effect.void : options.vault.remove(workspaceSeedId, stored).pipe(Effect.ignore),
    )
  })

  return { stage }
}
