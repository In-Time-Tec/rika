import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Redacted, Scope } from "effect"
import type {
  CliDeviceDirectory,
  IdentityConfig,
  IdentityDirectory,
  IdentityRuntime,
} from "@rika/identity"
import type { HostedProductService } from "../src/hosted-product"
import type { Runtime as ExecutorRuntime } from "../src/executor"
import type { HttpDependencies } from "../src/http"
import { serveControlPlane } from "../src/adapters/bun-server"

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
      projects: () => Effect.die("unused"),
      createConnection: () => Effect.die("unused"),
      admitRun: () => Effect.die("unused"),
      completeRun: () => Effect.die("unused"),
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
    }
    const executor: ExecutorRuntime = {
      controller: undefined as never,
      gateway: { receive: () => Effect.void, disconnected: () => Effect.void, execute: () => Effect.die("unused") },
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
    const running = yield* serveControlPlane({ config, dependencies }).pipe(
      Effect.provideService(Scope.Scope, resourceScope),
    )
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
