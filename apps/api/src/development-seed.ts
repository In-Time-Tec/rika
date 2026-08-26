import type { IdentityRuntime } from "@rika/identity"
import { BetterAuthUserId, OrganizationId } from "@rika/product/hosted-model"
import { Effect, Exit, Redacted, Schema } from "effect"
import type { Pool, PoolClient } from "pg"
import type { HostedProductService } from "./hosted-product"
import type { HostedProviderCredentialsService } from "./hosted-provider-credentials"

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

const query = <A>(pool: Pool, text: string, values: ReadonlyArray<unknown> = []) =>
  Effect.tryPromise({
    try: () => pool.query<A & Record<string, unknown>>(text, [...values]),
    catch: () => failure("Development account database operation failed"),
  }).pipe(Effect.map((result) => result.rows))

const request = (identity: IdentityRuntime, baseUrl: string, path: string, body: object, cookie?: string) =>
  identity.handle(
    new Request(new URL(path, baseUrl).toString(), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        origin: baseUrl,
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: JSON.stringify(body),
    }),
  )

const requireSuccess = (response: Response, operation: string) =>
  response.ok ? Effect.void : Effect.fail(failure(`${operation} failed with status ${response.status}`))

interface DevelopmentSeedInput {
  readonly baseUrl: string
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
  let users = yield* query<{ readonly id: string; readonly email_verified: boolean }>(
    input.pool,
    `SELECT id, email_verified FROM "user" WHERE email = $1`,
    [developmentAccount.email],
  )
  if (users[0] === undefined) {
    const response = yield* request(input.identity, input.baseUrl, "/api/auth/sign-up/email", {
      name: developmentAccount.name,
      email: developmentAccount.email,
      password: developmentAccount.password,
      callbackURL: "/",
    })
    yield* requireSuccess(response, "Development account creation")
    users = yield* query<{ readonly id: string; readonly email_verified: boolean }>(
      input.pool,
      `SELECT id, email_verified FROM "user" WHERE email = $1`,
      [developmentAccount.email],
    )
  }
  const user = users[0]
  if (user === undefined) return yield* failure("Development account was not persisted")
  if (!user.email_verified)
    yield* query(
      input.pool,
      `UPDATE "user" SET email_verified = true, updated_at = now() WHERE id = $1 AND email = $2`,
      [user.id, developmentAccount.email],
    )

  const signedIn = yield* request(input.identity, input.baseUrl, "/api/auth/sign-in/email", {
    email: developmentAccount.email,
    password: developmentAccount.password,
    callbackURL: "/",
  })
  yield* requireSuccess(signedIn, "Development account sign-in")
  const cookie = signedIn.headers.get("set-cookie")?.split(";", 1)[0]
  if (cookie === undefined) return yield* failure("Development account sign-in did not issue a session")

  let organizations = yield* query<{ readonly id: string }>(
    input.pool,
    `SELECT id FROM "organization" WHERE slug = $1`,
    [developmentAccount.organizationSlug],
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
    organizations = yield* query<{ readonly id: string }>(input.pool, `SELECT id FROM "organization" WHERE slug = $1`, [
      developmentAccount.organizationSlug,
    ])
  }
  const organization = organizations[0]
  if (organization === undefined) return yield* failure("Development organization was not persisted")
  const memberships = yield* query<{ readonly role: string }>(
    input.pool,
    `SELECT role FROM "member" WHERE organization_id = $1 AND user_id = $2`,
    [organization.id, user.id],
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
  const ownerRows = yield* query<{
    readonly id: string
    readonly user_id: string | null
    readonly organization_id: string | null
  }>(
    input.pool,
    `SELECT id, user_id, organization_id FROM rika_hosted_owners WHERE user_id = $1 OR organization_id = $2`,
    [user.id, organization.id],
  )
  for (const expected of owners) {
    const ownerId = ownerRows.find((row) => row.user_id === expected.id || row.organization_id === expected.id)?.id
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
