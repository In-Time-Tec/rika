import type { ActorAttribution } from "@rika/product/hosted-model"
import { isAuthorized, type AuthorizationAction } from "@rika/product/hosted-authorization"
import { StoreError } from "@rika/product/hosted-store"
import { and, eq, gt, isNotNull, isNull, sql } from "drizzle-orm"
import type * as PgDrizzle from "drizzle-orm/effect-postgres"
import { pgTable, text } from "drizzle-orm/pg-core"
import { Effect } from "effect"
import {
  rikaHostedClientAuthorities,
  rikaHostedClients,
  rikaHostedDevices,
  rikaHostedOwners,
  rikaHostedProjectGrants,
  rikaHostedThreadGrants,
  rikaHostedThreads,
} from "../database/schema/product"

const identityMembers = pgTable("member", {
  id: text().primaryKey(),
  organizationId: text("organization_id").notNull(),
  userId: text("user_id").notNull(),
})

export type AuthorityExecutor = Pick<PgDrizzle.EffectPgDatabase, "select">

const failure = (message: string) => StoreError.make({ reason: "invalid-authority", message })
const databaseError = (cause: unknown) =>
  StoreError.make({ reason: "database", message: `Hosted PostgreSQL authority failed: ${String(cause)}` })
const query = <A extends object, E, R>(statement: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  statement.pipe(Effect.mapError(databaseError))

export const requireActiveClient = Effect.fn("Authority.requireActiveClient")(function* (
  executor: AuthorityExecutor,
  input: { readonly ownerId: string; readonly actor: ActorAttribution },
  at?: string,
) {
  if (input.actor._tag === "OrganizationActor") {
    const memberships = yield* query(
      executor
        .select({ id: identityMembers.id })
        .from(identityMembers)
        .where(
          and(
            eq(identityMembers.id, input.actor.membershipId),
            eq(identityMembers.organizationId, input.actor.owner.organizationId),
            eq(identityMembers.userId, input.actor.userId),
          ),
        )
        .for("key share"),
    )
    if (memberships[0] === undefined) return yield* failure("The organization membership is inactive or foreign")
  }

  const expiresAfter = at === undefined ? sql<Date>`transaction_timestamp()` : sql<Date>`${at}::timestamptz`
  const ownerPredicate =
    input.actor._tag === "PersonalActor"
      ? and(
          eq(rikaHostedOwners.kind, "personal"),
          eq(rikaHostedOwners.userId, rikaHostedClients.userId),
          eq(rikaHostedOwners.userId, input.actor.owner.userId),
        )
      : and(
          eq(rikaHostedOwners.kind, "organization"),
          eq(rikaHostedOwners.organizationId, input.actor.owner.organizationId),
          isNotNull(identityMembers.id),
        )
  const membershipPredicate =
    input.actor._tag === "OrganizationActor"
      ? eq(identityMembers.id, input.actor.membershipId)
      : isNull(identityMembers.id)
  const rows = yield* query(
    executor
      .select({
        deviceId: rikaHostedDevices.id,
        userId: rikaHostedClients.userId,
        clientId: rikaHostedClients.id,
      })
      .from(rikaHostedOwners)
      .innerJoin(rikaHostedClientAuthorities, eq(rikaHostedClientAuthorities.ownerId, rikaHostedOwners.id))
      .innerJoin(
        rikaHostedClients,
        and(
          eq(rikaHostedClients.id, rikaHostedClientAuthorities.clientId),
          eq(rikaHostedClients.userId, input.actor.userId),
        ),
      )
      .innerJoin(
        rikaHostedDevices,
        and(
          eq(rikaHostedDevices.id, rikaHostedClients.deviceId),
          eq(rikaHostedDevices.userId, rikaHostedClients.userId),
        ),
      )
      .leftJoin(
        identityMembers,
        and(
          eq(rikaHostedOwners.kind, "organization"),
          eq(identityMembers.organizationId, rikaHostedOwners.organizationId),
          membershipPredicate,
          eq(identityMembers.userId, rikaHostedClients.userId),
        ),
      )
      .where(
        and(
          eq(rikaHostedOwners.id, input.ownerId),
          eq(rikaHostedClients.id, input.actor.clientId),
          eq(rikaHostedClients.userId, input.actor.userId),
          eq(rikaHostedDevices.id, input.actor.deviceId),
          isNull(rikaHostedClients.revokedAt),
          isNull(rikaHostedDevices.revokedAt),
          isNull(rikaHostedClientAuthorities.revokedAt),
          gt(rikaHostedClients.expiresAt, expiresAfter),
          gt(rikaHostedClientAuthorities.expiresAt, expiresAfter),
          ownerPredicate,
        ),
      )
      .for("key share", {
        of: [rikaHostedOwners, rikaHostedClientAuthorities, rikaHostedClients, rikaHostedDevices],
      }),
  )
  if (rows[0] === undefined) return yield* failure("The authenticated client authority is inactive or foreign")
  return rows[0]
})

export const requireThreadAccess = Effect.fn("Authority.requireThreadAccess")(function* (
  executor: AuthorityExecutor,
  input: { readonly ownerId: string; readonly threadId: string; readonly actor: ActorAttribution },
  action: AuthorizationAction,
  at?: string,
) {
  yield* requireActiveClient(executor, input, at)
  const threads = yield* query(
    executor
      .select({
        createdByUserId: rikaHostedThreads.createdByUserId,
        projectId: rikaHostedThreads.projectId,
        executorKind: rikaHostedThreads.executorKind,
        inheritProjectGrants: rikaHostedThreads.inheritProjectGrants,
      })
      .from(rikaHostedThreads)
      .where(and(eq(rikaHostedThreads.ownerId, input.ownerId), eq(rikaHostedThreads.id, input.threadId)))
      .for("key share", { of: rikaHostedThreads }),
  )
  const thread = threads[0]
  if (thread === undefined) return yield* failure("Resource is unavailable")
  if (input.actor._tag === "PersonalActor" || thread.createdByUserId === input.actor.userId) return
  const direct = yield* query(
    executor
      .select({ role: rikaHostedThreadGrants.role })
      .from(rikaHostedThreadGrants)
      .where(
        and(
          eq(rikaHostedThreadGrants.ownerId, input.ownerId),
          eq(rikaHostedThreadGrants.threadId, input.threadId),
          eq(rikaHostedThreadGrants.membershipId, input.actor.membershipId),
        ),
      )
      .for("key share", { of: rikaHostedThreadGrants }),
  )
  const inherited =
    thread.executorKind === "orb" && thread.inheritProjectGrants && thread.projectId !== null
      ? yield* query(
          executor
            .select({ role: rikaHostedProjectGrants.role })
            .from(rikaHostedProjectGrants)
            .where(
              and(
                eq(rikaHostedProjectGrants.ownerId, input.ownerId),
                eq(rikaHostedProjectGrants.projectId, thread.projectId),
                eq(rikaHostedProjectGrants.membershipId, input.actor.membershipId),
              ),
            )
            .for("key share", { of: rikaHostedProjectGrants }),
        )
      : []
  const access = {
    memberId: input.actor.membershipId,
    executorKind: thread.executorKind,
    inheritProjectGrants: thread.inheritProjectGrants,
  }
  const directAccess = direct[0] === undefined ? access : { ...access, threadRole: direct[0].role }
  const authorizedAccess =
    inherited[0] === undefined ? directAccess : { ...directAccess, projectRole: inherited[0].role }
  if (!isAuthorized(authorizedAccess, action)) return yield* failure("Resource is unavailable")
})
