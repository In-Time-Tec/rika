import * as BunServices from "@effect/platform-bun/BunServices"
import { OAuth } from "tenetkit/mcp"
import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, FileSystem, Fiber, Layer, Option, Redacted, Ref } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import * as McpOAuth from "../../src/mcp/mcp-oauth-service"
import { provideLayer } from "../support/extension-test-layer"

const spawnerLayer = (exitCode: Ref.Ref<number>) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.ChildProcessSpawner.pipe(
      Effect.map((spawner) =>
        ChildProcessSpawner.make(() =>
          Ref.get(exitCode).pipe(
            Effect.flatMap((code) =>
              spawner.spawn(ChildProcess.make("sh", ["-c", `exit ${code}`], { stdout: "ignore", stderr: "ignore" })),
            ),
          ),
        ),
      ),
    ),
  ).pipe(Layer.provide(BunServices.layer))

describe("McpOAuth", () => {
  it.effect("opens the browser and maps command failures", () =>
    Effect.gen(function* () {
      const exitCode = yield* Ref.make(0)
      const context = yield* Layer.build(McpOAuth.OAuthHost.hostLayer.pipe(Layer.provide(spawnerLayer(exitCode))))
      const host = Context.get(context, McpOAuth.OAuthHost.Host)
      yield* host.open("https://example.test/authorize")
      yield* Ref.set(exitCode, 1)
      const error = yield* Effect.flip(host.open("https://example.test/authorize?state=browser-secret"))
      expect(error.operation).toBe("open-browser")
      expect(error.message).toBe("Unable to open the system browser")
      expect(Object.values(error).join(" ")).not.toContain("browser-secret")
      expect(error.server).toBe("system-browser")
    }),
  )

  it("selects the browser command for every supported platform", () => {
    expect(
      (["darwin", "win32", "linux"] as const).map((platform) =>
        McpOAuth.OAuthHost.browserCommand(platform, "https://example.test/authorize"),
      ),
    ).toEqual([
      { command: "open", args: ["https://example.test/authorize"] },
      { command: "cmd", args: ["/c", "start", "", "https://example.test/authorize"] },
      { command: "xdg-open", args: ["https://example.test/authorize"] },
    ])
  })

  it.layer(BunServices.layer)((test) => {
    test.effect("persists redacted tokens in a protected file and removes individual servers", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-oauth-" })
        const filename = `${root}/nested/tokens.json`
        const context = yield* Layer.build(McpOAuth.OAuthHost.tokenStoreLayer(filename))
        yield* Effect.gen(function* () {
          const store = yield* OAuth.TokenStore
          expect(Option.isNone(yield* store.load("one"))).toBe(true)
          yield* store.save("one", Redacted.make("secret-one"))
          yield* store.save("two", Redacted.make("secret-two"))
          const loaded = yield* store.load("one")
          expect(Option.isSome(loaded) && Redacted.value(loaded.value)).toBe("secret-one")
          expect((yield* fs.stat(filename)).mode & 0o777).toBe(0o600)
          expect(yield* fs.readFileString(filename)).toBe('{"one":"secret-one","two":"secret-two"}')
          expect(String(loaded)).not.toContain("secret-one")
          yield* store.remove("one")
          expect(Option.isNone(yield* store.load("one"))).toBe(true)
          expect(yield* fs.readFileString(filename)).toBe('{"two":"secret-two"}')
        }).pipe(Effect.provide(context))
      }).pipe(Effect.scoped),
    )

    test.effect("maps malformed and inaccessible token files to provider operations", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-oauth-errors-" })
        const filename = `${root}/tokens.json`
        const context = yield* Layer.build(McpOAuth.OAuthHost.tokenStoreLayer(filename))
        const run = <A, E>(effect: Effect.Effect<A, E, OAuth.TokenStore>) => effect.pipe(Effect.provide(context))
        yield* fs.writeFileString(filename, '{"access_token":"storage-secret"')
        yield* fs.chmod(filename, 0o644)
        const loadError = yield* Effect.flip(run(Effect.flatMap(OAuth.TokenStore, (store) => store.load("s"))))
        expect(loadError.operation).toBe("load")
        expect(loadError.message).not.toContain("storage-secret")
        expect((yield* fs.stat(filename)).mode & 0o777).toBe(0o600)
        expect(
          (yield* Effect.flip(run(Effect.flatMap(OAuth.TokenStore, (store) => store.save("s", Redacted.make("x"))))))
            .operation,
        ).toBe("save")
        expect(
          (yield* Effect.flip(run(Effect.flatMap(OAuth.TokenStore, (store) => store.remove("s"))))).operation,
        ).toBe("remove")
      }).pipe(Effect.scoped),
    )
  })

  it.layer(Layer.merge(FetchHttpClient.layer, BunServices.layer))((test) => {
    test.effect("binds concurrent real callbacks on distinct loopback ports with state and path checks", () =>
      Effect.gen(function* () {
        const context = yield* Layer.build(McpOAuth.OAuthHost.hostLayer)
        const host = Context.get(context, McpOAuth.OAuthHost.Host)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const first = yield* host.prepareCallback("/oauth/callback")
            const second = yield* host.prepareCallback("/oauth/callback")
            expect(first.redirectUrl).not.toBe(second.redirectUrl)
            const client = yield* HttpClient.HttpClient
            const firstUrl = new URL(first.redirectUrl)
            const secondUrl = new URL(second.redirectUrl)
            expect((yield* client.execute(HttpClientRequest.get(`${firstUrl.origin}/wrong`))).status).toBe(404)
            const firstWait = yield* Effect.forkChild(first.wait("first-state"))
            const secondWait = yield* Effect.forkChild(second.wait("second-state"))
            expect(
              (yield* client.execute(HttpClientRequest.get(`${first.redirectUrl}?code=wrong&state=attacker`))).status,
            ).toBe(400)
            const responses = yield* Effect.all(
              [
                client.execute(HttpClientRequest.get(`${first.redirectUrl}?code=one&state=first-state`)),
                client.execute(HttpClientRequest.get(`${second.redirectUrl}?code=two&state=second-state`)),
              ],
              { concurrency: 2 },
            )
            expect(yield* responses[0].text).toContain("Authentication complete")
            expect(yield* responses[1].text).toContain("Authentication complete")
            expect(yield* Fiber.join(firstWait)).toContain("code=one")
            expect(yield* Fiber.join(secondWait)).toContain("code=two")
            expect(firstUrl.port).not.toBe(secondUrl.port)
          }),
        )
      }),
    )
  })

  it.effect("reports status, logout, and host failures through the service boundary", () => {
    const store = OAuth.layerTokenStoreMemory
    const host = McpOAuth.OAuthHost.hostTestLayer({
      open: () =>
        Effect.fail(
          McpOAuth.OAuthHost.McpOAuthHostError.make({
            server: "browser",
            operation: "open-browser",
            message: "denied",
          }),
        ),
      prepareCallback: () =>
        Effect.succeed({ redirectUrl: "http://127.0.0.1:1/oauth/callback", wait: () => Effect.succeed("unused") }),
    })
    const serviceLayer = Layer.merge(
      McpOAuth.layer.pipe(Layer.provide(host), Layer.provide(store), Layer.provide(BunServices.layer)),
      store,
    )
    return Effect.gen(function* () {
      const context = yield* Layer.build(serviceLayer)
      yield* Effect.gen(function* () {
        const tokenStore = yield* OAuth.TokenStore
        yield* tokenStore.save("https://unused.test", Redacted.make("token"))
        const service = yield* McpOAuth.McpOAuthService
        expect(yield* service.status("server", "https://unused.test")).toBe("authenticated")
        yield* service.logout("server", "https://unused.test")
        expect(yield* service.status("server", "https://unused.test")).toBe("unauthenticated")
        const login = yield* Effect.flip(service.login("server", "not a url"))
        expect(login.operation).toBe("login")
        expect(login.message).not.toContain("token")
      }).pipe(Effect.provide(context))
    }).pipe(Effect.scoped)
  })

  it.effect("maps non-Error token store failures through the service boundary", () => {
    const store = Layer.succeed(
      OAuth.TokenStore,
      OAuth.TokenStore.of({
        load: () => Effect.fail("unavailable") as never,
        save: () => Effect.void,
        remove: () => Effect.void,
      }),
    )
    const serviceLayer = McpOAuth.layer.pipe(
      Layer.provide(
        McpOAuth.OAuthHost.hostTestLayer({
          open: () => Effect.void,
          prepareCallback: () => Effect.never,
        }),
      ),
      Layer.provide(store),
      Layer.provide(BunServices.layer),
    )
    return Effect.gen(function* () {
      const context = yield* Layer.build(serviceLayer)
      yield* Effect.gen(function* () {
        const service = yield* McpOAuth.McpOAuthService
        const error = yield* Effect.flip(service.status("server", "https://example.test"))
        expect(error.message).toBe("OAuth status failed")
      }).pipe(Effect.provide(context))
    }).pipe(Effect.scoped)
  })

  it.effect("binds before opening, forwards only the bound state, and redacts provider failures", () =>
    Effect.gen(function* () {
      const events = yield* Ref.make<Array<string>>([])
      const host = McpOAuth.OAuthHost.hostTestLayer({
        prepareCallback: () =>
          Ref.update(events, (values) => [...values, "bound:expected-state"]).pipe(
            Effect.as({
              redirectUrl: "http://127.0.0.1:1/oauth/callback",
              wait: (state: string) => Effect.succeed(`http://127.0.0.1:1/oauth/callback?code=ok&state=${state}`),
            }),
          ),
        open: (url) => Ref.update(events, (values) => [...values, `opened:${url}`]),
      })
      const client: McpOAuth.OAuthClient = {
        authorize: Effect.succeed({
          url: "https://provider.test/authorize?secret=browser-secret",
          state: "expected-state",
        }),
        callback: (url) =>
          Ref.update(events, (values) => [...values, `callback:${new URL(url).searchParams.get("state")}`]),
        clear: Effect.void,
      }
      const layer = McpOAuth.layerWithClient(() => Effect.succeed(client)).pipe(
        Layer.provide(host),
        Layer.provide(OAuth.layerTokenStoreMemory),
      )
      yield* provideLayer(
        Effect.flatMap(McpOAuth.McpOAuthService, (service) => service.login("server", "https://provider.test/mcp")),
        layer,
      )
      expect(yield* Ref.get(events)).toEqual([
        "bound:expected-state",
        "opened:https://provider.test/authorize?secret=browser-secret",
        "callback:expected-state",
      ])
    }),
  )

  it.effect("distinguishes provider denial and exchange failures without exposing provider details", () => {
    const tokenStore = OAuth.layerTokenStoreMemory
    const host = McpOAuth.OAuthHost.hostTestLayer({
      prepareCallback: () =>
        Effect.succeed({
          redirectUrl: "http://127.0.0.1:1/oauth/callback",
          wait: (state: string) => Effect.succeed(`http://localhost/?code=x&state=${state}`),
        }),
      open: () => Effect.void,
    })
    const failure = (cause: McpOAuth.OAuthClientError) =>
      McpOAuth.layerWithClient(() =>
        Effect.succeed({
          authorize: Effect.succeed({ url: "https://provider.test", state: "state" }),
          callback: () => Effect.fail(cause),
          clear: Effect.void,
        }),
      ).pipe(Layer.provide(host), Layer.provide(tokenStore))
    return Effect.gen(function* () {
      const denied = yield* Effect.flip(
        provideLayer(
          Effect.flatMap(McpOAuth.McpOAuthService, (service) => service.login("server", "https://provider.test/mcp")),
          failure(OAuth.OAuthDenied.make({ reason: "provider-secret" })),
        ),
      )
      expect(denied.message).toBe("OAuth authorization was denied")
      expect(denied.message).not.toContain("provider-secret")
      const exchange = yield* Effect.flip(
        provideLayer(
          Effect.flatMap(McpOAuth.McpOAuthService, (service) => service.login("server", "https://provider.test/mcp")),
          failure(
            OAuth.OAuthProviderError.make({
              server: "https://provider.test/mcp",
              operation: "exchange",
              message: "token-secret",
            }),
          ),
        ),
      )
      expect(exchange.message).toBe("OAuth exchange failed")
      expect(exchange.message).not.toContain("token-secret")
    })
  })
})
