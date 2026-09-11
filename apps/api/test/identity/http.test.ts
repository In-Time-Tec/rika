import { Context, Effect, Layer, Schema } from "effect"
import { it } from "@effect/vitest"
import {
  CliDeviceDirectoryError,
  IdentityRuntimeService,
  type Account,
  type CliDeviceDirectory,
  type CliDeviceRegistration,
  type IdentityDirectory,
  type IdentityPrincipal,
  type IdentityRuntime,
} from "@rika/identity"
import { expect } from "vitest"
import {
  authenticateIdentityRequest,
  makeIdentityRequestHandler,
  type IdentityHttpOptions,
} from "../../src/identity/http"

const account: Account = {
  user: {
    id: "user-1",
    name: "Rika User",
    email: "rika@example.test",
    emailVerified: true,
    image: null,
  },
  memberships: [
    {
      id: "member-1",
      role: "owner",
      createdAt: "2026-09-01T00:00:00.000Z",
      organization: { id: "organization-1", name: "Rika", slug: "rika", logo: null },
    },
  ],
}

const cliPrincipal: IdentityPrincipal = {
  userId: account.user.id,
  clientId: "client-1",
  dpopJkt: "public-jwk-thumbprint",
}

const registrationPayload = {
  reference_id: "cli-device:019d1a56-286d-7000-8000-000000000001",
  token_endpoint_auth_method: "none",
  grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
  scope: "openid profile email offline_access account",
  resource: "https://api.example.test/api/v1",
  dpop_jkt: "public-jwk-thumbprint",
  jwk: { kty: "EC", crv: "P-256", x: "public-x", y: "public-y" },
} as const

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const makeRequest = (path: string, init?: RequestInit) => new Request(`https://api.example.test${path}`, init)

const handled = (response: Response | undefined) =>
  response === undefined ? Effect.die("Expected the identity handler to own this route") : Effect.succeed(response)

class TestHttpBodyError extends Schema.TaggedError<TestHttpBodyError>()("RikaApiV2IdentityHttpTestBodyError", {
  source: Schema.Literals(["request", "response"]),
}) {}

const responseText = Effect.fn("RikaApiV2.IdentityHttpTest.responseText")(function* (response: Response) {
  return yield* Effect.tryPromise({
    try: () => response.text(),
    catch: () => TestHttpBodyError.make({ source: "response" }),
  })
})

const requestText = Effect.fn("RikaApiV2.IdentityHttpTest.requestText")(function* (incoming: Request) {
  return yield* Effect.tryPromise({
    try: () => incoming.text(),
    catch: () => TestHttpBodyError.make({ source: "request" }),
  })
})

const decodeJson = (body: string) => Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(body)

interface FixtureInput {
  readonly handle?: IdentityRuntime["handle"]
  readonly identify?: IdentityRuntime["identify"]
  readonly protectedResourceMetadata?: IdentityRuntime["protectedResourceMetadata"]
  readonly account?: IdentityDirectory["account"]
  readonly register?: CliDeviceDirectory["register"]
  readonly discard?: CliDeviceDirectory["discard"]
  readonly authenticate?: CliDeviceDirectory["authenticate"]
  readonly list?: CliDeviceDirectory["list"]
  readonly revoke?: CliDeviceDirectory["revoke"]
  readonly revokeAll?: CliDeviceDirectory["revokeAll"]
}

interface FixtureState {
  readonly handled: Array<Request>
  readonly identified: Array<Request>
  readonly accounts: Array<string>
  readonly registrations: Array<CliDeviceRegistration>
  readonly discarded: Array<string>
  readonly authenticated: Array<IdentityPrincipal>
  readonly listed: Array<IdentityPrincipal>
  readonly revoked: Array<{ readonly principal: IdentityPrincipal; readonly deviceId: string }>
  readonly revokedAll: Array<IdentityPrincipal>
}

const fixture = (input: FixtureInput = {}) => {
  const state: FixtureState = {
    handled: [],
    identified: [],
    accounts: [],
    registrations: [],
    discarded: [],
    authenticated: [],
    listed: [],
    revoked: [],
    revokedAll: [],
  }
  const identity: IdentityRuntime = {
    handle: (incoming) => {
      state.handled.push(incoming)
      return input.handle?.(incoming) ?? Effect.succeed(new Response(null, { status: 204 }))
    },
    identify: (incoming) => {
      state.identified.push(incoming)
      return input.identify?.(incoming) ?? Effect.void.pipe(Effect.as<IdentityPrincipal | undefined>(undefined))
    },
    browserSession: () => Effect.void.pipe(Effect.as<undefined>(undefined)),
    protectedResourceMetadata:
      input.protectedResourceMetadata ??
      Effect.succeed({
        resource: "https://api.example.test/api/v1",
        authorization_servers: ["https://api.example.test/api/auth"],
        dpop_bound_access_tokens_required: true,
      }),
  }
  const directory: IdentityDirectory = {
    ready: Effect.void,
    account: (userId) => {
      state.accounts.push(userId)
      return input.account?.(userId) ?? Effect.succeed(account)
    },
  }
  const devices: CliDeviceDirectory = {
    register: (registration) => {
      state.registrations.push(registration)
      return input.register?.(registration) ?? Effect.void
    },
    discard: (clientId) => {
      state.discarded.push(clientId)
      return input.discard?.(clientId) ?? Effect.void
    },
    authenticate: (principal) => {
      state.authenticated.push(principal)
      return (
        input.authenticate?.(principal) ?? Effect.succeed(principal.clientId === undefined ? undefined : "device-1")
      )
    },
    list: (principal) => {
      state.listed.push(principal)
      return input.list?.(principal) ?? Effect.succeed([{ id: "device-1", current: true }])
    },
    revoke: (principal, deviceId) => {
      state.revoked.push({ principal, deviceId })
      return input.revoke?.(principal, deviceId) ?? Effect.succeed(true)
    },
    revokeAll: (principal) => {
      state.revokedAll.push(principal)
      return input.revokeAll?.(principal) ?? Effect.void
    },
  }
  return { options: { identity, directory, devices } satisfies IdentityHttpOptions, state }
}

const withIdentityHandler = <A, E, R>(
  options: IdentityHttpOptions,
  use: (handler: ReturnType<typeof makeIdentityRequestHandler>) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(Layer.succeed(IdentityRuntimeService, options.identity))
      return yield* use(
        makeIdentityRequestHandler({ ...options, identity: Context.get(context, IdentityRuntimeService) }),
      )
    }),
  )

it.effect("registers a public CLI client and rejects unbounded or non-strict payloads", () =>
  Effect.gen(function* () {
    const test = fixture({
      handle: () => Effect.succeed(Response.json({ client_id: "client-1", ignored: "not returned" }, { status: 201 })),
    })
    yield* withIdentityHandler(test.options, (handler) =>
      Effect.gen(function* () {
        const result = yield* handled(
          yield* handler(
            makeRequest("/api/v1/auth/cli/registrations", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: encodeJson(registrationPayload),
            }),
          ),
        )
        expect(result.status).toBe(201)
        expect(yield* decodeJson(yield* responseText(result))).toEqual({ client_id: "client-1" })
        expect(test.state.registrations).toEqual([
          {
            clientId: "client-1",
            deviceId: "019d1a56-286d-7000-8000-000000000001",
            publicJwk: registrationPayload.jwk,
            jwkThumbprint: registrationPayload.dpop_jkt,
          },
        ])
        expect(test.state.handled).toHaveLength(1)
        const forwarded = test.state.handled[0]
        expect(forwarded?.url).toBe("https://api.example.test/api/auth/oauth2/register")
        expect(forwarded?.method).toBe("POST")
        expect(yield* decodeJson(yield* requestText(forwarded!))).toEqual({
          client_name: "Rika CLI",
          application_type: "native",
          token_endpoint_auth_method: "none",
          grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
          scope: "openid profile email offline_access account",
          software_id: "rika-cli",
          dpop_bound_access_tokens: true,
          resources: ["https://api.example.test/api/v1"],
        })

        const oversized = yield* handled(
          yield* handler(
            makeRequest("/api/v1/auth/cli/registrations", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "x".repeat(16_385),
            }),
          ),
        )
        expect(oversized.status).toBe(413)

        const nonStrict = yield* handled(
          yield* handler(
            makeRequest("/api/v1/auth/cli/registrations", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: encodeJson({ ...registrationPayload, jwk: { ...registrationPayload.jwk, d: "rejected" } }),
            }),
          ),
        )
        expect(nonStrict.status).toBe(400)
        expect(test.state.handled).toHaveLength(1)
      }),
    )
  }),
)

it.effect("rolls back the OAuth client when its device binding cannot persist", () =>
  Effect.gen(function* () {
    const test = fixture({
      handle: () => Effect.succeed(Response.json({ client_id: "client-rollback" }, { status: 201 })),
      register: () => Effect.fail(CliDeviceDirectoryError.make({ operation: "register CLI device" })),
    })
    yield* withIdentityHandler(test.options, (handler) =>
      Effect.gen(function* () {
        const result = yield* handled(
          yield* handler(
            makeRequest("/api/v1/auth/cli/registrations", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: encodeJson(registrationPayload),
            }),
          ),
        )
        expect(result.status).toBe(503)
        expect(test.state.discarded).toEqual(["client-rollback"])
        expect(yield* responseText(result)).not.toContain("client-rollback")
      }),
    )
  }),
)

it.effect("returns account access only after the original request verifies its active device", () =>
  Effect.gen(function* () {
    const test = fixture({ identify: () => Effect.succeed(cliPrincipal) })
    const incoming = makeRequest("/api/account?proof=1", {
      headers: { authorization: "DPoP test-access", dpop: "test-proof" },
    })
    yield* withIdentityHandler(test.options, (handler) =>
      Effect.gen(function* () {
        const access = yield* authenticateIdentityRequest(incoming, test.options)
        expect(access).toEqual({ principal: cliPrincipal, account, deviceId: "device-1" })
        const result = yield* handled(yield* handler(incoming))
        expect(result.status).toBe(200)
        expect(yield* decodeJson(yield* responseText(result))).toEqual(account)
        expect(test.state.identified[0]).toBe(incoming)
        expect(test.state.identified[1]).toBe(incoming)
      }),
    )

    const revoked = fixture({
      identify: () => Effect.succeed(cliPrincipal),
      authenticate: () => Effect.void.pipe(Effect.as<string | undefined>(undefined)),
    })
    yield* withIdentityHandler(revoked.options, (handler) =>
      Effect.gen(function* () {
        const access = yield* Effect.result(authenticateIdentityRequest(incoming, revoked.options))
        expect(access).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "RikaApiV2IdentityRequestAuthenticationError", kind: "invalid" },
        })
        const result = yield* handled(yield* handler(incoming))
        expect(result.status).toBe(401)
        expect(result.headers.get("www-authenticate")).toBe('Bearer realm="rika"')
      }),
    )
  }),
)

it.effect("lists and revokes only authenticated CLI device bindings", () =>
  Effect.gen(function* () {
    const test = fixture({ identify: () => Effect.succeed(cliPrincipal) })
    yield* withIdentityHandler(test.options, (handler) =>
      Effect.gen(function* () {
        const listed = yield* handled(yield* handler(makeRequest("/api/v1/auth/cli/devices")))
        expect(listed.status).toBe(200)
        expect(yield* decodeJson(yield* responseText(listed))).toEqual({ devices: [{ id: "device-1", current: true }] })

        const revoked = yield* handled(
          yield* handler(makeRequest("/api/v1/auth/cli/devices/device-2/revoke", { method: "POST" })),
        )
        expect(revoked.status).toBe(204)

        const revokedAll = yield* handled(
          yield* handler(makeRequest("/api/v1/auth/cli/devices/revoke-all", { method: "POST" })),
        )
        expect(revokedAll.status).toBe(204)
        expect(test.state.listed).toEqual([cliPrincipal])
        expect(test.state.revoked).toEqual([{ principal: cliPrincipal, deviceId: "device-2" }])
        expect(test.state.revokedAll).toEqual([cliPrincipal])
      }),
    )

    const browser = fixture({ identify: () => Effect.succeed({ userId: account.user.id }) })
    yield* withIdentityHandler(browser.options, (handler) =>
      Effect.gen(function* () {
        const result = yield* handled(
          yield* handler(makeRequest("/api/v1/auth/cli/devices/revoke-all", { method: "POST" })),
        )
        expect(result.status).toBe(401)
        expect(browser.state.revokedAll).toEqual([])
      }),
    )
  }),
)

it.effect("forwards organization invitations only for an account membership", () =>
  Effect.gen(function* () {
    const accepted = fixture({
      identify: () => Effect.succeed({ userId: account.user.id }),
      handle: () => Effect.succeed(Response.json({ id: "invite-1", email: "new@example.test" })),
    })
    const incoming = makeRequest("/api/v1/organizations/organization-1/invitations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "DPoP test-access", dpop: "test-proof" },
      body: encodeJson({ email: "new@example.test" }),
    })
    yield* withIdentityHandler(accepted.options, (handler) =>
      Effect.gen(function* () {
        const result = yield* handled(yield* handler(incoming))
        expect(result.status).toBe(200)
        expect(accepted.state.identified[0]).toBe(incoming)
        const forwarded = accepted.state.handled[0]
        expect(forwarded?.url).toBe("https://api.example.test/api/auth/organization/invite-member")
        expect(yield* decodeJson(yield* requestText(forwarded!))).toEqual({
          email: "new@example.test",
          organizationId: "organization-1",
          role: "member",
        })
      }),
    )

    const rejected = fixture({
      identify: () => Effect.succeed({ userId: account.user.id }),
      account: () => Effect.succeed({ ...account, memberships: [] }),
    })
    yield* withIdentityHandler(rejected.options, (handler) =>
      Effect.gen(function* () {
        const result = yield* handled(
          yield* handler(
            makeRequest("/api/v1/organizations/foreign/invitations", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: encodeJson({ email: "new@example.test" }),
            }),
          ),
        )
        expect(result.status).toBe(404)
        expect(rejected.state.handled).toEqual([])
      }),
    )
  }),
)

it.effect("delegates OAuth metadata and redirects anonymous browser authorization", () =>
  Effect.gen(function* () {
    const delegated = new Response("delegated", { status: 202 })
    const test = fixture({ handle: () => Effect.succeed(delegated) })
    yield* withIdentityHandler(test.options, (handler) =>
      Effect.gen(function* () {
        const auth = yield* handled(yield* handler(makeRequest("/api/auth/session")))
        expect(auth).toBe(delegated)

        const authorization = yield* handled(
          yield* handler(makeRequest("/api/auth/oauth2/authorize?client_id=client-1&response_type=code")),
        )
        expect(authorization.status).toBe(303)
        expect(authorization.headers.get("location")).toBe(
          "/login?redirect=%2Fapi%2Fauth%2Foauth2%2Fauthorize%3Fclient_id%3Dclient-1%26response_type%3Dcode",
        )

        const metadata = yield* handled(yield* handler(makeRequest("/.well-known/oauth-protected-resource/api/v1")))
        expect(metadata.status).toBe(200)
        expect(yield* decodeJson(yield* responseText(metadata))).toEqual({
          resource: "https://api.example.test/api/v1",
          authorization_servers: ["https://api.example.test/api/auth"],
          dpop_bound_access_tokens_required: true,
        })

        const authorizationMetadata = yield* handled(
          yield* handler(makeRequest("/.well-known/oauth-authorization-server/api/auth")),
        )
        expect(authorizationMetadata).toBe(delegated)
      }),
    )
  }),
)

it.effect("leaves product and unknown routes for parent composition", () =>
  Effect.gen(function* () {
    const test = fixture()
    yield* withIdentityHandler(test.options, (handler) =>
      Effect.gen(function* () {
        expect(yield* handler(makeRequest("/api/v1/me/context"))).toBeUndefined()
        expect(yield* handler(makeRequest("/api/v1/projects", { method: "POST" }))).toBeUndefined()
        expect(yield* handler(makeRequest("/not-owned"))).toBeUndefined()
        expect(test.state.identified).toEqual([])
        expect(test.state.handled).toEqual([])
      }),
    )
  }),
)
