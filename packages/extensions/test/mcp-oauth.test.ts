import * as BunServices from "@effect/platform-bun/BunServices"
import { OAuth } from "@batonfx/mcp"
import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Fiber, FileSystem, Layer, Option, Redacted } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { McpOAuth } from "../src"

describe("McpOAuth", () => {
  it.effect("opens the browser and maps command failures", () =>
    Effect.gen(function* () {
      const original = Bun.spawn
      yield* Effect.acquireRelease(
        Effect.sync(() => Object.assign(Bun, { spawn: () => original(["sh", "-c", "exit 0"]) })),
        () => Effect.sync(() => Object.assign(Bun, { spawn: original })),
      )
      const context = yield* Layer.build(McpOAuth.hostLayer)
      const host = Context.get(context, McpOAuth.Host)
      yield* host.open("https://example.test/authorize")
      Object.assign(Bun, { spawn: () => original(["sh", "-c", "exit 1"]) })
      const error = yield* Effect.flip(host.open("https://example.test/authorize"))
      expect(error.operation).toBe("open-browser")
    }),
  )

  it.effect("selects the browser command for every supported platform", () =>
    Effect.gen(function* () {
      const originalSpawn = Bun.spawn
      const originalPlatform = process.platform
      const commands: Array<Array<string>> = []
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          Object.assign(Bun, {
            spawn: (command: Array<string>) => {
              commands.push(command)
              return originalSpawn(["sh", "-c", "exit 0"])
            },
          }),
        ),
        () =>
          Effect.sync(() => {
            Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true })
            Object.assign(Bun, { spawn: originalSpawn })
          }),
      )
      const context = yield* Layer.build(McpOAuth.hostLayer)
      const host = Context.get(context, McpOAuth.Host)
      yield* Effect.forEach(["darwin", "win32", "linux"], (platform) =>
        Effect.sync(() => {
          Object.defineProperty(process, "platform", { value: platform, configurable: true })
        }).pipe(Effect.andThen(host.open("https://example.test/authorize"))),
      )
      expect(commands).toEqual([
        ["open", "https://example.test/authorize"],
        ["cmd", "/c", "start", "", "https://example.test/authorize"],
        ["xdg-open", "https://example.test/authorize"],
      ])
    }),
  )

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
        yield* fs.writeFileString(filename, "{")
        expect((yield* Effect.flip(run(Effect.flatMap(OAuth.TokenStore, (store) => store.load("s"))))).operation).toBe(
          "load",
        )
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

  it.layer(FetchHttpClient.layer)((test) => {
    test.effect("hosts the real callback path, rejects other paths, and maps bind errors", () =>
      Effect.gen(function* () {
        const context = yield* Layer.build(McpOAuth.hostLayer)
        const host = Context.get(context, McpOAuth.Host)
        const callback = yield* Effect.forkScoped(host.callback("http://127.0.0.1:17839/oauth/callback"))
        yield* Effect.yieldNow
        const client = yield* HttpClient.HttpClient
        expect((yield* client.execute(HttpClientRequest.get("http://127.0.0.1:17839/wrong"))).status).toBe(404)
        const response = yield* client.execute(
          HttpClientRequest.get("http://127.0.0.1:17839/oauth/callback?code=ok&state=state"),
        )
        expect(yield* response.text).toContain("Authentication complete")
        expect(yield* Fiber.join(callback)).toContain("code=ok")
        const occupied = Bun.serve({ hostname: "127.0.0.1", port: 17839, fetch: () => new Response() })
        const error = yield* Effect.flip(host.callback("http://127.0.0.1:17839/oauth/callback"))
        occupied.stop()
        expect(error.operation).toBe("callback")
        expect(error.message).not.toContain("secret")
      }),
    )
  })

  it.effect("reports status, logout, and host failures through the service boundary", () => {
    const store = OAuth.tokenStoreMemoryLayer
    const host = McpOAuth.hostTestLayer({
      open: () => Effect.fail(McpOAuth.Error.make({ server: "browser", operation: "open-browser", message: "denied" })),
      callback: () => Effect.succeed("unused"),
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
        expect(error.message).toBe("unavailable")
      }).pipe(Effect.provide(context))
    }).pipe(Effect.scoped)
  })
})
