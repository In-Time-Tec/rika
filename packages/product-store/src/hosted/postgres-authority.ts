import type { ActorAttribution } from "@rika/product/hosted-model"
import { isAuthorized, type AuthorizationAction } from "@rika/product/hosted-authorization"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import { StoreError } from "@rika/product/hosted-store"

const failure = (message: string) => StoreError.make({ reason: "invalid-authority", message })
const databaseError = (cause: unknown) =>
  StoreError.make({ reason: "database", message: `Hosted PostgreSQL authority failed: ${String(cause)}` })
const query = <A extends object, E, R>(statement: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  statement.pipe(Effect.mapError(databaseError))

export const requireActiveClient = Effect.fn("PostgresAuthority.requireActiveClient")(function* (
  sql: SqlClient,
  input: { readonly ownerId: string; readonly actor: ActorAttribution },
  at?: string,
) {
  if (input.actor._tag === "OrganizationActor") {
    const memberships = yield* query(sql`SELECT 1 FROM "member"
      WHERE id = ${input.actor.membershipId}
        AND organization_id = ${input.actor.owner.organizationId}
        AND user_id = ${input.actor.userId}
      FOR KEY SHARE`)
    if (memberships[0] === undefined) return yield* failure("The organization membership is inactive or foreign")
  }
  const rows = yield* query(sql<{ readonly deviceId: string; readonly userId: string; readonly clientId: string }>`
    SELECT device.id AS "deviceId", client_record.user_id AS "userId", client_record.id AS "clientId"
    FROM rika_hosted_owners owner_record
    JOIN rika_hosted_client_authorities client_authority ON client_authority.owner_id = owner_record.id
    JOIN rika_hosted_clients client_record ON client_record.id = client_authority.client_id
      AND client_record.user_id = ${input.actor.userId}
    JOIN rika_hosted_devices device
      ON device.id = client_record.device_id AND device.user_id = client_record.user_id
    LEFT JOIN "member" membership ON owner_record.kind = 'organization'
      AND membership.organization_id = owner_record.organization_id
      AND membership.id = ${input.actor._tag === "OrganizationActor" ? input.actor.membershipId : null}
      AND membership.user_id = client_record.user_id
    WHERE owner_record.id = ${input.ownerId}
      AND client_record.id = ${input.actor.clientId}
      AND client_record.user_id = ${input.actor.userId}
      AND device.id = ${input.actor.deviceId}
      AND client_record.revoked_at IS NULL
      AND device.revoked_at IS NULL
      AND client_authority.revoked_at IS NULL
      AND client_record.expires_at > ${at === undefined ? sql`transaction_timestamp()` : sql`${at}::timestamptz`}
      AND client_authority.expires_at > ${at === undefined ? sql`transaction_timestamp()` : sql`${at}::timestamptz`}
      AND ((owner_record.kind = 'personal'
          AND ${input.actor._tag} = 'PersonalActor'
          AND owner_record.user_id = client_record.user_id
          AND owner_record.user_id = ${input.actor.owner._tag === "PersonalOwner" ? input.actor.owner.userId : null})
        OR (owner_record.kind = 'organization'
          AND ${input.actor._tag} = 'OrganizationActor'
          AND owner_record.organization_id = ${input.actor.owner._tag === "OrganizationOwner" ? input.actor.owner.organizationId : null}
          AND membership.id IS NOT NULL))
    FOR KEY SHARE OF owner_record, client_authority, client_record, device`)
  if (rows[0] === undefined) return yield* failure("The authenticated client authority is inactive or foreign")
  return rows[0]
})

export const requireThreadAccess = Effect.fn("PostgresAuthority.requireThreadAccess")(function* (
  sql: SqlClient,
  input: { readonly ownerId: string; readonly threadId: string; readonly actor: ActorAttribution },
  action: AuthorizationAction,
  at?: string,
) {
  yield* requireActiveClient(sql, input, at)
  const threads = yield* query(sql<{
    readonly createdByUserId: string
    readonly projectId: string | null
    readonly executorKind: "runner" | "orb"
    readonly inheritProjectGrants: boolean
  }>`SELECT created_by_user_id AS "createdByUserId", project_id AS "projectId",
      executor_kind AS "executorKind", inherit_project_grants AS "inheritProjectGrants"
    FROM rika_hosted_threads
    WHERE owner_id = ${input.ownerId} AND id = ${input.threadId}
    FOR KEY SHARE`)
  const thread = threads[0]
  if (thread === undefined) return yield* failure("Resource is unavailable")
  if (input.actor._tag === "PersonalActor" || thread.createdByUserId === input.actor.userId) return
  const direct = yield* query(sql<{ readonly role: "viewer" | "controller" | "operator" | "owner" }>`SELECT role
    FROM rika_hosted_thread_grants
    WHERE owner_id = ${input.ownerId}
      AND thread_id = ${input.threadId}
      AND membership_id = ${input.actor.membershipId}
    FOR KEY SHARE`)
  const inherited =
    thread.executorKind === "orb" && thread.inheritProjectGrants && thread.projectId !== null
      ? yield* query(sql<{ readonly role: "viewer" | "controller" | "operator" | "owner" }>`SELECT role
          FROM rika_hosted_project_grants
          WHERE owner_id = ${input.ownerId}
            AND project_id = ${thread.projectId}
            AND membership_id = ${input.actor.membershipId}
          FOR KEY SHARE`)
      : []
  const access = {
    memberId: input.actor.membershipId,
    executorKind: thread.executorKind,
    inheritProjectGrants: thread.inheritProjectGrants,
  }
  const directAccess = direct[0] === undefined ? access : { ...access, threadRole: direct[0].role }
  const authorizedAccess = inherited[0] === undefined ? directAccess : { ...directAccess, projectRole: inherited[0].role }
  if (!isAuthorized(authorizedAccess, action))
    return yield* failure("Resource is unavailable")
})
