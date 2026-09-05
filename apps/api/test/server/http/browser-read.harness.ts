import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { OwnerId } from "@rika/product/hosted-model"
import { ThreadId } from "@rika/product/thread-record"
import { HostedProductError } from "../../../src/hosted/product"
import { makeRikaApiHandler } from "../../../src/api"
import type { HttpDependencies } from "../../../src/server/http"
import { httpFixture } from "./fixture"

const { account, dependencies, product, encodeJson } = httpFixture
const response = (path: string, deps: HttpDependencies, options?: RequestInit) =>
  Effect.acquireUseRelease(
    Effect.sync(() => makeRikaApiHandler(deps)),
    (api) =>
      Effect.tryPromise(() => {
        const headers = new Headers(options?.headers)
        if (options?.body !== undefined) headers.set("content-type", "application/json")
        return api.handler(new Request(`https://api.example.com${path}`, { ...options, headers }), undefined)
      }),
    (api) => Effect.tryPromise(api.dispose),
  )

it.effect("cookie reads filter Threads without creating device authority and deny anonymous or foreign access", () =>
  Effect.gen(function* () {
    const base = dependencies({ account: { ...account, memberships: [] } })
    const visible = {
      id: ThreadId.make("visible"),
      workspace: "workspace",
      title: "Review",
      pinned: false,
      archived: false,
      status: "idle" as const,
      unread: false,
      lastActivityAt: 1,
      turnCount: 0,
    }
    const deps: HttpDependencies = {
      ...base,
      identity: {
        ...base.identity,
        identify: (incoming) => Effect.succeed(incoming.headers.has("cookie") ? { userId: "user-1" } : undefined),
      },
      product: {
        ...product,
        authorizeReadOwner: (principal, owner) => {
          expect(principal).toEqual({ userId: "user-1" })
          if (owner._tag === "OrganizationOwner")
            return Effect.fail(HostedProductError.make({ kind: "forbidden", message: "not a member" }))
          expect(owner).toMatchObject({ _tag: "PersonalOwner", userId: "user-1" })
          return Effect.succeed({ ownerId: OwnerId.make("owner-1") })
        },
        authorizeReadThread: (principal, id) => {
          expect(principal).toEqual({ userId: "user-1" })
          return id === "visible"
            ? Effect.succeed({ ownerId: OwnerId.make("owner-1") })
            : Effect.fail(HostedProductError.make({ kind: "forbidden", message: "foreign owner or grant denied" }))
        },
      },
      threadApplication: {
        threads: () => Effect.succeed([visible, { ...visible, id: ThreadId.make("foreign") }]),
        preview: () => Effect.succeed([]),
        thread: () => Effect.die("unused"),
        interactive: () => Effect.die("unused"),
        snapshot: () => Effect.die("unused"),
        projectionCommitted: () => Effect.die("unused"),
      },
    }
    const headers = { cookie: "test-session=authenticated", origin: "https://api.example.com" }
    const listed = yield* response("/api/v1/threads/list", deps, {
      method: "POST",
      headers,
      body: encodeJson({ owner: { kind: "personal" } }),
    })
    expect(listed.status).toBe(200)
    expect(yield* Effect.tryPromise(() => listed.json())).toEqual({ threads: [visible] })
    expect((yield* response("/api/v1/threads/visible/preview", deps, { headers })).status).toBe(200)
    expect((yield* response("/api/v1/threads/foreign/preview", deps, { headers })).status).toBe(403)
    expect((yield* response("/api/v1/threads/visible/preview", deps)).status).toBe(401)
    expect(
      (yield* response("/api/v1/threads/list", deps, {
        method: "POST",
        body: encodeJson({ owner: { kind: "personal" } }),
      })).status,
    ).toBe(401)
    expect(
      (yield* response("/api/v1/threads/list", deps, {
        method: "POST",
        headers,
        body: encodeJson({ owner: { kind: "organization", organization_id: "foreign" } }),
      })).status,
    ).toBe(403)
  }),
)
