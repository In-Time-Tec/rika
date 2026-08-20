import { expect, it } from "@effect/vitest"
import { Effect, Random, Redacted } from "effect"
import { Pool } from "pg"
import { makeBetterAuthIdentityRuntime } from "../src/better-auth-runtime"
import { identityMigrations } from "../src/migrations"
import { runMigration } from "../src/postgres"

const databaseUrl = Bun.env.RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL
const live = databaseUrl !== undefined
const baseUrl = "https://identity.example.test"

const request = (path: string, body?: unknown, cookie?: string) =>
  new Request(`${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      accept: "application/json",
      origin: baseUrl,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie === undefined ? {} : { cookie }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

it.effect.skipIf(!live)("uses the reviewed snake-case PostgreSQL schema for identity and organizations", () =>
  Effect.gen(function* () {
    const database = `rika_identity_${yield* Random.nextInt}`
    const admin = new Pool({ connectionString: databaseUrl })
    yield* Effect.promise(() => admin.query(`CREATE DATABASE "${database}"`))
    const parsed = new URL(databaseUrl!)
    parsed.pathname = `/${database}`
    const url = parsed.toString()
    const pool = new Pool({ connectionString: url })
    try {
      for (const migration of identityMigrations) {
        const sql = yield* Effect.promise(() => Bun.file(migration.url).text())
        yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })
      }
      const sent: Array<{ readonly to: string }> = []
      const runtime = makeBetterAuthIdentityRuntime({
        config: {
          production: true,
          port: 443,
          baseUrl,
          trustedOrigins: [baseUrl],
          authSecret: Redacted.make("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN"),
          databaseUrl: Redacted.make(url),
          databaseSsl: "disable",
          githubClientId: "github-client",
          githubClientSecret: Redacted.make("github-secret"),
          resendApiKey: Redacted.make("resend-secret"),
          emailFrom: "Rika <no-reply@example.test>",
          resource: `${baseUrl}/api/v1`,
        },
        pool,
        mail: { send: (message) => Effect.sync(() => void sent.push({ to: message.to })) },
      })
      const email = "postgres-runtime@example.test"
      const password = "correct-horse-battery-staple"
      const signedUp = yield* runtime.handle(
        request("/api/auth/sign-up/email", { name: "Postgres Runtime", email, password, callbackURL: "/" }),
      )
      expect(signedUp.status).toBe(200)
      expect(sent).toEqual([{ to: email }])
      yield* Effect.promise(() => pool.query(`UPDATE "user" SET email_verified = true WHERE email = $1`, [email]))

      const signedIn = yield* runtime.handle(request("/api/auth/sign-in/email", { email, password, callbackURL: "/" }))
      expect(signedIn.status).toBe(200)
      const cookie = signedIn.headers.get("set-cookie")?.split(";", 1)[0]
      expect(cookie).toBeDefined()
      const organization = yield* runtime.handle(
        request("/api/auth/organization/create", { name: "Postgres Runtime", slug: "postgres-runtime" }, cookie),
      )
      expect(organization.status).toBe(200)
      const organizations = yield* runtime.handle(request("/api/auth/organization/list", undefined, cookie))
      expect(organizations.status).toBe(200)
      expect(yield* Effect.promise(() => organizations.json())).toHaveLength(1)
    } finally {
      yield* Effect.promise(() => pool.end())
      yield* Effect.promise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
      yield* Effect.promise(() => admin.end())
    }
  }),
)
