import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Redacted, Schema, Scope } from "effect"
import type { CliDeviceDirectory, IdentityConfig, IdentityDirectory, IdentityRuntime } from "@rika/identity"
import { ServerFrame } from "@rika/product/client-protocol"
import type { HostedProductService } from "../src/hosted-product"
import type { Runtime as ExecutorRuntime } from "../src/executor"
import type { HttpDependencies } from "../src/http"
import { canonicalPublicRequest, serveApi } from "../src/adapters/bun-server"

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

it.effect("stops accepting work but lets an in-flight request drain", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const product: HostedProductService = {
      ready: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      activatePrincipal: () => Effect.die("unused"),
      authorizeThread: () => Effect.die("unused"),
      projects: () => Effect.die("unused"),
      registerLocalRunner: () => Effect.die("unused"),
      setRemoteThreadCreation: () => Effect.die("unused"),
      pollLocalRunner: () => Effect.die("unused"),
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
        execute: () => Effect.die("unused"),
        cancel: () => Effect.void,
        machine: () => Effect.die("unused"),
      },
      localGateway: {
        receive: () => Effect.void,
        disconnected: () => Effect.void,
        execute: () => Effect.die("unused"),
        cancel: () => Effect.void,
        machine: () => Effect.die("unused"),
      },
      admitLocal: () => Effect.die("unused"),
      run: () => Effect.die("unused"),
      ready: Effect.void,
    }
    const dependencies: HttpDependencies = {
      identity,
      directory,
      devices,
      product,
      executor,
      execution: {
        check: Effect.succeed({ backend: "postgres", source: "test", workerId: "test" }),
      },
      production: false,
    }
    const resourceScope = yield* Scope.make()
    const running = yield* serveApi({ config, dependencies }).pipe(Effect.provideService(Scope.Scope, resourceScope))
    const request = yield* Effect.forkChild(
      Effect.promise(() => Bun.fetch(`http://127.0.0.1:${running.server.port}/readyz`)),
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
    expect(yield* Effect.promise(() => canonical.text())).toBe("request-body")
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
        projects: () => Effect.die("unused"),
        registerLocalRunner: () => Effect.die("unused"),
        setRemoteThreadCreation: () => Effect.die("unused"),
        pollLocalRunner: () => Effect.die("unused"),
        createConnection: () => Effect.die("unused"),
        admitRun: () => Effect.die("unused"),
      },
      executor: {
        controller: undefined as never,
        gateway: {
          receive: () => Effect.void,
          disconnected: () => Effect.void,
          execute: () => Effect.die("unused"),
          cancel: () => Effect.void,
          machine: () => Effect.die("unused"),
        },
        localGateway: {
          receive: () => Effect.void,
          disconnected: () => Effect.void,
          execute: () => Effect.die("unused"),
          cancel: () => Effect.void,
          machine: () => Effect.die("unused"),
        },
        admitLocal: () => Effect.die("unused"),
        run: () => Effect.die("unused"),
        ready: Effect.void,
      },
      execution: { check: Effect.succeed({ backend: "postgres", source: "test", workerId: "test" }) },
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
    const response = yield* Effect.promise(() =>
      Bun.fetch(`http://127.0.0.1:${running.server.port}/api/auth/session?proof=1`, {
        headers: { "x-forwarded-host": "attacker.example", "x-forwarded-proto": "http" },
      }),
    )
    yield* Scope.close(resourceScope, Exit.void)
    expect(response.status).toBe(200)
    expect(handledUrl).toBe("https://api.example.test/api/auth/session?proof=1")
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
        projects: () => Effect.die("unused"),
        registerLocalRunner: () => Effect.die("unused"),
        setRemoteThreadCreation: () => Effect.die("unused"),
        pollLocalRunner: () => Effect.die("unused"),
        createConnection: () => Effect.die("unused"),
        admitRun: () => Effect.die("unused"),
      },
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
          })
        },
      },
      executor: {
        controller: undefined as never,
        gateway: {
          receive: () => Effect.void,
          disconnected: () => Effect.void,
          execute: () => Effect.die("unused"),
          cancel: () => Effect.void,
          machine: () => Effect.die("unused"),
        },
        localGateway: {
          receive: () => Effect.void,
          disconnected: () => Effect.void,
          execute: () => Effect.die("unused"),
          cancel: () => Effect.void,
          machine: () => Effect.die("unused"),
        },
        admitLocal: () => Effect.die("unused"),
        run: () => Effect.die("unused"),
        ready: Effect.void,
      },
      execution: { check: Effect.succeed({ backend: "postgres", source: "test", workerId: "test" }) },
      production: false,
    }
    const resourceScope = yield* Scope.make()
    const running = yield* serveApi({ config, dependencies }).pipe(Effect.provideService(Scope.Scope, resourceScope))
    const baseUrl = `http://127.0.0.1:${running.server.port}`
    const queryCredential = yield* Effect.promise(() => Bun.fetch(`${baseUrl}/api/v1/threads/socket?ticket=secret`))
    expect(queryCredential.status).toBe(401)

    const reply = yield* Effect.callback<string>((resume) => {
      const socket = new WebSocket(`${baseUrl.replace("http:", "ws:")}/api/v1/threads/socket`, [
        "rika.thread.v1",
        "rika.ticket.secret",
      ])
      socket.onopen = () => socket.send('{"protocolVersion":1,"requestId":"request-1","command":{"_tag":"Detach"}}')
      socket.onmessage = (event) => resume(Effect.succeed(String(event.data)))
      socket.onerror = () => resume(Effect.die("Thread WebSocket failed"))
      return Effect.sync(() => socket.close())
    })
    yield* Effect.promise(() => running.server.stop(true))
    yield* Scope.close(resourceScope, Exit.void)
    expect(connected).toEqual(["secret", "/api/v1/threads/socket"])
    expect(received).toEqual({ protocolVersion: 1, requestId: "request-1", command: { _tag: "Detach" } })
    expect(yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ServerFrame))(reply)).toEqual({
      protocolVersion: 1,
      payload: { _tag: "Heartbeat", at: "2026-08-21T00:00:00.000Z" },
    })
  }),
)
