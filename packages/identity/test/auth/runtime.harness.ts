import { expect, it } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { serve } from "bun"
import { Clock, Config, Context, Effect, FileSystem, Layer, Random, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { fileURLToPath } from "node:url"
import { Pool } from "pg"
import { identityUser } from "../../src"
import { IdentityRuntimeService, identityRuntimeLayer, type IdentityRuntime } from "../../src/auth/runtime"
import { identityMigrations } from "../../src/database/migrations"
import { runMigration } from "../../src/database/postgres"

const databaseUrl = Effect.runSync(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")))
const live = databaseUrl.length > 0
const encoder = new TextEncoder()

const base64Url = (value: Uint8Array) => Buffer.from(value).toString("base64url")
const JsonValue = Schema.Json
type JsonValue = Schema.Json
const jsonSegment = (value: JsonValue) => base64Url(encoder.encode(JSON.stringify(value)))

const CryptoKeyPairSchema = Schema.Struct({
  privateKey: Schema.instanceOf(CryptoKey),
  publicKey: Schema.instanceOf(CryptoKey),
})

const makeDpopKey = Effect.gen(function* () {
  const generated = yield* Effect.tryPromise(() =>
    crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]),
  )
  const pair = yield* Schema.decodeEffect(CryptoKeyPairSchema)(generated)
  const exported = yield* Effect.tryPromise(() => crypto.subtle.exportKey("jwk", pair.publicKey))
  const PublicJwk = Schema.Struct({
    kty: Schema.Literal("EC"),
    crv: Schema.Literal("P-256"),
    x: Schema.String,
    y: Schema.String,
  })
  const publicJwk = yield* Schema.decodeUnknownEffect(PublicJwk)(exported)
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
  let payload: JsonValue = {
    jti: `identity-live-${sequence}`,
    htm: input.method,
    htu: input.url,
    iat: Math.floor((yield* TestClock.withLive(Clock.currentTimeMillis)) / 1_000),
  }
  if (accessDigest !== undefined) payload = { ...payload, ath: base64Url(new Uint8Array(accessDigest)) }
  const unsigned = `${jsonSegment({ typ: "dpop+jwt", alg: "ES256", jwk: input.publicJwk })}.${jsonSegment(payload)}`
  const signature = yield* Effect.tryPromise(() =>
    crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, input.privateKey, encoder.encode(unsigned)),
  )
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`
})

const request = (baseUrl: string, path: string, body?: JsonValue, cookie?: string) => {
  const headers = new Headers({ accept: "application/json", origin: baseUrl })
  if (body !== undefined) headers.set("content-type", "application/json")
  if (cookie !== undefined) headers.set("cookie", cookie)
  const init: RequestInit = {
    method: body === undefined ? "GET" : "POST",
    headers,
  }
  if (body !== undefined) init.body = JSON.stringify(body)
  return new Request(`${baseUrl}${path}`, init)
}

const Registration = Schema.Struct({ client_id: Schema.String })
const Authorization = Schema.Struct({ device_code: Schema.String, user_code: Schema.String })
const Tokens = Schema.Struct({ access_token: Schema.String, refresh_token: Schema.String, token_type: Schema.String })
const decodeResponse = <S extends Schema.Top>(schema: S, response: Response) =>
  Effect.tryPromise(() => response.json()).pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)))

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
      const databaseClient = drizzle({ client: pool })
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
        const runtimeContext = yield* Layer.build(
          identityRuntimeLayer({
            config: {
              production: false,
              port,
              baseUrl,
              trustedOrigins: [baseUrl],
              authSecret: Redacted.make("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN"),
              databaseUrl: Redacted.make(url),
              databaseSsl: "disable",
              github: { clientId: "github-client", clientSecret: Redacted.make("github-secret") },
              mail: {
                resendApiKey: Redacted.make("resend-secret"),
                emailFrom: "Rika <no-reply@example.test>",
              },
              resource: `${baseUrl}/api/v1`,
            },
            pool,
            mail: { send: (message) => Effect.sync(() => void sent.push({ to: message.to })) },
          }),
        )
        runtime = Context.get(runtimeContext, IdentityRuntimeService)
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
        yield* Effect.tryPromise(() =>
          databaseClient.update(identityUser).set({ emailVerified: true }).where(eq(identityUser.email, email)),
        )

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
        const registration = yield* decodeResponse(Registration, registered)
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
        const authorization = yield* decodeResponse(Authorization, device)
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
        const tokens = yield* decodeResponse(Tokens, token)
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
