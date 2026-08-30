import { identityMember, identityOrganization, identityUser } from "@rika/identity"
import { BetterAuthUserId, OrganizationId, type HostedOwner } from "@rika/product/hosted-model"
import { and, asc, eq, isNotNull, isNull, or } from "drizzle-orm"
import {
  rikaHostedOwnerCounters,
  rikaHostedOwners,
  rikaHostedProjectGrants,
  rikaHostedProjects,
} from "../../database/schema/product"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Effect, Schema } from "effect"
import { ProductRepositoryError, type ProductRepositoryService } from "./contract"

const databaseError = (cause: unknown) => ProductRepositoryError.make({ kind: "unavailable", message: String(cause) })
const query = <A extends object, E, R>(effect: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  effect.pipe(Effect.mapError(databaseError))

const ownerLookupCondition = (selection: HostedOwner, userId: string) =>
  selection._tag === "PersonalOwner"
    ? eq(rikaHostedOwners.userId, userId)
    : eq(rikaHostedOwners.organizationId, selection.organizationId)

export const projectOperations = Effect.gen(function* () {
  const db = yield* PgDrizzle.makeWithDefaults()
  const resolveOwner: ProductRepositoryService["resolveOwner"] = (input) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          let membershipId: string | undefined
          if (input.selection._tag === "PersonalOwner") {
            if (input.selection.userId !== input.userId)
              return yield* ProductRepositoryError.make({ kind: "forbidden", message: "Resource is unavailable" })
            const identity = yield* query(
              tx
                .select({ id: identityUser.id })
                .from(identityUser)
                .where(eq(identityUser.id, input.userId))
                .for("update")
                .limit(1),
            )
            if (identity[0] === undefined)
              return yield* ProductRepositoryError.make({ kind: "forbidden", message: "Resource is unavailable" })
          } else {
            const membership = yield* query(
              tx
                .select({ membershipId: identityMember.id })
                .from(identityOrganization)
                .innerJoin(
                  identityMember,
                  and(
                    eq(identityMember.organizationId, identityOrganization.id),
                    eq(identityMember.userId, input.userId),
                  ),
                )
                .where(eq(identityOrganization.id, input.selection.organizationId))
                .for("update", { of: identityOrganization })
                .limit(1),
            )
            if (membership[0] === undefined)
              return yield* ProductRepositoryError.make({ kind: "forbidden", message: "Resource is unavailable" })
            membershipId = membership[0].membershipId
          }
          const ownerCondition = ownerLookupCondition(input.selection, input.userId)
          const existing = yield* query(
            tx.select({ id: rikaHostedOwners.id }).from(rikaHostedOwners).where(ownerCondition).limit(1),
          )
          const ownerId = existing[0]?.id ?? input.proposedOwnerId
          if (existing[0] === undefined) {
            yield* query(
              tx
                .insert(rikaHostedOwners)
                .values({
                  id: ownerId,
                  kind: input.selection._tag === "PersonalOwner" ? "personal" : "organization",
                  userId: input.selection._tag === "PersonalOwner" ? input.userId : null,
                  organizationId: input.selection._tag === "OrganizationOwner" ? input.selection.organizationId : null,
                  createdAt: input.now,
                })
                .onConflictDoNothing()
                .returning({ id: rikaHostedOwners.id }),
            )
            yield* query(
              tx
                .insert(rikaHostedOwnerCounters)
                .values({ ownerId })
                .onConflictDoNothing()
                .returning({ ownerId: rikaHostedOwnerCounters.ownerId }),
            )
            const concurrent = yield* query(
              tx.select({ id: rikaHostedOwners.id }).from(rikaHostedOwners).where(ownerCondition).limit(1),
            )
            const resolvedId = concurrent[0]?.id
            if (resolvedId === undefined) return yield* databaseError("Owner was not persisted")
            return membershipId === undefined
              ? { ownerId: resolvedId, owner: input.selection, userId: input.userId }
              : { ownerId: resolvedId, owner: input.selection, userId: input.userId, membershipId }
          }
          return membershipId === undefined
            ? { ownerId, owner: input.selection, userId: input.userId }
            : { ownerId, owner: input.selection, userId: input.userId, membershipId }
        }),
      )
      .pipe(Effect.mapError((error) => (Schema.is(ProductRepositoryError)(error) ? error : databaseError(error))))

  const organizationIds: ProductRepositoryService["organizationIds"] = (userId) =>
    query(
      db
        .select({ id: identityMember.organizationId })
        .from(identityMember)
        .where(eq(identityMember.userId, userId))
        .orderBy(asc(identityMember.organizationId)),
    ).pipe(Effect.map((rows) => rows.map((row) => row.id)))

  const projects: ProductRepositoryService["projects"] = (input) =>
    query(
      db
        .select({
          id: rikaHostedProjects.id,
          ownerId: rikaHostedOwners.id,
          kind: rikaHostedOwners.kind,
          ownerUserId: rikaHostedOwners.userId,
          organizationId: rikaHostedOwners.organizationId,
          name: rikaHostedProjects.name,
          createdByUserId: rikaHostedProjects.createdByUserId,
          grantRole: rikaHostedProjectGrants.role,
        })
        .from(rikaHostedProjects)
        .innerJoin(rikaHostedOwners, eq(rikaHostedOwners.id, rikaHostedProjects.ownerId))
        .leftJoin(
          identityMember,
          and(
            eq(identityMember.organizationId, rikaHostedOwners.organizationId),
            eq(identityMember.userId, input.userId),
          ),
        )
        .leftJoin(
          rikaHostedProjectGrants,
          and(
            eq(rikaHostedProjectGrants.ownerId, rikaHostedProjects.ownerId),
            eq(rikaHostedProjectGrants.projectId, rikaHostedProjects.id),
            eq(rikaHostedProjectGrants.membershipId, identityMember.id),
          ),
        )
        .where(
          or(
            and(eq(rikaHostedOwners.kind, "personal"), eq(rikaHostedOwners.id, input.personalOwnerId)),
            and(
              eq(rikaHostedOwners.kind, "organization"),
              isNotNull(identityMember.id),
              or(eq(rikaHostedProjects.createdByUserId, input.userId), isNotNull(rikaHostedProjectGrants.role)),
            ),
          ),
        )
        .orderBy(asc(rikaHostedProjects.createdAt), asc(rikaHostedProjects.id)),
    ).pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) => {
          let owner: HostedOwner | undefined
          if (row.kind === "personal" && row.ownerUserId !== null)
            owner = { _tag: "PersonalOwner", userId: BetterAuthUserId.make(row.ownerUserId) }
          else if (row.kind === "organization" && row.organizationId !== null)
            owner = { _tag: "OrganizationOwner", organizationId: OrganizationId.make(row.organizationId) }
          const role =
            row.kind === "personal" || row.createdByUserId === input.userId ? ("owner" as const) : row.grantRole
          return owner === undefined || role === null
            ? Effect.fail(databaseError("Invalid project authority projection"))
            : Effect.succeed({ id: row.id, ownerId: row.ownerId, owner, name: row.name, role })
        }),
      ),
    )

  const projectAccess: ProductRepositoryService["projectAccess"] = (input) =>
    query(
      db
        .select({ createdByUserId: rikaHostedProjects.createdByUserId, role: rikaHostedProjectGrants.role })
        .from(rikaHostedProjects)
        .leftJoin(
          rikaHostedProjectGrants,
          and(
            eq(rikaHostedProjectGrants.ownerId, rikaHostedProjects.ownerId),
            eq(rikaHostedProjectGrants.projectId, rikaHostedProjects.id),
            input.authority.membershipId === undefined
              ? isNull(rikaHostedProjectGrants.membershipId)
              : eq(rikaHostedProjectGrants.membershipId, input.authority.membershipId),
          ),
        )
        .where(
          and(
            eq(rikaHostedProjects.id, input.projectId),
            eq(rikaHostedProjects.ownerId, input.authority.ownerId),
            or(eq(rikaHostedProjects.createdByUserId, input.authority.userId), isNotNull(rikaHostedProjectGrants.role)),
          ),
        )
        .limit(1),
    ).pipe(
      Effect.map((rows) => {
        const row = rows[0]
        if (row === undefined) return undefined
        if (row.createdByUserId === input.authority.userId) return { role: "owner" as const }
        return { role: row.role ?? "viewer" }
      }),
    )

  const createProject: ProductRepositoryService["createProject"] = (input) =>
    query(
      db
        .insert(rikaHostedProjects)
        .values({
          id: input.id,
          ownerId: input.authority.ownerId,
          name: input.name,
          createdByUserId: input.authority.userId,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning({ id: rikaHostedProjects.id, ownerId: rikaHostedProjects.ownerId, name: rikaHostedProjects.name }),
    ).pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.fail(databaseError("Project was not persisted"))
          : Effect.succeed({ ...rows[0], owner: input.authority.owner, role: "owner" }),
      ),
    )

  return { resolveOwner, organizationIds, projects, projectAccess, createProject }
})
