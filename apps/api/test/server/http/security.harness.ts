import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { handleRequest, type HttpDependencies } from "../../../src/server/http"
import { isRikaApiPath, makeRikaApiHandler } from "../../../src/api"
import { httpFixture } from "./fixture"
const { account, dependencies, devices, encodeJson } = httpFixture

const request = (path: string, options?: RequestInit) => {
  const headers = new Headers(options?.headers)
  if (options?.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json")
  return new Request(`https://api.example.com${path}`, { ...options, headers })
}

const response = (path: string, deps = dependencies(), options?: RequestInit) => {
  const input = request(path, options)
  if (!isRikaApiPath(new URL(input.url).pathname)) return handleRequest({ request: input, dependencies: deps })
  return Effect.acquireUseRelease(
    Effect.sync(() => makeRikaApiHandler(deps)),
    (api) => Effect.tryPromise(() => api.handler(input, undefined)),
    (api) => Effect.tryPromise(api.dispose),
  )
}

describe("api HTTP", () => {
  it.effect("does not expose the replaced connection and operation endpoints", () =>
    Effect.gen(function* () {
      const deps = dependencies({ userId: "user-1", account })
      const connection = yield* response("/api/v1/connections", deps, {
        method: "POST",
        body: encodeJson({}),
      })
      const operation = yield* response("/api/v1/threads/thread-1/operations", deps, {
        method: "POST",
        body: encodeJson({}),
      })
      expect(connection.status).toBe(404)
      expect(operation.status).toBe(404)
    }),
  )

  it.effect("rejects client-supplied ownership fields for local admission", () =>
    Effect.gen(function* () {
      const base = dependencies({ account })
      const deps: HttpDependencies = {
        ...base,
        identity: {
          ...base.identity,
          identify: () => Effect.succeed({ userId: "user-1", clientId: "client-1" }),
        },
        devices: { ...devices, authenticate: () => Effect.succeed("device-1") },
      }
      for (const body of [
        { workspace_fingerprint: "workspace-1", organization_id: "organization-1" },
        { workspace_fingerprint: "workspace-1", member_id: "member-1" },
      ]) {
        const result = yield* response("/api/v1/threads/thread-2/runner-admissions", deps, {
          method: "POST",
          body: encodeJson(body),
        })
        expect(result.status).toBe(400)
      }
    }),
  )

  it.effect("returns secured JSON 404 responses for web pages and assets", () =>
    Effect.gen(function* () {
      for (const path of [
        "/",
        "/login",
        "/signup",
        "/verify-email",
        "/forgot-password",
        "/reset-password",
        "/assets/web.css",
      ]) {
        const result = yield* response(path)
        expect(result.status).toBe(404)
        expect(result.headers.get("content-type")).toBe("application/json; charset=utf-8")
        expect(result.headers.get("x-content-type-options")).toBe("nosniff")
        expect(yield* Effect.tryPromise(() => result.json())).toEqual({ message: "Not found" })
      }
    }),
  )

  it.effect("allows a personal account to approve a device without an organization", () =>
    Effect.gen(function* () {
      const withoutOrganization = dependencies({
        userId: "user-1",
        account: { ...account, memberships: [] },
      })
      const api = yield* response("/api/auth/device/approve", withoutOrganization, { method: "POST" })
      expect(api.status).toBe(204)
    }),
  )

  it.effect("requires authentication but no organization at OAuth authorization", () =>
    Effect.gen(function* () {
      const path = "/api/auth/oauth2/authorize?client_id=client-1&response_type=code"
      const anonymous = yield* response(path)
      expect(anonymous.status).toBe(303)
      expect(anonymous.headers.get("location")).toContain("/login?redirect=")

      const withoutOrganization = dependencies({
        userId: "user-1",
        account: { ...account, memberships: [] },
      })
      const personal = yield* response(path, withoutOrganization)
      expect(personal.status).toBe(204)
    }),
  )

  it.effect("publishes DPoP protected-resource metadata", () =>
    Effect.gen(function* () {
      const result = yield* response("/.well-known/oauth-protected-resource/api/v1")
      expect(result.status).toBe(200)
      expect(yield* Effect.tryPromise(() => result.json())).toEqual({
        resource: "https://api.example.com/api/v1",
        dpop_bound_access_tokens_required: true,
      })
    }),
  )
})
