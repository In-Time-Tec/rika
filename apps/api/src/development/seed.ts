import { identityMember, identityOrganization, identityUser, type IdentityRuntime } from "@rika/identity"
import { BetterAuthUserId, OrganizationId } from "@rika/product/hosted-model"
import { rikaHostedOwners } from "@rika/product-store/database-schema"
import { and, eq, or, sql } from "drizzle-orm"
import type * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Effect, Exit, Redacted, Schema } from "effect"
import type { Pool, PoolClient } from "pg"
import type { HostedProductService } from "../hosted/product"
import type { HostedProviderCredentialsService } from "../hosted/environment/provider-credentials"

export const developmentAccount = {
  name: "Rika Developer",
  email: "rika@local.test",
  password: "rika-development-2026",
  organizationName: "Rika Development",
  organizationSlug: "rika-development",
} as const

export class DevelopmentSeedError extends Schema.TaggedError<DevelopmentSeedError>()("DevelopmentSeedError", {
  message: Schema.String,
}) {}

const failure = (message: string) => DevelopmentSeedError.make({ message })

const query = <A extends object, E, R>(effect: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  effect.pipe(Effect.mapError(() => failure("Development account database operation failed")))

type IdentityRequestBody = Readonly<Record<string, string>>

const request = (
  identity: IdentityRuntime,
  baseUrl: string,
  path: string,
  body: IdentityRequestBody,
  cookie?: string,
) => {
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
    origin: baseUrl,
  })
  if (cookie !== undefined) headers.set("cookie", cookie)
  return identity.handle(
    new Request(new URL(path, baseUrl).toString(), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  )
}

const requireSuccess = (response: Response, operation: string) =>
  response.ok ? Effect.void : Effect.fail(failure(`${operation} failed with status ${response.status}`))

interface DevelopmentSeedInput {
  readonly baseUrl: string
  readonly database: PgDrizzle.EffectPgDatabase
  readonly identity: IdentityRuntime
  readonly pool: Pool
  readonly product: Pick<HostedProductService, "projects">
  readonly credentials: HostedProviderCredentialsService
  readonly openRouterApiKey: Redacted.Redacted<string>
}

const lockName = "rika-development-seed"

const acquireSeedLock = (pool: Pool) =>
  Effect.gen(function* () {
    const client = yield* Effect.tryPromise({
      try: () => pool.connect(),
      catch: () => failure("Development seed database connection failed"),
    })
    return yield* Effect.tryPromise({
      try: () => client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockName]),
      catch: () => failure("Development seed lock could not be acquired"),
    }).pipe(
      Effect.as(client),
      Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Effect.sync(() => client.release()))),
    )
  })

const releaseSeedLock = (client: PoolClient) =>
  Effect.tryPromise(() => client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockName])).pipe(
    Effect.ignore,
    Effect.ensuring(Effect.sync(() => client.release())),
  )

const seedUnlocked = Effect.fn("DevelopmentSeed.seedUnlocked")(function* (input: DevelopmentSeedInput) {
  let users = yield* query(
    input.database
      .select({ id: identityUser.id, emailVerified: identityUser.emailVerified })
      .from(identityUser)
      .where(eq(identityUser.email, developmentAccount.email))
      .limit(1),
  )
  if (users[0] === undefined) {
    const response = yield* request(input.identity, input.baseUrl, "/api/auth/sign-up/email", {
      name: developmentAccount.name,
      email: developmentAccount.email,
      password: developmentAccount.password,
      callbackURL: "/",
    })
    yield* requireSuccess(response, "Development account creation")
    users = yield* query(
      input.database
        .select({ id: identityUser.id, emailVerified: identityUser.emailVerified })
        .from(identityUser)
        .where(eq(identityUser.email, developmentAccount.email))
        .limit(1),
    )
  }
  const user = users[0]
  if (user === undefined) return yield* failure("Development account was not persisted")
  if (!user.emailVerified)
    yield* query(
      input.database
        .update(identityUser)
        .set({ emailVerified: true, updatedAt: sql`clock_timestamp()` })
        .where(and(eq(identityUser.id, user.id), eq(identityUser.email, developmentAccount.email)))
        .returning({ id: identityUser.id }),
    )

  const signedIn = yield* request(input.identity, input.baseUrl, "/api/auth/sign-in/email", {
    email: developmentAccount.email,
    password: developmentAccount.password,
    callbackURL: "/",
  })
  yield* requireSuccess(signedIn, "Development account sign-in")
  const cookie = signedIn.headers.get("set-cookie")?.split(";", 1)[0]
  if (cookie === undefined) return yield* failure("Development account sign-in did not issue a session")

  let organizations = yield* query(
    input.database
      .select({ id: identityOrganization.id })
      .from(identityOrganization)
      .where(eq(identityOrganization.slug, developmentAccount.organizationSlug))
      .limit(1),
  )
  if (organizations[0] === undefined) {
    const response = yield* request(
      input.identity,
      input.baseUrl,
      "/api/auth/organization/create",
      { name: developmentAccount.organizationName, slug: developmentAccount.organizationSlug },
      cookie,
    )
    yield* requireSuccess(response, "Development organization creation")
    organizations = yield* query(
      input.database
        .select({ id: identityOrganization.id })
        .from(identityOrganization)
        .where(eq(identityOrganization.slug, developmentAccount.organizationSlug))
        .limit(1),
    )
  }
  const organization = organizations[0]
  if (organization === undefined) return yield* failure("Development organization was not persisted")
  const memberships = yield* query(
    input.database
      .select({ role: identityMember.role })
      .from(identityMember)
      .where(and(eq(identityMember.organizationId, organization.id), eq(identityMember.userId, user.id)))
      .limit(1),
  )
  if (memberships[0]?.role !== "owner" && memberships[0]?.role !== "admin")
    return yield* failure("Development account does not own the seeded organization")

  const principal = { userId: user.id, deviceId: "rika-development-device", clientId: "rika-development-client" }
  yield* input.product.projects(principal)
  const owners = [
    { id: user.id, owner: { _tag: "PersonalOwner" as const, userId: BetterAuthUserId.make(user.id) } },
    {
      id: organization.id,
      owner: { _tag: "OrganizationOwner" as const, organizationId: OrganizationId.make(organization.id) },
    },
  ]
  const ownerRows = yield* query(
    input.database
      .select({
        id: rikaHostedOwners.id,
        userId: rikaHostedOwners.userId,
        organizationId: rikaHostedOwners.organizationId,
      })
      .from(rikaHostedOwners)
      .where(or(eq(rikaHostedOwners.userId, user.id), eq(rikaHostedOwners.organizationId, organization.id))),
  )
  for (const expected of owners) {
    const ownerId = ownerRows.find((row) => row.userId === expected.id || row.organizationId === expected.id)?.id
    if (ownerId === undefined) return yield* failure("Development owner was not materialized")
    const put = {
      principal,
      owner: expected.owner,
      provider: "openrouter" as const,
      apiKey: input.openRouterApiKey,
    }
    yield* input.credentials.put(put).pipe(
      Effect.asVoid,
      Effect.mapError(() => failure("Development provider credential seeding failed")),
    )
  }
})

export const seedDevelopment = Effect.fn("DevelopmentSeed.seed")(function* (input: DevelopmentSeedInput) {
  yield* Effect.acquireUseRelease(acquireSeedLock(input.pool), () => seedUnlocked(input), releaseSeedLock)
})
