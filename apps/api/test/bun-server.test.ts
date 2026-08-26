import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Layer, Redacted, Schema, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as Socket from "effect/unstable/socket/Socket"
import type { CliDeviceDirectory, IdentityConfig, IdentityDirectory, IdentityRuntime } from "@rika/identity"
import { ServerFrame } from "@rika/product/client-protocol"
import type { HostedProductService } from "../src/hosted-product"
import type { Runtime as ExecutorRuntime } from "../src/executor"
import type { HttpDependencies } from "../src/http"
import { canonicalPublicRequest, pollAuthority, sendThreadFrames, serveApi } from "../src/adapters/bun-server"
import { testToolPolicy } from "./hosted-tool-policy-fixture"

const config: IdentityConfig = {
  production: false,
  port: 0,
  baseUrl: "http://127.0.0.1",
  trustedOrigins: ["http://127.0.0.1"],
  authSecret: Redacted.make("abcdefghijklmnopqrstuvwxyz-0123456789-ABCDEF"),
  github: { clientId: "test", clientSecret: Redacted.make("test") },
  mail: { resendApiKey: Redacted.make("test"), emailFrom: "test@example.test" },
  resource: "http://127.0.0.1/api/v1",
  databaseUrl: Redacted.make("postgresql://unused"),
  databaseSsl: "disable",
}

const recovery: HttpDependencies["recovery"] = {
  inspect: () => Effect.die("unused"),
  resolve: () => Effect.die("unused"),
  reconcileCompleted: Effect.die("unused"),
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
      admitAuthorizedRun: () => Effect.die("unused"),
      cancelRunAdmission: () => Effect.die("unused"),
      cancelAuthorizedRunAdmission: () => Effect.die("unused"),
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
        cancel: () => Effect.die("unused"),
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
        cancel: () => Effect.die("unused"),
        machine: () => Effect.die("unused"),
      },
      admitRunner: () => Effect.die("unused"),
      admitRun: () => Effect.die("unused"),
      run: () => Effect.die("unused"),
      cancel: () => Effect.die("unused"),
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
        admitAuthorizedRun: () => Effect.die("unused"),
        cancelRunAdmission: () => Effect.die("unused"),
        cancelAuthorizedRunAdmission: () => Effect.die("unused"),
      },
      toolPolicy: testToolPolicy,
      executor: {
        controller: undefined as never,
        gateway: {
          receive: () => Effect.void,
          disconnected: () => Effect.void,
          active: () => Effect.succeed(true),
          execute: () => Effect.die("unused"),
          cancel: () => Effect.die("unused"),
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
          cancel: () => Effect.die("unused"),
          machine: () => Effect.die("unused"),
        },
        admitRunner: () => Effect.die("unused"),
        admitRun: () => Effect.die("unused"),
        run: () => Effect.die("unused"),
        cancel: () => Effect.die("unused"),
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

it.effect("closes a slow Thread consumer before buffering another frame", () =>
  Effect.gen(function* () {
    const sent: Array<string> = []
    const closed: Array<readonly [number | undefined, string | undefined]> = []
    const socket = {
      getBufferedAmount: () => 32 * 1024 * 1024,
      send: (message: string) => sent.push(message),
      close: (code?: number, reason?: string) => closed.push([code, reason]),
    }
    yield* sendThreadFrames(socket as never, [
      {
        protocolVersion: 1,
        payload: { _tag: "Heartbeat", at: "2026-08-21T00:00:00.000Z" as never },
      },
    ])
    expect(sent).toEqual([])
    expect(closed).toEqual([[1013, "slow Thread consumer"]])
  }),
)

it.effect("exchanges canonical Thread frames and finishes accepted commands after socket disconnect", () =>
  Effect.gen(function* () {
    let connected: ReadonlyArray<string> | undefined
    let received: unknown
    let receiveStartedAfterOutboundStopped = false
    const outboundStarted = yield* Deferred.make<void>()
    const outboundStopped = yield* Deferred.make<void>()
    const detachedReceiveEntered = yield* Deferred.make<void>()
    const releaseDetachedReceive = yield* Deferred.make<void>()
    const detachedReceiveCompleted = yield* Deferred.make<void>()
    let connectionCount = 0
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
        admitAuthorizedRun: () => Effect.die("unused"),
        cancelRunAdmission: () => Effect.die("unused"),
        cancelAuthorizedRunAdmission: () => Effect.die("unused"),
      },
      toolPolicy: testToolPolicy,
      threads: {
        issueTicket: () => Effect.die("unused"),
        connect: (ticket, audience) => {
          connected = [ticket, audience]
          connectionCount += 1
          if (connectionCount === 2)
            return Effect.succeed({
              receive: () =>
                Deferred.succeed(detachedReceiveEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseDetachedReceive)),
                  Effect.andThen(Deferred.succeed(detachedReceiveCompleted, undefined)),
                  Effect.as([]),
                ),
              outbound: Effect.never,
              detach: Effect.void,
              active: Effect.succeed(true),
            })
          return Effect.succeed({
            receive: (message) =>
              Deferred.isDone(outboundStopped).pipe(
                Effect.tap((stopped) =>
                  Effect.sync(() => {
                    received = message
                    receiveStartedAfterOutboundStopped = stopped
                  }),
                ),
                Effect.as([
                  {
                    protocolVersion: 1 as const,
                    payload: { _tag: "Heartbeat" as const, at: "2026-08-21T00:00:00.000Z" as never },
                  },
                ]),
              ),
            outbound: Deferred.succeed(outboundStarted, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(outboundStopped, undefined)),
            ),
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
          cancel: () => Effect.die("unused"),
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
          cancel: () => Effect.die("unused"),
          machine: () => Effect.die("unused"),
        },
        admitRunner: () => Effect.die("unused"),
        admitRun: () => Effect.die("unused"),
        run: () => Effect.die("unused"),
        cancel: () => Effect.die("unused"),
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
      Layer.build(Socket.layerWebSocketConstructorGlobal).pipe(
        Effect.flatMap((context) =>
          Effect.provide(
            Effect.gen(function* () {
              const socket = yield* Socket.makeWebSocket(`${baseUrl.replace("http:", "ws:")}/api/v1/threads/socket`, {
                protocols: ["rika.thread.v1", "rika.ticket.secret"],
              })
              const writer = yield* socket.writer
              const opened = yield* Deferred.make<void>()
              const response = yield* Deferred.make<string>()
              yield* socket
                .runString((message) => Deferred.succeed(response, message), {
                  onOpen: Deferred.succeed(opened, undefined),
                })
                .pipe(Effect.forkScoped)
              yield* Deferred.await(opened)
              yield* Deferred.await(outboundStarted)
              yield* writer('{"protocolVersion":1,"requestId":"request-1","command":{"_tag":"Detach"}}')
              return yield* Deferred.await(response)
            }),
            context,
          ),
        ),
      ),
    )
    const detachedSocket = new WebSocket(`${baseUrl.replace("http:", "ws:")}/api/v1/threads/socket`, [
      "rika.thread.v1",
      "rika.ticket.secret",
    ])
    yield* Effect.callback<void, "detached socket failed">((resume) => {
      detachedSocket.onopen = () => resume(Effect.void)
      detachedSocket.onerror = () => resume(Effect.fail("detached socket failed"))
    })
    detachedSocket.send('{"protocolVersion":1,"requestId":"request-detached","command":{"_tag":"Detach"}}')
    yield* Deferred.await(detachedReceiveEntered)
    const detachedClosed = Effect.callback<void>((resume) => {
      detachedSocket.onclose = () => resume(Effect.void)
      detachedSocket.close()
    })
    yield* detachedClosed
    yield* Deferred.succeed(releaseDetachedReceive, undefined)
    yield* Deferred.await(detachedReceiveCompleted)
    yield* Effect.tryPromise(() => running.server.stop(true))
    yield* Scope.close(resourceScope, Exit.void)
    expect(connected).toEqual(["secret", "/api/v1/threads/socket"])
    expect(received).toEqual({ protocolVersion: 1, requestId: "request-1", command: { _tag: "Detach" } })
    expect(receiveStartedAfterOutboundStopped).toBe(true)
    expect(yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ServerFrame))(reply)).toEqual({
      protocolVersion: 1,
      payload: { _tag: "Heartbeat", at: "2026-08-21T00:00:00.000Z" },
    })
  }),
)
