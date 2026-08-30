import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Redacted, Scope, Stream } from "effect"
import type { CliDeviceDirectory, IdentityConfig, IdentityDirectory, IdentityRuntime } from "@rika/identity"
import type { Interface as ControllerService } from "@rika/e2b-executor/controller"
import type { HostedProductService } from "../../src/hosted/product"
import type { Runtime as ExecutorRuntime } from "../../src/executor/service"
import type { HttpDependencies } from "../../src/server/http"
import { canonicalPublicRequest, serveApi } from "../../src/server/bun"
import { testToolPolicy } from "../hosted/execution/tool-policy.fixture"
import "./bun/sessions.harness"

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

const unusedController: ControllerService = {
  provision: () => Effect.die("unused"),
  replace: () => Effect.die("unused"),
  resume: () => Effect.die("unused"),
  pause: () => Effect.die("unused"),
  kill: () => Effect.die("unused"),
  portal: () => Effect.die("unused"),
  hello: () => Effect.die("unused"),
  reconnect: () => Effect.die("unused"),
  validateAccess: () => Effect.die("unused"),
  heartbeat: () => Effect.die("unused"),
  checkpoint: () => Effect.die("unused"),
  credential: () => Effect.die("unused"),
  revokeCredential: () => Effect.die("unused"),
  workspace: () => Effect.die("unused"),
  ready: () => Effect.die("unused"),
  loadSetupCache: () => Effect.die("unused"),
  storeSetupCache: () => Effect.die("unused"),
  activatePhase: () => Effect.die("unused"),
  cleanupOrphans: Effect.die("unused"),
}

it.effect("stops accepting work but lets an in-flight request drain", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const product: HostedProductService = {
      ready: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      activatePrincipal: () => Effect.die("unused"),
      authorizeOwner: () => Effect.die("unused"),
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
      controller: unusedController,
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
        check: Effect.succeed({
          backend: "postgres",
          source: "test",
          workerId: "test",
        }),
        status: Effect.succeed({
          scan: { _tag: "Starting" },
          wakeup: { _tag: "Starting" },
          lastFallbackAt: undefined,
          lastFailure: undefined,
          active: 0,
          capacity: 1,
          oldestClaimAt: undefined,
          scanAgeMillis: undefined,
          wakeupAgeMillis: undefined,
          lastFallbackAgeMillis: undefined,
          oldestClaimAgeMillis: undefined,
          lastFailureAgeMillis: undefined,
          availableCapacity: 1,
          execution: { worker: "execution" },
          turn: {
            worker: "turn",
            active: 0,
            capacity: 1,
            oldestClaimAgeMillis: undefined,
          },
          projection: {
            worker: "projection",
            active: 0,
            capacity: 1,
            oldestActiveProjectionAgeMillis: undefined,
          },
        }),
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
        "x-rika-client-ip": "203.0.113.40",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "http",
      },
      body: "request-body",
    })
    const canonical = canonicalPublicRequest({
      request,
      baseUrl: "https://api.example.test",
    })
    expect(canonical.url).toBe("https://api.example.test/api/v1/auth/cli/registrations?proof=1")
    expect(canonical.method).toBe("POST")
    expect(canonical.headers.get("authorization")).toBe("DPoP proof")
    expect(canonical.headers.get("host")).toBe("api.example.test")
    expect(canonical.headers.get("x-rika-client-ip")).toBe("203.0.113.40")
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
        authorizeOwner: () => Effect.die("unused"),
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
        controller: unusedController,
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
        check: Effect.succeed({
          backend: "postgres",
          source: "test",
          workerId: "test",
        }),
        status: Effect.die("unused"),
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
        headers: {
          "x-forwarded-host": "attacker.example",
          "x-forwarded-proto": "http",
        },
      }),
    )
    yield* Scope.close(resourceScope, Exit.void)
    expect(response.status).toBe(200)
    expect(handledUrl).toBe("https://api.example.test/api/auth/session?proof=1")
  }),
)
