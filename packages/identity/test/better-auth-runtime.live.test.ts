import { expect, it } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { serve } from "bun"
import { Clock, Config, Effect, FileSystem, Random, Redacted } from "effect"
import { fileURLToPath } from "node:url"
import { Pool } from "pg"
import { makeBetterAuthIdentityRuntime, type IdentityRuntime } from "../src/better-auth-runtime"
import { identityMigrations } from "../src/migrations"
import { runMigration } from "../src/postgres"

const databaseUrl = Effect.runSync(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")))
const live = databaseUrl.length > 0
const encoder = new TextEncoder()

const base64Url = (value: Uint8Array) => Buffer.from(value).toString("base64url")
const jsonSegment = (value: unknown) => base64Url(encoder.encode(JSON.stringify(value)))

const makeDpopKey = Effect.gen(function* () {
  const pair = (yield* Effect.tryPromise(() =>
    crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]),
  )) as CryptoKeyPair
  const exported = yield* Effect.tryPromise(() => crypto.subtle.exportKey("jwk", pair.publicKey))
  const publicJwk = { kty: "EC" as const, crv: "P-256" as const, x: exported.x!, y: exported.y! }
  return { privateKey: pair.privateKey, publicJwk }
})

const dpopProof = Effect.fn("IdentityLiveTest.dpopProof")(function* (input: {
  readonly method: string
  readonly url: string
  readonly privateKey: CryptoKey
  readonly publicJwk: { readonly kty: "EC"; readonly crv: "P-256"; readonly x: string; readonly y: string }
  readonly accessToken?: string
}) {
  const sequence = yield* Random.nextInt
  const accessDigest =
    input.accessToken === undefined
      ? undefined
      : yield* Effect.tryPromise(() => crypto.subtle.digest("SHA-256", encoder.encode(input.accessToken)))
  const payload = {
    jti: `identity-live-${sequence}`,
    htm: input.method,
    htu: input.url,
    iat: Math.floor((yield* Clock.currentTimeMillis) / 1_000),
    ...(accessDigest === undefined ? {} : { ath: base64Url(new Uint8Array(accessDigest)) }),
  }
  const unsigned = `${jsonSegment({ typ: "dpop+jwt", alg: "ES256", jwk: input.publicJwk })}.${jsonSegment(payload)}`
  const signature = yield* Effect.tryPromise(() =>
    crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, input.privateKey, encoder.encode(unsigned)),
  )
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`
})

const request = (baseUrl: string, path: string, body?: unknown, cookie?: string) =>
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

it.layer(BunServices.layer)((test) => {
  test.effect.skipIf(!live)("uses the reviewed PostgreSQL schema for identity and DPoP OAuth device flows", () =>
    Effect.gen(function* () {
      const database = `rika_identity_${yield* Random.nextInt}`
      const admin = new Pool({ connectionString: databaseUrl })
      yield* Effect.tryPromise(() => admin.query(`CREATE DATABASE "${database}"`))
      const parsed = new URL(databaseUrl)
      parsed.pathname = `/${database}`
      const url = parsed.toString()
      const pool = new Pool({ connectionString: url })
      let runtime: IdentityRuntime | undefined
      const effectContext = yield* Effect.context<never>()
      const server = serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (incoming) =>
          runtime === undefined
            ? Effect.runPromiseWith(effectContext)(Effect.succeed(new Response("Not ready", { status: 503 })))
            : Effect.runPromiseWith(effectContext)(runtime.handle(incoming)),
      })
      const port = server.port
      if (port === undefined) return yield* Effect.die(new Error("Bun did not bind the identity test server"))
      const baseUrl = `http://127.0.0.1:${port}`
      try {
        for (const migration of identityMigrations) {
          const fileSystem = yield* FileSystem.FileSystem
          const sql = yield* fileSystem.readFileString(fileURLToPath(migration.url))
          yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })
        }
        const sent: Array<{ readonly to: string }> = []
        runtime = makeBetterAuthIdentityRuntime({
          config: {
            production: false,
            port,
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
        expect(yield* runtime.protectedResourceMetadata).toMatchObject({
          resource: `${baseUrl}/api/v1`,
          authorization_servers: [`${baseUrl}/api/auth`],
          dpop_bound_access_tokens_required: true,
        })
        const email = "postgres-runtime@example.test"
        const password = "correct-horse-battery-staple"
        const signedUp = yield* runtime.handle(
          request(baseUrl, "/api/auth/sign-up/email", { name: "Postgres Runtime", email, password, callbackURL: "/" }),
        )
        expect(signedUp.status).toBe(200)
        expect(sent).toEqual([{ to: email }])
        yield* Effect.tryPromise(() => pool.query(`UPDATE "user" SET email_verified = true WHERE email = $1`, [email]))

        const signedIn = yield* runtime.handle(
          request(baseUrl, "/api/auth/sign-in/email", { email, password, callbackURL: "/" }),
        )
        expect(signedIn.status).toBe(200)
        const cookie = signedIn.headers.get("set-cookie")?.split(";", 1)[0]
        expect(cookie).toBeDefined()
        const organization = yield* runtime.handle(
          request(
            baseUrl,
            "/api/auth/organization/create",
            { name: "Postgres Runtime", slug: "postgres-runtime" },
            cookie,
          ),
        )
        expect(organization.status).toBe(200)
        const organizations = yield* runtime.handle(request(baseUrl, "/api/auth/organization/list", undefined, cookie))
        expect(organizations.status).toBe(200)
        expect(yield* Effect.tryPromise(() => organizations.json())).toHaveLength(1)

        const key = yield* makeDpopKey
        const registered = yield* runtime.handle(
          request(baseUrl, "/api/auth/oauth2/register", {
            client_name: "Identity live test",
            application_type: "native",
            token_endpoint_auth_method: "none",
            grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
            scope: "openid profile email offline_access account",
            software_id: "rika-cli",
            dpop_bound_access_tokens: true,
            resources: [`${baseUrl}/api/v1`],
          }),
        )
        expect(registered.status).toBe(201)
        const registration = (yield* Effect.tryPromise(() => registered.json())) as { readonly client_id: string }
        const deviceUrl = `${baseUrl}/api/auth/device/code`
        const device = yield* runtime.handle(
          new Request(deviceUrl, {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/x-www-form-urlencoded",
              dpop: yield* dpopProof({
                method: "POST",
                url: deviceUrl,
                privateKey: key.privateKey,
                publicJwk: key.publicJwk,
              }),
            },
            body: new URLSearchParams({
              client_id: registration.client_id,
              scope: "openid profile email offline_access account",
              resource: `${baseUrl}/api/v1`,
            }),
          }),
        )
        expect(device.status).toBe(200)
        const authorization = (yield* Effect.tryPromise(() => device.json())) as {
          readonly device_code: string
          readonly user_code: string
        }
        const claimed = yield* runtime.handle(
          request(baseUrl, `/api/auth/device?user_code=${authorization.user_code}`, undefined, cookie),
        )
        expect(claimed.status).toBe(200)
        const approved = yield* runtime.handle(
          request(baseUrl, "/api/auth/device/approve", { userCode: authorization.user_code }, cookie),
        )
        expect(approved.status).toBe(200)

        const tokenUrl = `${baseUrl}/api/auth/oauth2/token`
        const token = yield* runtime.handle(
          new Request(tokenUrl, {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/x-www-form-urlencoded",
              dpop: yield* dpopProof({
                method: "POST",
                url: tokenUrl,
                privateKey: key.privateKey,
                publicJwk: key.publicJwk,
              }),
            },
            body: new URLSearchParams({
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
              device_code: authorization.device_code,
              client_id: registration.client_id,
              resource: `${baseUrl}/api/v1`,
            }),
          }),
        )
        expect(token.status).toBe(200)
        const tokens = (yield* Effect.tryPromise(() => token.json())) as {
          readonly access_token: string
          readonly refresh_token: string
          readonly token_type: string
        }
        expect(tokens.token_type.toLowerCase()).toBe("dpop")
        expect(tokens.refresh_token.length).toBeGreaterThan(0)

        const contextUrl = `${baseUrl}/api/v1/me/context`
        const principal = yield* runtime.identify(
          new Request(contextUrl, {
            headers: {
              authorization: `DPoP ${tokens.access_token}`,
              dpop: yield* dpopProof({
                method: "GET",
                url: contextUrl,
                privateKey: key.privateKey,
                publicJwk: key.publicJwk,
                accessToken: tokens.access_token,
              }),
            },
          }),
        )
        expect(principal?.clientId).toBe(registration.client_id)
        expect(principal?.dpopJkt).toBeDefined()
        expect(principal?.userId).toBeDefined()
      } finally {
        server.stop(true)
        yield* Effect.tryPromise(() => pool.end())
        yield* Effect.tryPromise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
        yield* Effect.tryPromise(() => admin.end())
      }
    }),
  )
})
