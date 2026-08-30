import { rikaHostedOwners, rikaHostedWorkspaceSeeds } from "../../database/schema/product"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Effect } from "effect"
import { ProductRepositoryError, type ProductRepositoryService } from "./contract"

const databaseError = (cause: unknown) => ProductRepositoryError.make({ kind: "unavailable", message: String(cause) })
const query = <A extends object, E, R>(effect: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  effect.pipe(Effect.mapError(databaseError))

export const workspaceOperations = Effect.gen(function* () {
  const db = yield* PgDrizzle.makeWithDefaults()
  const stageWorkspaceSeed: ProductRepositoryService["stageWorkspaceSeed"] = (input) =>
    query(
      db
        .insert(rikaHostedWorkspaceSeeds)
        .values({
          id: input.id,
          createdByUserId: input.userId,
          createdByDeviceId: input.deviceId,
          createdByClientId: input.clientId,
          manifest: input.manifest,
          expiresAt: input.expiresAt,
          createdAt: input.now,
        })
        .returning({ id: rikaHostedWorkspaceSeeds.id }),
    ).pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined ? Effect.fail(databaseError("Workspace seed was not staged")) : Effect.void,
      ),
    )

  return {
    stageWorkspaceSeed,
    ready: query(db.select({ id: rikaHostedOwners.id }).from(rikaHostedOwners).limit(1)).pipe(Effect.asVoid),
  }
})
