import * as BunServices from "@effect/platform-bun/BunServices"
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import { OAuth } from "@batonfx/mcp"
import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer, Option, Redacted, Ref } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { McpOAuth } from "../src"
import { provideLayer } from "./layer"

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
      const context = yield* Layer.build(McpOAuth.hostLayer.pipe(Layer.provide(spawnerLayer(exitCode))))
      const host = Context.get(context, McpOAuth.Host)
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
        McpOAuth.browserCommand(platform, "https://example.test/authorize"),
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
        const context = yield* Layer.build(McpOAuth.tokenStoreLayer(filename))
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
        const context = yield* Layer.build(McpOAuth.tokenStoreLayer(filename))
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
    test.effect("hosts the real callback path, rejects other paths, and maps bind errors", () =>
      Effect.gen(function* () {
        const context = yield* Layer.build(McpOAuth.hostLayer)
        const host = Context.get(context, McpOAuth.Host)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const callback = yield* host.callback("http://127.0.0.1:17839/oauth/callback", "state")
            const client = yield* HttpClient.HttpClient
            expect((yield* client.execute(HttpClientRequest.get("http://127.0.0.1:17839/wrong"))).status).toBe(404)
            expect(
              (yield* client.execute(
                HttpClientRequest.get("http://127.0.0.1:17839/oauth/callback?code=wrong&state=attacker"),
              )).status,
            ).toBe(400)
            const response = yield* client.execute(
              HttpClientRequest.get("http://127.0.0.1:17839/oauth/callback?code=ok&state=state"),
            )
            expect(yield* response.text).toContain("Authentication complete")
            expect(yield* callback).toContain("code=ok")
          }),
        )
        yield* BunHttpServer.make({ hostname: "127.0.0.1", port: 17839 })
        const result = yield* Effect.result(host.callback("http://127.0.0.1:17839/oauth/callback", "state"))
        if (result._tag === "Success") return yield* Effect.die("Expected callback binding to fail")
        const error = result.failure
        expect(error.operation).toBe("callback")
        expect(error.message).not.toContain("secret")
      }),
    )
  })

  it.effect("reports status, logout, and host failures through the service boundary", () => {
    const store = OAuth.tokenStoreMemoryLayer
    const host = McpOAuth.hostTestLayer({
      open: () => Effect.fail(McpOAuth.Error.make({ server: "browser", operation: "open-browser", message: "denied" })),
      callback: () => Effect.succeed(Effect.succeed("unused")),
    })
    const serviceLayer = Layer.merge(McpOAuth.layer.pipe(Layer.provide(host), Layer.provide(store)), store)
    return Effect.gen(function* () {
      const context = yield* Layer.build(serviceLayer)
      yield* Effect.gen(function* () {
        const tokenStore = yield* OAuth.TokenStore
        yield* tokenStore.save("https://unused.test", Redacted.make("token"))
        const service = yield* McpOAuth.Service
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
      Layer.provide(McpOAuth.hostTestLayer({ open: () => Effect.void, callback: () => Effect.never })),
      Layer.provide(store),
    )
    return Effect.gen(function* () {
      const context = yield* Layer.build(serviceLayer)
      yield* Effect.gen(function* () {
        const service = yield* McpOAuth.Service
        const error = yield* Effect.flip(service.status("server", "https://example.test"))
        expect(error.message).toBe("OAuth status failed")
      }).pipe(Effect.provide(context))
    }).pipe(Effect.scoped)
  })

  it.effect("binds before opening, forwards only the bound state, and redacts provider failures", () =>
    Effect.gen(function* () {
      const events = yield* Ref.make<Array<string>>([])
      const host = McpOAuth.hostTestLayer({
        callback: (_url, state) =>
          Ref.update(events, (values) => [...values, `bound:${state}`]).pipe(
            Effect.as(Effect.succeed(`http://127.0.0.1:17839/oauth/callback?code=ok&state=${state}`)),
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
        Layer.provide(OAuth.tokenStoreMemoryLayer),
      )
      yield* provideLayer(
        Effect.flatMap(McpOAuth.Service, (service) => service.login("server", "https://provider.test/mcp")),
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
    const tokenStore = OAuth.tokenStoreMemoryLayer
    const host = McpOAuth.hostTestLayer({
      callback: (_url, state) => Effect.succeed(Effect.succeed(`http://localhost/?code=x&state=${state}`)),
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
          Effect.flatMap(McpOAuth.Service, (service) => service.login("server", "https://provider.test/mcp")),
          failure(OAuth.OAuthDeniedError.make({ reason: "provider-secret" })),
        ),
      )
      expect(denied.message).toBe("OAuth authorization was denied")
      expect(denied.message).not.toContain("provider-secret")
      const exchange = yield* Effect.flip(
        provideLayer(
          Effect.flatMap(McpOAuth.Service, (service) => service.login("server", "https://provider.test/mcp")),
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
