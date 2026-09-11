import { RepositoryCheckout, WorkspaceSeed } from "@rika/product/executor-assignment"
import { and, eq } from "drizzle-orm"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import type * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Effect, Schema } from "effect"
import { rikaHostedWorkspaceSeeds } from "../../database/schema/product"
import { ProductRepositoryError, type ProductRepositoryService } from "./contract"

type CreateConnectionInput = Parameters<ProductRepositoryService["createConnection"]>[0]

const every = (...conditions: ReadonlyArray<boolean>) => conditions.every(Boolean)
const databaseError = () =>
  ProductRepositoryError.make({ kind: "unavailable", message: "Workspace seed is unavailable" })
const query = <A extends object>(statement: Effect.Effect<ReadonlyArray<A>, EffectDrizzleQueryError>) =>
  statement.pipe(Effect.mapError(databaseError))

export const loadWorkspaceSeed = Effect.fn("ProductRepository.loadWorkspaceSeed")(function* (options: {
  readonly tx: PgDrizzle.EffectPgDatabase
  readonly input: CreateConnectionInput
}) {
  const { input, tx } = options
  if (input.workspaceSeedId === undefined) return null
  if (input.executorKind !== "orb")
    return yield* ProductRepositoryError.make({
      kind: "conflict",
      message: "Workspace seed requires Orb execution",
    })
  const staged = (yield* query(
    tx
      .select({
        ownerId: rikaHostedWorkspaceSeeds.ownerId,
        userId: rikaHostedWorkspaceSeeds.createdByUserId,
        deviceId: rikaHostedWorkspaceSeeds.createdByDeviceId,
        clientId: rikaHostedWorkspaceSeeds.createdByClientId,
        manifest: rikaHostedWorkspaceSeeds.manifest,
        claimedAssignmentId: rikaHostedWorkspaceSeeds.claimedAssignmentId,
        expiresAt: rikaHostedWorkspaceSeeds.expiresAt,
      })
      .from(rikaHostedWorkspaceSeeds)
      .where(eq(rikaHostedWorkspaceSeeds.id, input.workspaceSeedId))
      .for("update")
      .limit(1),
  ))[0]
  if (staged === undefined || staged.expiresAt <= input.now)
    return yield* ProductRepositoryError.make({ kind: "not-found", message: "Workspace seed is unavailable" })
  if (
    !every(
      staged.ownerId === input.authority.ownerId,
      staged.userId === input.authority.userId,
      staged.deviceId === input.requestingDeviceId,
      staged.clientId === input.requestingClientId,
    )
  )
    return yield* ProductRepositoryError.make({ kind: "forbidden", message: "Workspace seed is unavailable" })
  if (every(staged.claimedAssignmentId !== null, staged.claimedAssignmentId !== input.assignmentId))
    return yield* ProductRepositoryError.make({
      kind: "conflict",
      message: "Workspace seed was already claimed",
    })
  const seed = yield* Schema.decodeUnknownEffect(WorkspaceSeed)(staged.manifest).pipe(Effect.mapError(databaseError))
  if (input.checkout !== null) {
    const checkout = yield* Schema.decodeUnknownEffect(RepositoryCheckout)(input.checkout).pipe(
      Effect.mapError(databaseError),
    )
    if (
      !every(
        seed.sourceRepository !== null,
        seed.sourceRepository !== null && seed.sourceRepository.owner.toLowerCase() === checkout.owner.toLowerCase(),
        seed.sourceRepository !== null && seed.sourceRepository.name.toLowerCase() === checkout.name.toLowerCase(),
      )
    )
      return yield* ProductRepositoryError.make({
        kind: "conflict",
        message: "Local Workspace repository does not match the selected Project repository",
      })
  }
  return seed
})

export const claimWorkspaceSeed = Effect.fn("ProductRepository.claimWorkspaceSeed")(function* (options: {
  readonly tx: PgDrizzle.EffectPgDatabase
  readonly input: CreateConnectionInput
}) {
  const { input, tx } = options
  if (input.workspaceSeedId === undefined) return
  const claimed = yield* query(
    tx
      .update(rikaHostedWorkspaceSeeds)
      .set({ claimedAssignmentId: input.assignmentId })
      .where(
        and(
          eq(rikaHostedWorkspaceSeeds.id, input.workspaceSeedId),
          eq(rikaHostedWorkspaceSeeds.ownerId, input.authority.ownerId),
          eq(rikaHostedWorkspaceSeeds.createdByUserId, input.authority.userId),
          eq(rikaHostedWorkspaceSeeds.createdByDeviceId, input.requestingDeviceId),
          eq(rikaHostedWorkspaceSeeds.createdByClientId, input.requestingClientId),
        ),
      )
      .returning({ id: rikaHostedWorkspaceSeeds.id }),
  )
  if (claimed[0] === undefined)
    return yield* ProductRepositoryError.make({ kind: "forbidden", message: "Workspace seed is unavailable" })
})
