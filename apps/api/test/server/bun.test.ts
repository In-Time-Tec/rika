import * as BunSocket from "@effect/platform-bun/BunSocket"
import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Layer, Redacted, Schema, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as Socket from "effect/unstable/socket/Socket"
import type { CliDeviceDirectory, IdentityConfig, IdentityDirectory, IdentityRuntime } from "@rika/identity"
import { ServerFrame } from "@rika/product/client-protocol"
import type { HostedProductService } from "../../src/hosted/product"
import type { Runtime as ExecutorRuntime } from "../../src/executor/service"
import type { HttpDependencies } from "../../src/server/http"
import { canonicalPublicRequest, pollAuthority, serveApi } from "../../src/server/bun"
import { testToolPolicy } from "../hosted/execution/tool-policy.fixture"

const config: IdentityConfig = {
  production: false,
  port: 0,
  baseUrl: "http://127.0.0.1",
  trustedOrigins: ["http://127.0.0.1"],
  authSecret: Redacted.make("abcdefghijklmnopqrstuvwxyz-0123456789-ABCDEF"),
  githubClientId: "test",
  githubClientSecret: Redacted.make("test"),
  resendApiKey: Redacted.make("test"),
  emailFrom: "test@example.test",
  resource: "http://127.0.0.1/api/v1",
  databaseUrl: Redacted.make("postgresql://unused"),
  databaseSsl: "disable",
}

const recovery: HttpDependencies["recovery"] = {
  inspect: () => Effect.die("unused"),
  resolve: () => Effect.die("unused"),
}

it.effect("stops accepting work but lets an in-flight request drain", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const product: HostedProductService = {
      ready: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      activatePrincipal: () => Effect.die("unused"),
      authorizeThread: () => Effect.die("unused"),
      threadExecutionContext: () => Effect.die("unused"),
      projects: () => Effect.die("unused"),
      createProject: () => Effect.die("unused"),
      registerRunner: () => Effect.die("unused"),
      setRemoteThreadCreation: () => Effect.die("unused"),
      pollRunner: () => Effect.die("unused"),
      createConnection: () => Effect.die("unused"),
      admitRun: () => Effect.die("unused"),
    }
    const identity: IdentityRuntime = {
      handle: () => Effect.die("unused"),
      identify: () => Effect.die("unused"),
      protectedResourceMetadata: Effect.die("unused"),
    }
    const directory: IdentityDirectory = {
      ready: Effect.void,
      account: () => Effect.die("unused"),
    }
    const devices: CliDeviceDirectory = {
      register: () => Effect.die("unused"),
      discard: () => Effect.die("unused"),
      authenticate: () => Effect.die("unused"),
      list: () => Effect.die("unused"),
      revoke: () => Effect.die("unused"),
      revokeAll: () => Effect.die("unused"),
    }
    const executor: ExecutorRuntime = {
      controller: undefined as never,
      gateway: {
        receive: () => Effect.void,
        disconnected: () => Effect.void,
        active: () => Effect.succeed(true),
        execute: () => Effect.die("unused"),
        cancel: () => Effect.void,
        machine: () => Effect.die("unused"),
        workspace: () => Effect.die("unused"),
        sendPty: () => Effect.die("unused"),
        ptyEvents: () => Stream.empty,
        retryPreparation: () => Effect.void,
        quiesce: () => Effect.die("unused"),
        pushBranch: () => Effect.die("unused"),
      },
      runnerGateway: {
        receive: () => Effect.void,
        disconnected: () => Effect.void,
        active: () => Effect.succeed(true),
        execute: () => Effect.die("unused"),
        cancel: () => Effect.void,
        machine: () => Effect.die("unused"),
      },
      admitRunner: () => Effect.die("unused"),
      admitRun: () => Effect.die("unused"),
      run: () => Effect.die("unused"),
      pause: () => Effect.die("unused"),
      resume: () => Effect.die("unused"),
      replace: () => Effect.die("unused"),
      ready: Effect.void,
    }
    const dependencies: HttpDependencies = {
      identity,
      directory,
      devices,
      product,
      recovery,
      toolPolicy: testToolPolicy,
      executor,
      execution: {
        check: Effect.succeed({ backend: "postgres", source: "test", workerId: "test" }),
        status: Effect.succeed({} as never),
      },
      production: false,
    }
    const resourceScope = yield* Scope.make()
    const running = yield* serveApi({ config, dependencies }).pipe(Effect.provideService(Scope.Scope, resourceScope))
    const request = yield* Effect.forkChild(
      Effect.tryPromise(() => Bun.fetch(`http://127.0.0.1:${running.server.port}/readyz`)),
    )
    yield* Deferred.await(entered)
    let closed = false
    const closing = yield* Effect.forkChild(
      Scope.close(resourceScope, Exit.void).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            closed = true
          }),
        ),
      ),
    )
    yield* Effect.yieldNow
    expect(closed).toBe(false)
    yield* Deferred.succeed(release, undefined)
    expect((yield* Fiber.join(request)).status).toBe(200)
    yield* Fiber.join(closing)
    expect(closed).toBe(true)
  }),
)

it.effect("canonicalizes public HTTPS requests from the configured origin instead of proxy headers", () =>
  Effect.gen(function* () {
    const request = new Request("http://127.0.0.1:3000/api/v1/auth/cli/registrations?proof=1", {
      method: "POST",
      headers: {
        authorization: "DPoP proof",
        host: "internal.railway.test",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "http",
      },
      body: "request-body",
    })
    const canonical = canonicalPublicRequest({ request, baseUrl: "https://api.example.test" })
    expect(canonical.url).toBe("https://api.example.test/api/v1/auth/cli/registrations?proof=1")
    expect(canonical.method).toBe("POST")
    expect(canonical.headers.get("authorization")).toBe("DPoP proof")
    expect(canonical.headers.get("host")).toBe("api.example.test")
    expect(canonical.headers.get("x-forwarded-host")).toBeNull()
    expect(canonical.headers.get("x-forwarded-proto")).toBeNull()
    expect(yield* Effect.tryPromise(() => canonical.text())).toBe("request-body")
  }),
)

it.effect("serves auth requests with the configured public HTTPS URL behind Railway TLS termination", () =>
  Effect.gen(function* () {
    let handledUrl = ""
    const identity: IdentityRuntime = {
      handle: (request) =>
        Effect.sync(() => {
          handledUrl = request.url
          return new Response("ok")
        }),
      identify: () => Effect.die("unused"),
      protectedResourceMetadata: Effect.die("unused"),
    }
    const dependencies: HttpDependencies = {
      identity,
      directory: { ready: Effect.void, account: () => Effect.die("unused") },
      devices: {
        register: () => Effect.die("unused"),
        discard: () => Effect.die("unused"),
        authenticate: () => Effect.die("unused"),
        list: () => Effect.die("unused"),
        revoke: () => Effect.die("unused"),
        revokeAll: () => Effect.die("unused"),
      },
      product: {
        ready: Effect.void,
        activatePrincipal: () => Effect.die("unused"),
        authorizeThread: () => Effect.die("unused"),
        threadExecutionContext: () => Effect.die("unused"),
        projects: () => Effect.die("unused"),
        createProject: () => Effect.die("unused"),
        registerRunner: () => Effect.die("unused"),
        setRemoteThreadCreation: () => Effect.die("unused"),
        pollRunner: () => Effect.die("unused"),
        createConnection: () => Effect.die("unused"),
        admitRun: () => Effect.die("unused"),
      },
      toolPolicy: testToolPolicy,
      executor: {
        controller: undefined as never,
        gateway: {
          receive: () => Effect.void,
          disconnected: () => Effect.void,
          active: () => Effect.succeed(true),
          execute: () => Effect.die("unused"),
          cancel: () => Effect.void,
          machine: () => Effect.die("unused"),
          workspace: () => Effect.die("unused"),
          sendPty: () => Effect.die("unused"),
          ptyEvents: () => Stream.empty,
          retryPreparation: () => Effect.void,
          quiesce: () => Effect.die("unused"),
          pushBranch: () => Effect.die("unused"),
        },
        runnerGateway: {
          receive: () => Effect.void,
          disconnected: () => Effect.void,
          active: () => Effect.succeed(true),
          execute: () => Effect.die("unused"),
          cancel: () => Effect.void,
          machine: () => Effect.die("unused"),
        },
        admitRunner: () => Effect.die("unused"),
        admitRun: () => Effect.die("unused"),
        run: () => Effect.die("unused"),
        pause: () => Effect.die("unused"),
        resume: () => Effect.die("unused"),
        replace: () => Effect.die("unused"),
        ready: Effect.void,
      },
      recovery,
      execution: {
        check: Effect.succeed({ backend: "postgres", source: "test", workerId: "test" }),
        status: Effect.succeed({} as never),
      },
      production: true,
    }
    const resourceScope = yield* Scope.make()
    const running = yield* serveApi({
      config: {
        ...config,
        production: true,
        baseUrl: "https://api.example.test",
        trustedOrigins: ["https://api.example.test"],
        resource: "https://api.example.test/api/v1",
      },
      dependencies,
    }).pipe(Effect.provideService(Scope.Scope, resourceScope))
    const response = yield* Effect.tryPromise(() =>
      Bun.fetch(`http://127.0.0.1:${running.server.port}/api/auth/session?proof=1`, {
        headers: { "x-forwarded-host": "attacker.example", "x-forwarded-proto": "http" },
      }),
    )
    yield* Scope.close(resourceScope, Exit.void)
    expect(response.status).toBe(200)
    expect(handledUrl).toBe("https://api.example.test/api/auth/session?proof=1")
  }),
)

it.effect("closes inactive sessions with a policy violation on the authority schedule", () =>
  Effect.gen(function* () {
    let active = true
    const closed: Array<readonly [number | undefined, string | undefined]> = []
    const polling = yield* pollAuthority(
      new Set([
        {
          validate: () => Effect.sync(() => active),
          close: (code?: number, reason?: string) => closed.push([code, reason]),
        },
      ]),
    ).pipe(Effect.forkChild)
    yield* TestClock.adjust("99 millis")
    expect(closed).toEqual([])
    active = false
    yield* TestClock.adjust("1 millis")
    expect(closed).toEqual([[1008, "authority revoked"]])
    yield* Fiber.interrupt(polling)
  }),
)

it.effect("redeems a Thread ticket from the WebSocket subprotocol and exchanges canonical frames", () =>
  Effect.gen(function* () {
    let connected: ReadonlyArray<string> | undefined
    let received: unknown
    const dependencies: HttpDependencies = {
      identity: {
        handle: () => Effect.die("unused"),
        identify: () => Effect.die("unused"),
        protectedResourceMetadata: Effect.die("unused"),
      },
      directory: { ready: Effect.void, account: () => Effect.die("unused") },
      devices: {
        register: () => Effect.die("unused"),
        discard: () => Effect.die("unused"),
        authenticate: () => Effect.die("unused"),
        list: () => Effect.die("unused"),
        revoke: () => Effect.die("unused"),
        revokeAll: () => Effect.die("unused"),
      },
      product: {
        ready: Effect.void,
        activatePrincipal: () => Effect.die("unused"),
        authorizeThread: () => Effect.die("unused"),
        threadExecutionContext: () => Effect.die("unused"),
        projects: () => Effect.die("unused"),
        createProject: () => Effect.die("unused"),
        registerRunner: () => Effect.die("unused"),
        setRemoteThreadCreation: () => Effect.die("unused"),
        pollRunner: () => Effect.die("unused"),
        createConnection: () => Effect.die("unused"),
        admitRun: () => Effect.die("unused"),
      },
      toolPolicy: testToolPolicy,
      threads: {
        issueTicket: () => Effect.die("unused"),
        connect: (ticket, audience) => {
          connected = [ticket, audience]
          return Effect.succeed({
            receive: (message) => {
              received = message
              return Effect.succeed([
                {
                  protocolVersion: 1 as const,
                  payload: { _tag: "Heartbeat" as const, at: "2026-08-21T00:00:00.000Z" as never },
                },
              ])
            },
            detach: Effect.void,
            active: Effect.succeed(true),
          })
        },
      },
      executor: {
        controller: undefined as never,
        gateway: {
          receive: () => Effect.void,
          disconnected: () => Effect.void,
          active: () => Effect.succeed(true),
          execute: () => Effect.die("unused"),
          cancel: () => Effect.void,
          machine: () => Effect.die("unused"),
          workspace: () => Effect.die("unused"),
          sendPty: () => Effect.die("unused"),
          ptyEvents: () => Stream.empty,
          retryPreparation: () => Effect.void,
          quiesce: () => Effect.die("unused"),
          pushBranch: () => Effect.die("unused"),
        },
        runnerGateway: {
          receive: () => Effect.void,
          disconnected: () => Effect.void,
          active: () => Effect.succeed(true),
          execute: () => Effect.die("unused"),
          cancel: () => Effect.void,
          machine: () => Effect.die("unused"),
        },
        admitRunner: () => Effect.die("unused"),
        admitRun: () => Effect.die("unused"),
        run: () => Effect.die("unused"),
        pause: () => Effect.die("unused"),
        resume: () => Effect.die("unused"),
        replace: () => Effect.die("unused"),
        ready: Effect.void,
      },
      recovery,
      execution: {
        check: Effect.succeed({ backend: "postgres", source: "test", workerId: "test" }),
        status: Effect.succeed({} as never),
      },
      production: false,
    }
    const resourceScope = yield* Scope.make()
    const running = yield* serveApi({ config, dependencies }).pipe(Effect.provideService(Scope.Scope, resourceScope))
    const baseUrl = `http://127.0.0.1:${running.server.port}`
    const queryCredential = yield* Effect.tryPromise(() => Bun.fetch(`${baseUrl}/api/v1/threads/socket?ticket=secret`))
    expect(queryCredential.status).toBe(401)

    const reply = yield* Effect.scoped(
      Layer.build(BunSocket.layerWebSocketConstructor).pipe(
        Effect.flatMap((context) =>
          Effect.provide(
            Effect.gen(function* () {
              const socket = yield* Socket.makeWebSocket(`${baseUrl.replace("http:", "ws:")}/api/v1/threads/socket`, {
                protocols: ["rika.thread.v1", "rika.ticket.secret"],
              })
              const writer = yield* socket.writer
              const response = yield* Deferred.make<string>()
              yield* socket
                .runString((message) => Deferred.succeed(response, message), {
                  onOpen: writer(
                    '{"protocolVersion":1,"requestId":"request-1","command":{"_tag":"Detach"}}',
                  ).pipe(Effect.orDie),
                })
                .pipe(Effect.forkScoped)
              return yield* Deferred.await(response)
            }),
            context,
          ),
        ),
      ),
    )
    yield* Effect.tryPromise(() => running.server.stop(true))
    yield* Scope.close(resourceScope, Exit.void)
    expect(connected).toEqual(["secret", "/api/v1/threads/socket"])
    expect(received).toEqual({ protocolVersion: 1, requestId: "request-1", command: { _tag: "Detach" } })
    expect(yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ServerFrame))(reply)).toEqual({
      protocolVersion: 1,
      payload: { _tag: "Heartbeat", at: "2026-08-21T00:00:00.000Z" },
    })
  }),
)
