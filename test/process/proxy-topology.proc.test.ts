import { BunHttpServer, BunSocket } from "@effect/platform-bun"
import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, test } from "vitest"
import { Clock, Deferred, Effect, Exit, Layer, Schema, Scope, Stream } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Socket } from "effect/unstable/socket"

const root = process.cwd()

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) => Stream.mkString(Stream.decodeText(stream))

class CommandFailure extends Schema.TaggedError<CommandFailure>()("CommandFailure", {
  command: Schema.String,
  detail: Schema.String,
}) {}

class ProxyNotReady extends Schema.TaggedError<ProxyNotReady>()("ProxyNotReady", {}) {}

class WebSocketTimeout extends Schema.TaggedError<WebSocketTimeout>()("WebSocketTimeout", {}) {}

const command = Effect.fn("ProxyTopology.command")(function* (
  executable: string,
  args: ReadonlyArray<string>,
  timeout = 30_000,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const child = yield* spawner.spawn(ChildProcess.make(executable, args, { cwd: root, stdout: "pipe", stderr: "pipe" }))
  return yield* Effect.all([child.exitCode, collect(child.stdout), collect(child.stderr)], { concurrency: 3 }).pipe(
    Effect.map(([exitCode, stdout, stderr]) => ({ exitCode: Number(exitCode), stdout, stderr })),
    Effect.timeout(timeout),
    Effect.catchTag("TimeoutException", () =>
      CommandFailure.make({ command: [executable, ...args].join(" "), detail: "timed out" }),
    ),
    Effect.mapError((cause) =>
      CommandFailure.make({ command: [executable, ...args].join(" "), detail: String(cause) }),
    ),
  )
})

const checkedCommand = Effect.fn("ProxyTopology.checkedCommand")(function* (
  executable: string,
  args: ReadonlyArray<string>,
  timeout = 30_000,
) {
  const result = yield* command(executable, args, timeout)
  if (result.exitCode !== 0)
    return yield* CommandFailure.make({
      command: [executable, ...args].join(" "),
      detail: `exited ${result.exitCode}\n${result.stdout}\n${result.stderr}`,
    })
  return result
})

const available = Effect.fn("ProxyTopology.available")(function* (
  executable: string,
  args: ReadonlyArray<string> = [],
) {
  return (yield* Effect.exit(command(executable, [...args, "version"]))).pipe(
    (exit) => exit._tag === "Success" && exit.value.exitCode === 0,
  )
})

const chooseContainerCommand = Effect.gen(function* () {
  if (Bun.which("docker") !== null && (yield* available("docker"))) return ["docker"] as const
  if (Bun.which("podman") === null) return undefined
  if (yield* available("sudo", ["-n", "podman"])) return ["sudo", "podman", "--cgroup-manager=cgroupfs"] as const
  if (yield* available("podman")) return ["podman"] as const
  return undefined
})

const platform = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, BunSocket.layerWebSocketConstructor)
const run = <A, E>(
  effect: Effect.Effect<A, E, BunServices.BunServices | HttpClient.HttpClient | Socket.WebSocketConstructor>,
) =>
  Effect.runPromise(
    Effect.scoped(Layer.build(platform).pipe(Effect.flatMap((context) => Effect.provide(effect, context)))),
  )
const containerCommand = await run(chooseContainerCommand)
const usesDocker = containerCommand?.length === 1 && containerCommand[0] === "docker"
const containerHost = usesDocker ? "host.docker.internal" : "host.containers.internal"

const startServer = Effect.fn("ProxyTopology.startServer")(function* (
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest>,
) {
  const server = yield* BunHttpServer.make({ hostname: "0.0.0.0", port: 0 })
  yield* server.serve(handler)
  if (server.address._tag !== "TcpAddress") return yield* Effect.die("expected TCP server")
  return server.address.port
})

const requestJson = Effect.fn("ProxyTopology.requestJson")(function* (
  base: string,
  path: string,
  options?: { readonly method: "POST"; readonly body: string },
) {
  const client = yield* HttpClient.HttpClient
  const request =
    options !== undefined
      ? HttpClientRequest.post(`${base}${path}`).pipe(HttpClientRequest.bodyText(options.body, "text/plain"))
      : HttpClientRequest.get(`${base}${path}`)
  const response = yield* client.execute(request)
  expect(response.status).toBe(200)
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(
    yield* response.text,
  )
})

const websocketMessage = Effect.fn("ProxyTopology.websocketMessage")(function* (url: string, message: string) {
  const socket = yield* Socket.makeWebSocket(url)
  const writer = yield* socket.writer
  const response = yield* Deferred.make<string>()
  yield* socket
    .runString((value) => Deferred.succeed(response, value), { onOpen: writer(message) })
    .pipe(Effect.forkScoped)
  return yield* Deferred.await(response).pipe(
    Effect.timeout("10 seconds"),
    Effect.catchTag("TimeoutException", () => WebSocketTimeout.make()),
    Effect.mapError(() => WebSocketTimeout.make()),
  )
})

test.skipIf(containerCommand === undefined)(
  "routes the digest-pinned Caddy topology to live API, web, and WebSocket listeners",
  () =>
    run(
      Effect.gen(function* () {
        const image = `rika-proxy-topology-${process.pid}-${yield* Clock.currentTimeMillis}`
        const apiRequests: Array<{ method: string; path: string; search: string; body: string }> = []
        const apiUpgradePaths: string[] = []
        const webRequests: Array<{ method: string; path: string; search: string; body: string }> = []
        const apiPort = yield* startServer(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const url = new URL(request.url, "http://upstream")
            if (url.pathname === "/api/v1/executors" && request.headers.upgrade?.toLowerCase() === "websocket") {
              apiUpgradePaths.push(`${url.pathname}${url.search}`)
              const socket = yield* request.upgrade
              const writer = yield* socket.writer
              yield* socket.runString((message) => writer(`api-ws:${message}`))
              return HttpServerResponse.empty()
            }
            const body = yield* request.text
            apiRequests.push({ method: request.method, path: url.pathname, search: url.search, body })
            return yield* HttpServerResponse.json({
              owner: "api",
              method: request.method,
              path: url.pathname,
              search: url.search,
              body,
            })
          }),
        )
        const webPort = yield* startServer(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const url = new URL(request.url, "http://upstream")
            const body = yield* request.text
            webRequests.push({ method: request.method, path: url.pathname, search: url.search, body })
            return yield* HttpServerResponse.json({
              owner: "web",
              method: request.method,
              path: url.pathname,
              search: url.search,
              body,
            })
          }),
        )
        const portScope = yield* Scope.make()
        const portServer = yield* BunHttpServer.make({ hostname: "127.0.0.1", port: 0 }).pipe(
          Effect.provideService(Scope.Scope, portScope),
        )
        if (portServer.address._tag !== "TcpAddress") return yield* Effect.die("expected TCP server")
        const proxyPort = portServer.address.port
        yield* Scope.close(portScope, Exit.void)
        let container: string | undefined
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            if (container !== undefined)
              yield* Effect.ignore(
                command(containerCommand![0], [...containerCommand!.slice(1), "rm", "--force", container], 10_000),
              )
            yield* Effect.ignore(
              command(containerCommand![0], [...containerCommand!.slice(1), "image", "rm", "--force", image], 30_000),
            )
          }),
        )
        yield* checkedCommand(
          containerCommand![0],
          [...containerCommand!.slice(1), "build", "--file", "apps/proxy/Dockerfile", "--tag", image, "."],
          120_000,
        )
        const started = yield* checkedCommand(containerCommand![0], [
          ...containerCommand!.slice(1),
          "run",
          "--detach",
          "--publish",
          `127.0.0.1:${proxyPort}:3000`,
          ...(usesDocker ? ["--add-host", "host.docker.internal:host-gateway"] : []),
          "--env",
          "PORT=3000",
          "--env",
          `API_DOMAIN=${containerHost}`,
          "--env",
          `API_PORT=${apiPort}`,
          "--env",
          `WEB_DOMAIN=${containerHost}`,
          "--env",
          `WEB_PORT=${webPort}`,
          image,
        ])
        container = started.stdout.trim()
        expect(container).not.toBe("")
        const base = `http://127.0.0.1:${proxyPort}`
        const client = yield* HttpClient.HttpClient
        const deadline = (yield* Clock.currentTimeMillis) + 20_000
        while (true) {
          const health = yield* Effect.option(client.get(`${base}/_healthz`).pipe(Effect.timeout("500 millis")))
          if (health._tag === "Some" && health.value.status === 200 && (yield* health.value.text) === "ok") break
          if ((yield* Clock.currentTimeMillis) >= deadline) return yield* ProxyNotReady.make()
          yield* Effect.sleep("100 millis")
        }
        expect((yield* client.get(`${base}/_healthz`)).status).toBe(200)
        expect(apiRequests).toEqual([])
        expect(webRequests).toEqual([])
        for (const path of [
          "/healthz",
          "/readyz",
          "/api/v1/status",
          "/.well-known/oauth-authorization-server/api/auth",
          "/.well-known/oauth-protected-resource/api/v1",
        ]) {
          const response = yield* requestJson(base, path)
          expect(response).toMatchObject({ owner: "api", method: "GET", path: new URL(path, base).pathname })
        }
        expect(
          yield* requestJson(base, "/api/v1/echo?source=proxy", { method: "POST", body: "api-body" }),
        ).toMatchObject({
          owner: "api",
          method: "POST",
          path: "/api/v1/echo",
          search: "?source=proxy",
          body: "api-body",
        })
        for (const path of ["/", "/browser", "/assets/app.js"]) {
          expect(yield* requestJson(base, path)).toMatchObject({
            owner: "web",
            method: "GET",
            path: new URL(path, base).pathname,
          })
        }
        expect(
          yield* requestJson(base, "/assets/upload?source=proxy", { method: "POST", body: "web-body" }),
        ).toMatchObject({
          owner: "web",
          method: "POST",
          path: "/assets/upload",
          search: "?source=proxy",
          body: "web-body",
        })
        expect(yield* websocketMessage(`ws://127.0.0.1:${proxyPort}/api/v1/executors?session=one`, "hello")).toBe(
          "api-ws:hello",
        )
        expect(apiUpgradePaths).toEqual(["/api/v1/executors?session=one"])
        expect(apiRequests.map(({ method, path, search }) => [method, path, search])).toEqual([
          ["GET", "/healthz", ""],
          ["GET", "/readyz", ""],
          ["GET", "/api/v1/status", ""],
          ["GET", "/.well-known/oauth-authorization-server/api/auth", ""],
          ["GET", "/.well-known/oauth-protected-resource/api/v1", ""],
          ["POST", "/api/v1/echo", "?source=proxy"],
        ])
        expect(webRequests.map(({ method, path, search }) => [method, path, search])).toEqual([
          ["GET", "/", ""],
          ["GET", "/browser", ""],
          ["GET", "/assets/app.js", ""],
          ["POST", "/assets/upload", "?source=proxy"],
        ])
      }),
    ),
  180_000,
)
