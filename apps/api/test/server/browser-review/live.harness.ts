import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import { Clock, Context, DateTime, Deferred, Effect, Layer, Queue, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import { eq } from "drizzle-orm"
import {
  identityMember,
  identityOrganization,
  identityUser,
  makeBetterAuthIdentityRuntime,
  type IdentityConfig,
} from "@rika/identity"
import { ThreadId as ProductThreadId } from "@rika/product/thread-record"
import { ThreadProtocolStore } from "@rika/product/thread-protocol-store"
import { HostedPresence } from "@rika/product/hosted-presence"
import { ThreadId, ThreadEventCursor, ThreadVersion, Timestamp } from "@rika/product/hosted-model"
import { protocolVersion, ServerFrame } from "@rika/product/client-protocol"
import { layer as storeLayer } from "@rika/product-store/layer"
import { HostedProduct } from "../../../src/hosted/product"
import { HostedThreadProtocol, layerWithOptions } from "../../../src/hosted/thread/protocol"
import { HostedThreadApplication } from "../../../src/hosted/thread/application"
import { HostedWorkspace } from "../../../src/hosted/environment/workspace"
import { makeThreadProtocolNotifications } from "../../../src/hosted/thread/notifications"
import { serveApi } from "../../../src/server/bun"
import { fakeApplication, fakeWorkspace } from "../../hosted/thread/protocol/fakes.harness"
import { snapshot } from "../../hosted/thread/protocol/memory.fixture"
import { hostedProductFixture, live, organization, principal } from "../../hosted/product/fixture"
import { httpFixture } from "../http/fixture"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

it.effect.skipIf(!live)(
  "live cookie review stops delivery on logout, session expiry and membership removal without presence or acknowledgements",
  () =>
    hostedProductFixture.withDatabase("browser_live", (database, pool) =>
      Effect.scoped(
        Effect.gen(function* () {
          const effectContext = yield* Effect.context<never>()

          const config: IdentityConfig = {
            production: false,
            port: 0,
            baseUrl: "http://127.0.0.1",
            trustedOrigins: [],
            authSecret: Redacted.make("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN"),
            resource: "http://127.0.0.1/api/v1",
            databaseUrl: Redacted.make(pool.options.connectionString!),
            databaseSsl: "disable",
          }
          const identity = makeBetterAuthIdentityRuntime({ config, pool, mail: { send: () => Effect.void } })
          const request = (path: string, body: Schema.Json, cookie?: string) => {
            const headers = new Headers({ "content-type": "application/json", origin: config.baseUrl })
            if (cookie !== undefined) headers.set("cookie", cookie)
            return new Request(`${config.baseUrl}${path}`, {
              method: "POST",
              headers,
              body: encodeJson(body),
            })
          }
          const email = "browser-live@example.test"
          const password = "browser-live-isolated-test-password"
          expect(
            (yield* identity.handle(request("/api/auth/sign-up/email", { name: "Browser reader", email, password })))
              .status,
          ).toBe(200)
          yield* Effect.tryPromise(() =>
            database.update(identityUser).set({ emailVerified: true }).where(eq(identityUser.email, email)),
          )
          const user = (yield* Effect.tryPromise(() =>
            database.select().from(identityUser).where(eq(identityUser.email, email)),
          ))[0]!
          const now = DateTime.toDate(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))
          yield* Effect.tryPromise(() =>
            database
              .insert(identityOrganization)
              .values({ id: "browser-org", name: "Browser", slug: "browser-org", createdAt: now }),
          )
          yield* Effect.tryPromise(() =>
            database.insert(identityMember).values({
              id: "browser-member",
              organizationId: "browser-org",
              userId: user.id,
              role: "owner",
              createdAt: now,
            }),
          )
          const product = yield* HostedProduct
          const created = yield* product.createConnection({
            principal: principal(user.id),
            owner: organization("browser-org"),
            executorKind: "orb",
          })
          const threadId = ThreadId.make(created.threadId)
          const authority = yield* product.authorizeReadThread({ userId: user.id }, threadId)
          const current = {
            ...snapshot,
            executorKind: "orb" as const,
            view: { ...snapshot.view, thread: { ...snapshot.view.thread, id: ProductThreadId.make(threadId) } },
          }
          const stores = yield* Layer.build(storeLayer({ url: config.databaseUrl }))
          const store = Context.get(stores, ThreadProtocolStore)
          const notifications = makeThreadProtocolNotifications()
          const protocolContext = yield* Layer.build(
            layerWithOptions({ notifications }).pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(HostedProduct, product),
                  Layer.succeed(ThreadProtocolStore, store),
                  Layer.succeed(HostedThreadApplication, fakeApplication({ snapshot: () => Effect.succeed(current) })),
                  Layer.succeed(HostedWorkspace, fakeWorkspace()),
                  Layer.succeed(HostedPresence, {
                    upsert: () => Effect.die("Browser wrote presence or Runner demand"),
                    list: () => Effect.die("Browser listed device presence"),
                  }),
                  BunCrypto.layer,
                ),
              ),
            ),
          )
          const protocol = Context.get(protocolContext, HostedThreadProtocol)
          const server = yield* serveApi({
            config,
            dependencies: { ...httpFixture.dependencies(), identity, product, threads: protocol },
          })
          let cursor = 0
          for (const revoke of ["logout", "expiry", "membership"] as const) {
            const signedIn = yield* identity.handle(request("/api/auth/sign-in/email", { email, password }))
            expect(signedIn.status).toBe(200)
            const cookie = signedIn.headers.get("set-cookie")!.split(";", 1)[0]!
            const handle = yield* identity.browserSession(new Request(config.baseUrl, { headers: { cookie } }))
            expect(handle).toBeDefined()
            expect(yield* handle!.validate).toBe(true)
            const opened = yield* Deferred.make<void, Error>()
            const closed = yield* Deferred.make<number>()
            const frames = yield* Queue.unbounded<ServerFrame>()
            // Bun transport boundary for actual cookie/Origin headers; closed by the enclosing Scope.
            // ast-grep-ignore: effect-prefer-socket
            const socket = new WebSocket(`ws://127.0.0.1:${server.server.port}/api/v1/threads/browser-socket`, {
              protocols: ["rika.thread.v1"],
              headers: { origin: config.baseUrl, cookie },
            })
            socket.addEventListener("open", () =>
              Effect.runSyncWith(effectContext)(Deferred.succeed(opened, undefined)),
            )
            socket.addEventListener("error", () =>
              Effect.runSyncWith(effectContext)(Deferred.fail(opened, new Error("Browser handshake failed"))),
            )
            socket.addEventListener("close", (event) =>
              Effect.runSyncWith(effectContext)(Deferred.succeed(closed, event.code)),
            )
            socket.addEventListener("message", (event) => {
              expect(String(event.data).includes(cookie.split("=", 2)[1]!)).toBe(false)
              Queue.offerUnsafe(frames, Schema.decodeUnknownSync(Schema.fromJsonString(ServerFrame))(event.data))
            })
            yield* Effect.addFinalizer(() => Effect.sync(() => socket.close()))
            yield* Deferred.await(opened)
            socket.send(
              encodeJson({
                protocolVersion,
                requestId: "attach",
                command: { _tag: "AttachThread", threadId, afterCursor: "0" },
              }),
            )
            expect((yield* Queue.take(frames)).payload._tag).toBe("ThreadAttached")
            for (const command of [
              { _tag: "AcknowledgeCursor", threadId, cursor: String(cursor) },
              { _tag: "UpdatePresence", threadId, status: "viewing" },
              {
                _tag: "SubmitPrompt",
                threadId,
                commandId: "browser-mutation",
                idempotencyKey: "browser-mutation",
                expectedThreadVersion: "0",
                text: "must not execute",
              },
              {
                _tag: "ArchiveThread",
                threadId,
                commandId: "browser-archive",
                idempotencyKey: "browser-archive",
                expectedThreadVersion: "0",
              },
            ]) {
              socket.send(encodeJson({ protocolVersion, requestId: "denied", command }))
              expect((yield* Queue.take(frames)).payload).toMatchObject({
                _tag: "CommandRejected",
                reason: "forbidden",
              })
            }
            const append = () =>
              store.appendEvents({
                ownerId: authority.ownerId,
                threadId,
                events: [{ _tag: "ThreadViewSnapshot", snapshot: current.view }],
                createdAt: Timestamp.make(DateTime.formatIso(DateTime.nowUnsafe())),
              })
            yield* append()
            cursor++
            notifications.recover()
            expect((yield* Queue.take(frames)).payload).toMatchObject({
              _tag: "ThreadEvent",
              event: { cursor: String(cursor) },
            })
            yield* append()
            cursor++
            const compactAt = Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)))
            yield* store.saveSnapshot({
              ownerId: authority.ownerId,
              threadId,
              cursor: ThreadEventCursor.make(String(cursor)),
              threadVersion: ThreadVersion.make("0"),
              snapshot: current,
              createdAt: compactAt,
            })
            const deviceAuthority = yield* product.authorizeThread(principal(user.id), threadId, "thread:view")
            yield* store.acknowledgeCursor({
              ...deviceAuthority,
              threadId,
              cursor: ThreadEventCursor.make(String(cursor)),
              acknowledgedAt: compactAt,
            })
            notifications.recover()
            expect((yield* Queue.take(frames)).payload).toMatchObject({
              _tag: "ThreadSnapshot",
              cursor: String(cursor),
            })
            if (revoke === "logout")
              expect((yield* identity.handle(request("/api/auth/sign-out", {}, cookie))).status).toBe(200)
            else if (revoke === "expiry")
              yield* Effect.tryPromise(() =>
                pool.query("UPDATE session SET expires_at = $1 WHERE user_id = $2", [
                  DateTime.toDate(DateTime.makeUnsafe(0)),
                  user.id,
                ]),
              )
            else
              yield* Effect.tryPromise(() =>
                database.delete(identityMember).where(eq(identityMember.id, "browser-member")),
              )
            yield* append()
            cursor++
            notifications.recover()
            yield* TestClock.adjust("1 second")
            expect(yield* Deferred.await(closed)).toBe(1008)
            expect(yield* Queue.size(frames)).toBe(0)
            expect(
              (yield* Effect.result(
                store.replay({
                  ownerId: authority.ownerId,
                  threadId,
                  actor: { _tag: "BrowserRead", userId: "foreign-user" },
                  afterCursor: ThreadEventCursor.make("0"),
                  limit: 100,
                }),
              ))._tag,
            ).toBe("Failure")
            yield* TestClock.setTime(yield* TestClock.withLive(Clock.currentTimeMillis))
          }
        }),
      ),
    ),
  { timeout: 20000 },
)
