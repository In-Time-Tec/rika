/* oxlint-disable effecttsgo/async-function -- this live fixture drives the foreign Bun and Fetch boundaries. */
/* oxlint-disable anti-slop/no-unknown-parameters -- Better Auth responses are decoded at the assertions below. */
import { Clock, Config, Context, Effect, Exit, Layer, Random, Redacted, Schema } from "effect"
import { it } from "@effect/vitest"
import { expect } from "vitest"
import { TestClock } from "effect/testing"
import { serve } from "bun"
import { drizzle } from "drizzle-orm/node-postgres"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { eq } from "drizzle-orm"
import * as PgClient from "@effect/sql-pg/PgClient"
import { fileURLToPath } from "node:url"
import { Pool } from "pg"
import type { IdentityRuntime } from "@rika/identity"
import {
  identityMigrations,
  identityRuntimeLayer,
  IdentityRuntimeService,
  identityUser,
  makePostgresCliDeviceDirectory,
  runMigration,
} from "@rika/identity"
import type { HostedClientAuthorityService } from "@rika/product/hosted-client-authority"
import type { ProductRepositoryService } from "@rika/product-store/product-repository"
import { makeRepositoryProductAuthority } from "../src/hosted/product-authority"
import { decodeWorkspaceBinding, threadPartition } from "../src/hosted/partition"
import { originalRequestForAuthentication } from "../src/hosted/server"
import {
  RIKA_ORIGINAL_AUTHORIZATION,
  RIKA_ORIGINAL_REQUEST_METHOD,
  RIKA_ORIGINAL_REQUEST_URL,
} from "../src/hosted/raw-rivet-gateway"

const databaseUrl = Effect.runSync(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")))
const encoder = new TextEncoder()
const base64Url = (value: Uint8Array) => Buffer.from(value).toString("base64url")
type JsonValue = Schema.Json
const jsonSegment = (value: JsonValue) => base64Url(encoder.encode(JSON.stringify(value)))

type PublicJwk = { readonly kty: "EC"; readonly crv: "P-256"; readonly x: string; readonly y: string }
const PublicJwk = Schema.Struct({
  kty: Schema.Literal("EC"),
  crv: Schema.Literal("P-256"),
  x: Schema.String,
  y: Schema.String,
})
const Registration = Schema.Struct({ client_id: Schema.String })
const Authorization = Schema.Struct({ device_code: Schema.String, user_code: Schema.String })
const Tokens = Schema.Struct({ access_token: Schema.String })
const decodeJson = <S extends Schema.Top>(schema: S, response: Response) =>
  Effect.tryPromise(() => response.json()).pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)))

const makeDpopKey = Effect.gen(function* () {
  const generated = yield* Effect.tryPromise(() =>
    crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]),
  )
  const privateKey = generated.privateKey
  const exported = yield* Effect.tryPromise(() => crypto.subtle.exportKey("jwk", generated.publicKey))
  const publicJwk = yield* Schema.decodeUnknownEffect(PublicJwk)(exported)
  return { privateKey, publicJwk }
})

const dpopProof = Effect.fn("ApiV2LiveDpop.proof")(function* (input: {
  readonly method: string
  readonly url: string
  readonly privateKey: CryptoKey
  readonly publicJwk: PublicJwk
  readonly accessToken?: string
}) {
  const sequence = yield* Random.nextInt
  const accessDigest =
    input.accessToken === undefined
      ? undefined
      : yield* Effect.tryPromise(() => crypto.subtle.digest("SHA-256", encoder.encode(input.accessToken)))
  const basePayload = {
    jti: `api-v2-live-${sequence}`,
    htm: input.method,
    htu: input.url,
    iat: Math.floor((yield* TestClock.withLive(Clock.currentTimeMillis)) / 1_000),
  }
  const payload =
    accessDigest === undefined ? basePayload : { ...basePayload, ath: base64Url(new Uint8Array(accessDigest)) }
  const unsigned = `${jsonSegment({ typ: "dpop+jwt", alg: "ES256", jwk: input.publicJwk })}.${jsonSegment(payload)}`
  const signature = yield* Effect.tryPromise(() =>
    crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, input.privateKey, encoder.encode(unsigned)),
  )
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`
})

const jsonRequest = (url: string, body: JsonValue, cookie?: string) => {
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
    origin: new URL(url).origin,
  })
  if (cookie !== undefined) headers.set("cookie", cookie)
  return new Request(url, { method: "POST", headers, body: JSON.stringify(body) })
}

const authorityProjection = (userId: string) => ({
  ownerId: "owner",
  kind: "personal",
  userId,
  organizationId: null,
  membershipId: null,
  createdByUserId: userId,
  executorKind: "runner" as const,
  inheritProjectGrants: false,
  threadRole: null,
  projectRole: null,
})

const unused = () => Effect.die("unused live authority seam")

it.effect.skipIf(databaseUrl === "")("authenticates API-v2 through repository-backed identity, device, and DPoP", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = `rika_api_v2_authority_${Math.abs(yield* Random.nextInt)}`
      const admin = new Pool({ connectionString: databaseUrl })
      yield* Effect.tryPromise(() => admin.query(`CREATE DATABASE "${database}"`))
      const parsed = new URL(databaseUrl)
      parsed.pathname = `/${database}`
      const url = parsed.toString()
      const pool = new Pool({ connectionString: url })
      const databaseClient = drizzle({ client: pool })
      const postgresContext = yield* Layer.build(
        PgClient.layerFrom(PgClient.make({ url: Redacted.make(url), maxConnections: 4 })),
      )
      const identityDatabase = yield* PgDrizzle.makeWithDefaults().pipe(Effect.provideContext(postgresContext))
      const devices = makePostgresCliDeviceDirectory(identityDatabase)
      let runtime: IdentityRuntime | undefined
      const effectContext = yield* Effect.context<never>()
      const server = serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (incoming) =>
          runtime === undefined
            ? new Response("Not ready", { status: 503 })
            : Effect.runPromiseWith(effectContext)(runtime.handle(incoming)),
      })
      const port = server.port
      if (port === undefined) return yield* Effect.die("identity fixture did not bind a port")
      const baseUrl = `http://127.0.0.1:${port}`
      try {
        for (const migration of identityMigrations) {
          // ast-grep-ignore: effect-prefer-filesystem -- Bun serves the migration fixture from a URL boundary.
          const sql = yield* Effect.tryPromise(() => Bun.file(fileURLToPath(migration.url)).text())
          yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })
        }
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
              mail: { resendApiKey: Redacted.make("resend-secret"), emailFrom: "Rika <no-reply@example.test>" },
              resource: `${baseUrl}/api/v1`,
            },
            pool,
            mail: { send: () => Effect.void },
          }),
        )
        runtime = Context.get(runtimeContext, IdentityRuntimeService)
        const email = "api-v2-authority@example.test"
        const password = "correct-horse-battery-staple"
        const signedUp = yield* runtime.handle(
          jsonRequest(`${baseUrl}/api/auth/sign-up/email`, {
            name: "API-v2 Authority",
            email,
            password,
            callbackURL: "/",
          }),
        )
        expect(signedUp.status).toBe(200)
        yield* Effect.tryPromise(() =>
          databaseClient.update(identityUser).set({ emailVerified: true }).where(eq(identityUser.email, email)),
        )
        const signedIn = yield* runtime.handle(
          jsonRequest(`${baseUrl}/api/auth/sign-in/email`, { email, password, callbackURL: "/" }),
        )
        expect(signedIn.status).toBe(200)
        const cookie = signedIn.headers.get("set-cookie")?.split(";", 1)[0]
        expect(cookie).toBeDefined()
        const key = yield* makeDpopKey
        const registered = yield* runtime.handle(
          jsonRequest(`${baseUrl}/api/auth/oauth2/register`, {
            client_name: "API-v2 live authority",
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
        const registration = yield* decodeJson(Registration, registered)
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
        const authorization = yield* decodeJson(Authorization, device)
        const claimed = yield* runtime.handle(
          new Request(`${baseUrl}/api/auth/device?user_code=${authorization.user_code}`, {
            headers: { cookie: cookie! },
          }),
        )
        expect(claimed.status).toBe(200)
        const approved = yield* runtime.handle(
          jsonRequest(`${baseUrl}/api/auth/device/approve`, { userCode: authorization.user_code }, cookie),
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
        const tokenResponseBody = yield* Effect.tryPromise(() => token.clone().text())
        expect(token.status, tokenResponseBody).toBe(200)
        const tokens = yield* decodeJson(Tokens, token)
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
        if (principal === undefined || principal.dpopJkt === undefined)
          return yield* Effect.die("identity principal did not include device binding")
        const bridgeProof = yield* dpopProof({
          method: "POST",
          url: contextUrl,
          privateKey: key.privateKey,
          publicJwk: key.publicJwk,
          accessToken: tokens.access_token,
        })
        const bridged = originalRequestForAuthentication(
          new Request("https://rivet.local/sessions/root", {
            method: "GET",
            headers: {
              authorization: `Bearer ${tokens.access_token}`,
              dpop: bridgeProof,
              [RIKA_ORIGINAL_AUTHORIZATION]: `DPoP ${tokens.access_token}`,
              [RIKA_ORIGINAL_REQUEST_METHOD]: "POST",
              [RIKA_ORIGINAL_REQUEST_URL]: contextUrl,
            },
          }),
        )
        expect(bridged.method).toBe("POST")
        expect((yield* runtime.identify(bridged))?.userId).toBe(principal.userId)
        const deviceId = "00000000-0000-4000-8000-000000000001"
        yield* devices.register({
          clientId: registration.client_id,
          deviceId,
          publicJwk: key.publicJwk,
          jwkThumbprint: principal.dpopJkt,
        })
        const product: ProductRepositoryService = {
          stageWorkspaceSeed: unused,
          resolveOwner: unused,
          organizationIds: unused,
          projects: unused,
          projectAccess: unused,
          createProject: unused,
          existingConnection: unused,
          createConnection: unused,
          threadAuthority: (userId) => Effect.succeed(authorityProjection(userId)),
          threadAuthorities: unused,
          personalOwnerId: () => Effect.succeed("owner"),
          threadMetadataList: unused,
          threadMetadata: unused,
          threadExecutionContext: unused,
          ready: unused(),
        }
        const clientAuthority: HostedClientAuthorityService = {
          registerDevice: unused,
          authenticateClient: unused,
          grantClientAuthority: unused,
          findThread: unused,
          readThread: unused,
          authorizeThread: () => Effect.void,
        }
        const binding = {
          partition: threadPartition({ environment: "test", ownerId: "owner", threadId: "thread", target: "runner" }),
          placement: { _tag: "Runner" as const, checkoutFingerprint: "checkout", workspaceId: "workspace" },
          workspaceBinding: decodeWorkspaceBinding({
            workspaceId: "workspace",
            assignmentId: "assignment",
            generation: 1,
            placement: { _tag: "Runner" as const, checkoutFingerprint: "checkout", workspaceId: "workspace" },
            buildId: "build",
            protocolVersion: 1,
          }),
        }
        const authority = makeRepositoryProductAuthority({
          identity: runtime,
          devices,
          product,
          clientAuthority,
          environment: "test",
          binding: () => Effect.succeed(binding),
        })
        const authenticated = yield* authority.authenticateBearer("ignored", {
          ownerId: "owner",
          threadId: "thread",
          request: new Request(contextUrl, {
            method: "POST",
            headers: {
              authorization: `DPoP ${tokens.access_token}`,
              dpop: yield* dpopProof({
                method: "POST",
                url: contextUrl,
                privateKey: key.privateKey,
                publicJwk: key.publicJwk,
                accessToken: tokens.access_token,
              }),
            },
            body: "prompt",
          }),
        })
        expect(authenticated?.id).toContain(registration.client_id)
        const credential = yield* authority.downstreamCredential!({
          principal: authenticated!,
          ownerId: "owner",
          threadId: "thread",
          request: new Request(contextUrl, {
            method: "POST",
            headers: { authorization: `DPoP ${tokens.access_token}` },
          }),
        })
        expect(credential).toMatch(/^rika-ds-/)
        expect(
          yield* authority.authenticateDownstream!(credential!, {
            ownerId: "owner",
            threadId: "thread",
            request: new Request("https://rivet.local/sessions/root", {
              method: "GET",
              headers: {
                "x-rika-original-request-url": contextUrl,
                "x-rika-original-request-method": "POST",
              },
            }),
          }),
        ).toEqual(authenticated)
        const invalidProof = yield* dpopProof({
          method: "GET",
          url: contextUrl,
          privateKey: key.privateKey,
          publicJwk: key.publicJwk,
          accessToken: tokens.access_token,
        })
        const invalid = yield* Effect.exit(
          authority.authenticateBearer("ignored", {
            ownerId: "owner",
            threadId: "thread",
            request: new Request(contextUrl, {
              method: "POST",
              headers: { authorization: `DPoP ${tokens.access_token}`, dpop: invalidProof },
              body: "prompt",
            }),
          }),
        )
        expect(Exit.isFailure(invalid)).toBe(true)
        const revoked = yield* devices.revoke(principal, deviceId)
        expect(revoked).toBe(true)
        const afterRevoke = yield* authority.authenticateBearer("ignored", {
          ownerId: "owner",
          threadId: "thread",
          request: new Request(contextUrl, {
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
        })
        expect(afterRevoke).toBeUndefined()
      } finally {
        yield* Effect.tryPromise(() => server.stop(true))
        yield* Effect.tryPromise(() => pool.end())
        yield* Effect.tryPromise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
        yield* Effect.tryPromise(() => admin.end())
      }
    }),
  ),
)
