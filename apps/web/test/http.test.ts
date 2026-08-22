import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { type Account, type AccountAccess } from "../src/account-gateway"
import { makeApiAccountGateway } from "../src/adapters/api-account-gateway"
import { handleRequest, type WebDependencies } from "../src/http"

const account: Account = {
  user: { id: "user-1", name: "Rika User", email: "rika@example.com", emailVerified: true, image: null },
  memberships: [
    {
      id: "member-1",
      role: "owner",
      createdAt: "2026-08-19T00:00:00.000Z",
      organization: { id: "organization-1", name: "Rika", slug: "rika", logo: null },
    },
  ],
}

const dependencies = (access: AccountAccess = { _tag: "anonymous" }): WebDependencies => ({
  production: true,
  accountGateway: { account: () => Effect.succeed(access) },
})

const request = (path: string, options?: RequestInit) => new Request(`https://web.example.test${path}`, options)
const response = (path: string, access?: AccountAccess, options?: RequestInit) =>
  handleRequest({ request: request(path, options), dependencies: dependencies(access) })

describe("web HTTP", () => {
  it.effect("serves browser pages and owned assets with security headers", () =>
    Effect.gen(function* () {
      for (const path of ["/login", "/signup", "/verify-email", "/forgot-password", "/reset-password", "/threads"]) {
        const result = yield* response(path)
        expect(result.status).toBe(200)
        expect(result.headers.get("content-type")).toBe("text/html; charset=utf-8")
        expect(result.headers.get("x-content-type-options")).toBe("nosniff")
        expect(yield* Effect.promise(() => result.text())).toContain('<html lang="en">')
      }
      const css = yield* response("/assets/web.css")
      const script = yield* response("/assets/web.js")
      expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8")
      expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
      const threads = yield* response("/threads")
      const threadHtml = yield* Effect.promise(() => threads.text())
      expect(threadHtml).toContain('id="root"')
      expect(threadHtml).toContain("/assets/thread-client.js")
    }),
  )

  it.effect("keeps redirects on this origin", () =>
    Effect.gen(function* () {
      const login = yield* response("/login?redirect=%2F%5C%5Cattacker.example")
      expect(yield* Effect.promise(() => login.text())).toContain('data-redirect="/"')
      const protectedPage = yield* response("/invitations/invitation-1?redirect=https%3A%2F%2Fattacker.example")
      expect(protectedPage.status).toBe(303)
      expect(protectedPage.headers.get("location")).toBe(
        "/login?redirect=%2Finvitations%2Finvitation-1%3Fredirect%3Dhttps%253A%252F%252Fattacker.example",
      )
    }),
  )

  it.effect("forwards email-verification callbacks only to a safe local path", () =>
    Effect.gen(function* () {
      const callback = yield* response("/verify-email?token=token-1&callbackURL=%2Finvitations%2Finvitation-1")
      expect(callback.status).toBe(303)
      expect(callback.headers.get("location")).toBe(
        "/api/auth/verify-email?token=token-1&callbackURL=%2Finvitations%2Finvitation-1",
      )
      const rejected = yield* response("/verify-email?token=token-1&callbackURL=https%3A%2F%2Fattacker.example")
      expect(rejected.headers.get("location")).toBe(
        "/api/auth/verify-email?token=token-1&callbackURL=%2Forganizations%2Fnew",
      )
    }),
  )

  it.effect("guards account and organization pages through the account gateway", () =>
    Effect.gen(function* () {
      const anonymous = yield* response("/")
      expect(anonymous.status).toBe(303)
      expect(anonymous.headers.get("location")).toBe("/login?redirect=%2F")
      const unavailable = yield* response("/", { _tag: "unavailable" })
      expect(unavailable.status).toBe(503)
      const onboarding = yield* response("/device", { _tag: "account", account: { ...account, memberships: [] } })
      expect(onboarding.status).toBe(303)
      expect(onboarding.headers.get("location")).toBe("/organizations/new?redirect=%2Fdevice")
      const authenticated = yield* response("/", { _tag: "account", account })
      expect(authenticated.status).toBe(200)
      expect(yield* Effect.promise(() => authenticated.text())).toContain("Your account")
    }),
  )

  it.effect("preserves the device code as a DOM dataset property", () =>
    Effect.gen(function* () {
      const result = yield* response("/device/approve?user_code=ABCD1234", { _tag: "account", account })
      expect(result.status).toBe(200)
      expect(yield* Effect.promise(() => result.text())).toContain('data-user-code="ABCD1234"')
    }),
  )

  it.effect("passes only the cookie and request signal to the account gateway", () =>
    Effect.gen(function* () {
      let received: { readonly cookie: string | undefined; readonly signal: AbortSignal } | undefined
      const input = request("/", { headers: { cookie: "session=secret", authorization: "Bearer must-not-cross" } })
      const result = yield* handleRequest({
        request: input,
        dependencies: {
          production: true,
          accountGateway: {
            account: (gatewayRequest) =>
              Effect.sync(() => {
                received = gatewayRequest
                return { _tag: "account", account } as const
              }),
          },
        },
      })
      expect(result.status).toBe(200)
      expect(received?.cookie).toBe("session=secret")
      expect(received?.signal).toBe(input.signal)
      expect(Object.keys(received ?? {}).sort()).toEqual(["cookie", "signal"])
    }),
  )

  it.effect("returns 404 for paths owned by neither the web pages nor assets", () =>
    Effect.gen(function* () {
      const result = yield* response("/not-owned")
      expect(result.status).toBe(404)
      expect(result.headers.get("x-content-type-options")).toBe("nosniff")
    }),
  )
})

describe("API account gateway", () => {
  it.effect("forwards only a Cookie header to the API", () =>
    Effect.gen(function* () {
      let forwardedCookie: string | undefined
      let forwardedAuthorization: string | undefined
      let forwardedHeaderNames: ReadonlyArray<string> = []
      const client = HttpClient.make((outgoing) =>
        Effect.sync(() => {
          forwardedCookie = outgoing.headers.cookie
          forwardedAuthorization = outgoing.headers.authorization
          forwardedHeaderNames = Object.keys(outgoing.headers)
          return HttpClientResponse.fromWeb(outgoing, Response.json(account))
        }),
      )
      const gateway = makeApiAccountGateway({ domain: "api.railway.internal", port: "3000", client })
      const result = yield* gateway.account({
        cookie: "session=secret",
        signal: new Request("https://web.example.test").signal,
      })
      expect(result).toEqual({ _tag: "account", account })
      expect(forwardedCookie).toBe("session=secret")
      expect(forwardedAuthorization).toBeUndefined()
      expect(forwardedHeaderNames.filter((name) => !["b3", "traceparent"].includes(name))).toEqual(["cookie"])
    }),
  )

  it.effect("models anonymous, unavailable, and bounded account failures", () =>
    Effect.gen(function* () {
      const anonymousClient = HttpClient.make((outgoing) =>
        Effect.succeed(HttpClientResponse.fromWeb(outgoing, new Response(null, { status: 401 }))),
      )
      const unavailableClient = HttpClient.make((outgoing) =>
        Effect.succeed(HttpClientResponse.fromWeb(outgoing, new Response(null, { status: 503 }))),
      )
      const neverClient = HttpClient.make(() => Effect.never)
      const signal = new Request("https://web.example.test").signal
      expect(
        yield* makeApiAccountGateway({ domain: "api.railway.internal", port: "3000", client: anonymousClient }).account(
          {
            cookie: undefined,
            signal,
          },
        ),
      ).toEqual({ _tag: "anonymous" })
      expect(
        yield* makeApiAccountGateway({
          domain: "api.railway.internal",
          port: "3000",
          client: unavailableClient,
        }).account({
          cookie: undefined,
          signal,
        }),
      ).toEqual({ _tag: "unavailable" })
      expect(
        yield* makeApiAccountGateway({
          domain: "api.railway.internal",
          port: "3000",
          client: neverClient,
          timeout: 0,
        }).account({
          cookie: undefined,
          signal,
        }),
      ).toEqual({ _tag: "unavailable" })
    }),
  )
})
