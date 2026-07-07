import { Buffer } from "node:buffer"
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { Duplex } from "node:stream"
import { fileURLToPath } from "node:url"
import { foldkit } from "@foldkit/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import type * as BackendEndpoint from "@rika/cli/backend-endpoint"
import { createServerModuleRunner, defineConfig, type Plugin } from "vite"
import type { ModuleRunner } from "vite/module-runner"
import WebSocket, { WebSocketServer } from "ws"

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const workspaceRoot = process.env.RIKA_WORKSPACE_ROOT ?? rootDir
const dataDir = process.env.RIKA_DATA_DIR ?? join(process.env.HOME ?? homedir(), ".rika")
const cliEntryScript = join(rootDir, "packages", "cli", "src", "main.ts")
const apiPrefix = "/api/rika"
const bridgeHighWaterBytes = 1024 * 1024
const bridgeLowWaterBytes = 256 * 1024
const bridgeCloseBytes = 4 * 1024 * 1024
type ConfigMode = "rush" | "smart" | "deep1" | "deep2" | "deep3"

interface ProxyForwardTarget {
  readonly kind: "proxy"
  readonly url: string
  readonly token: string
  readonly body: Uint8Array | undefined
}

interface ProxyResponseTarget {
  readonly kind: "response"
  readonly status: number
  readonly body: unknown
}

type ProxyTarget = ProxyForwardTarget | ProxyResponseTarget

interface ProxyWebSocketTarget {
  readonly kind: "websocket"
  readonly url: string
  readonly token: string
}

interface ResolveProxyTargetInput {
  readonly request_url: string
  readonly method: string
  readonly body?: Uint8Array
  readonly resolveEndpoint: (input: { readonly thread_id?: string }) => Promise<BackendEndpoint.BackendEndpoint>
}

interface ResolveProxyWebSocketTargetInput {
  readonly request_url: string
  readonly resolveEndpoint: ResolveProxyTargetInput["resolveEndpoint"]
}

interface ProxyResolver {
  readonly resolveEndpoint: ResolveProxyTargetInput["resolveEndpoint"]
  readonly dispose: () => Promise<void>
}

interface ProxyModules {
  readonly Core: typeof import("@rika/core")
  readonly Persistence: typeof import("@rika/persistence")
  readonly SchemaModule: typeof import("@rika/schema")
  readonly EffectRuntime: typeof import("effect")
  readonly BackendEndpointModule: typeof import("@rika/cli/backend-endpoint")
  readonly LocalBackend: typeof import("@rika/cli/local-backend")
  readonly Orb: typeof import("@rika/orb")
}

type LoadProxyModules = () => Promise<ProxyModules>

export default defineConfig({
  plugins: [
    tailwindcss(),
    foldkit(process.env.NODE_ENV === "test" ? {} : { devToolsMcpPort: 9988 }),
    localBackendProxy(),
  ],
  resolve: {
    alias: [{ find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) }],
  },
})

function localBackendProxy(): Plugin {
  let resolver: Promise<ProxyResolver> | undefined
  let moduleRunner: ModuleRunner | undefined
  const proxyResolver = (loadModules: LoadProxyModules) => {
    resolver ??= makeProxyResolver(loadModules)
    return resolver
  }
  return {
    name: "rika-local-backend-proxy",
    configureServer(server) {
      const webSocketServer = new WebSocketServer({ noServer: true })
      const loadModules: LoadProxyModules = async () => {
        moduleRunner ??= createServerModuleRunner(server.environments.ssr)
        return {
          Core: await moduleRunner.import<typeof import("@rika/core")>("@rika/core"),
          Persistence: await moduleRunner.import<typeof import("@rika/persistence")>("@rika/persistence"),
          SchemaModule: await moduleRunner.import<typeof import("@rika/schema")>("@rika/schema"),
          EffectRuntime: await moduleRunner.import<typeof import("effect")>("effect"),
          BackendEndpointModule:
            await moduleRunner.import<typeof import("@rika/cli/backend-endpoint")>("@rika/cli/backend-endpoint"),
          LocalBackend: await moduleRunner.import<typeof import("@rika/cli/local-backend")>("@rika/cli/local-backend"),
          Orb: await moduleRunner.import<typeof import("@rika/orb")>("@rika/orb"),
        }
      }
      server.middlewares.use((request, response, next) => {
        if (!isApiRequestUrl(request.url)) {
          next()
          return
        }
        void proxyResolver(loadModules)
          .then((runtime) => proxyRequest(request, response, next, runtime.resolveEndpoint))
          .catch((error: unknown) => writeBackendUnavailable(response, error))
      })
      const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        if (!isOrbPtyWebSocketRequestUrl(request.url)) return
        void proxyResolver(loadModules)
          .then((runtime) =>
            proxyOrbPtyWebSocketRequest(request, socket, head, webSocketServer, runtime.resolveEndpoint),
          )
          .catch((error: unknown) => rejectWebSocketUpgrade(socket, 503, errorBody(error, "backend_not_running")))
      }
      server.httpServer?.on("upgrade", upgrade)
      server.httpServer?.once("close", () => {
        server.httpServer?.off("upgrade", upgrade)
        webSocketServer.close()
        if (resolver !== undefined) void resolver.then((runtime) => runtime.dispose()).catch(() => undefined)
        if (moduleRunner !== undefined) void moduleRunner.close().catch(() => undefined)
      })
    },
  }
}

const writeBackendUnavailable = (response: ServerResponse, error: unknown): void =>
  writeJson(response, 503, errorBody(error, "backend_not_running"))

const errorBody = (error: unknown, code: string) => ({
  error: {
    message: error instanceof Error ? error.message : String(error),
    code,
  },
})

export const isApiRequestUrl = (requestUrl: string | undefined): boolean =>
  requestUrl !== undefined && requestUrl.startsWith(apiPrefix)

export const backendProxyEnv = (env: Record<string, string | undefined>): Record<string, string | undefined> => ({
  ...env,
  RIKA_BACKEND_SCRIPT: env.RIKA_BACKEND_SCRIPT ?? cliEntryScript,
})

export const isOrbPtyWebSocketRequestUrl = (requestUrl: string | undefined): boolean => {
  if (requestUrl === undefined) return false
  const url = new URL(requestUrl, "http://rika.local")
  return explicitOrbPtyProxyTarget(url) !== undefined
}

async function loadProxyModules(): Promise<ProxyModules> {
  const [Core, Persistence, SchemaModule, EffectRuntime, BackendEndpointModule, LocalBackend, Orb] = await Promise.all([
    import("@rika/core"),
    import("@rika/persistence"),
    import("@rika/schema"),
    import("effect"),
    import("@rika/cli/backend-endpoint"),
    import("@rika/cli/local-backend"),
    import("@rika/orb"),
  ])
  return { Core, Persistence, SchemaModule, EffectRuntime, BackendEndpointModule, LocalBackend, Orb }
}

async function makeProxyResolver(loadModules: LoadProxyModules = loadProxyModules): Promise<ProxyResolver> {
  const { Core, Persistence, SchemaModule, EffectRuntime, BackendEndpointModule, LocalBackend, Orb } =
    await loadModules()
  const env = backendProxyEnv(process.env)
  const configLayer = Core.Config.layerFromValues(
    {
      workspace_root: workspaceRoot,
      data_dir: dataDir,
      default_mode: modeFromEnv(env),
      ...(env.RIKA_DATABASE_URL === undefined ? {} : { database_url: env.RIKA_DATABASE_URL }),
    },
    env,
  )
  const databaseLayer = Persistence.Database.layer.pipe(EffectRuntime.Layer.provideMerge(configLayer))
  const timeLayer = Core.Time.layer
  const redactorLayer = Core.SecretRedactor.layerFromEnv(env)
  const mcpApprovalLayer = Persistence.McpApprovalStore.layer.pipe(
    EffectRuntime.Layer.provideMerge(databaseLayer),
    EffectRuntime.Layer.provideMerge(timeLayer),
  )
  const projectStoreLayer = Persistence.ProjectStore.layer.pipe(
    EffectRuntime.Layer.provideMerge(configLayer),
    EffectRuntime.Layer.provideMerge(databaseLayer),
    EffectRuntime.Layer.provideMerge(timeLayer),
    EffectRuntime.Layer.provideMerge(Core.IdGenerator.layer),
  )
  const orbStoreLayer = Persistence.OrbStore.layer.pipe(
    EffectRuntime.Layer.provideMerge(databaseLayer),
    EffectRuntime.Layer.provideMerge(timeLayer),
    EffectRuntime.Layer.provideMerge(Core.IdGenerator.layer),
  )
  const sandboxLayer = Orb.SandboxClient.layer.pipe(EffectRuntime.Layer.provideMerge(configLayer))
  const storageLayer = EffectRuntime.Layer.mergeAll(
    configLayer,
    databaseLayer,
    Persistence.Migration.layer,
    redactorLayer,
    timeLayer,
    mcpApprovalLayer,
    Core.IdGenerator.layer,
    projectStoreLayer,
    orbStoreLayer,
  )
  const migratedStorageLayer = EffectRuntime.Layer.effectDiscard(
    Persistence.Migration.migrate().pipe(EffectRuntime.Effect.andThen(Persistence.OrbStore.repairUsageIntervals())),
  ).pipe(EffectRuntime.Layer.provideMerge(storageLayer))
  const managerLayer = Orb.OrbManager.layer.pipe(
    EffectRuntime.Layer.provideMerge(migratedStorageLayer),
    EffectRuntime.Layer.provideMerge(sandboxLayer),
    EffectRuntime.Layer.provideMerge(
      Core.Diagnostics.layer.pipe(
        EffectRuntime.Layer.provideMerge(configLayer),
        EffectRuntime.Layer.provideMerge(redactorLayer),
      ),
    ),
    EffectRuntime.Layer.provideMerge(redactorLayer),
  )
  const layer = BackendEndpointModule.resolverLayerFromEnv(env).pipe(
    EffectRuntime.Layer.provideMerge(
      LocalBackend.layerFromInput({ env, cwd: workspaceRoot, adoptHealthyRecord: true }),
    ),
    EffectRuntime.Layer.provideMerge(BackendEndpointModule.healthLayer),
    EffectRuntime.Layer.provideMerge(migratedStorageLayer),
    EffectRuntime.Layer.provideMerge(BackendEndpointModule.orbManagerResumerLayer),
    EffectRuntime.Layer.provideMerge(managerLayer),
  )
  const runtime = EffectRuntime.ManagedRuntime.make(layer)
  return {
    resolveEndpoint: (input) =>
      runtime.runPromise(
        BackendEndpointModule.resolve({
          ...(input.thread_id === undefined ? {} : { thread_id: SchemaModule.Ids.ThreadId.make(input.thread_id) }),
          workspace_root: workspaceRoot,
          data_dir: dataDir,
          mode: modeFromEnv(process.env),
          env: process.env,
        }),
      ),
    dispose: () => runtime.dispose(),
  }
}

const proxyRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  next: (error?: unknown) => void,
  resolveEndpoint: ResolveProxyTargetInput["resolveEndpoint"],
) => {
  if (request.url === undefined || !request.url.startsWith(apiPrefix)) {
    next()
    return
  }
  const method = request.method ?? "GET"
  const body = method === "GET" || method === "HEAD" ? undefined : await yieldRequestBody(request)
  const target = await resolveProxyTarget({
    request_url: request.url,
    method,
    ...(body === undefined ? {} : { body }),
    resolveEndpoint,
  }).catch((error: unknown) => {
    writeJson(response, 503, {
      error: {
        message: error instanceof Error ? error.message : String(error),
        code: "backend_not_running",
      },
    })
    return undefined
  })
  if (target === undefined) {
    return
  }
  if (target.kind === "response") {
    writeJson(response, target.status, target.body)
    return
  }
  const headers = proxyHeaders(request.headers, target.token)
  const requestInit: RequestInit & { duplex?: "half" } = {
    method,
    headers,
  }
  if (target.body !== undefined) requestInit.body = target.body
  const proxied = await fetch(target.url, requestInit)
  response.statusCode = proxied.status
  proxied.headers.forEach((value, key) => response.setHeader(key, value))
  if (proxied.body === null) {
    response.end()
    return
  }
  const reader = proxied.body.getReader()
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    response.write(chunk.value)
  }
  response.end()
}

export const proxyOrbPtyWebSocketRequest = async (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  webSocketServer: WebSocketServer,
  resolveEndpoint: ResolveProxyTargetInput["resolveEndpoint"],
): Promise<void> => {
  if (request.url === undefined) {
    rejectWebSocketUpgrade(socket, 404, {
      error: { message: "WebSocket route not found", code: "websocket_route_not_found" },
    })
    return
  }
  const target = await resolveProxyWebSocketTarget({ request_url: request.url, resolveEndpoint }).catch(
    (error: unknown) => {
      rejectWebSocketUpgrade(socket, 503, errorBody(error, "backend_not_running"))
      return undefined
    },
  )
  if (target === undefined) return
  if (target.kind === "response") {
    rejectWebSocketUpgrade(socket, target.status, target.body)
    return
  }
  const upstream = new WebSocket(orbPtyWebSocketUrlWithToken(target.url, target.token), {
    headers: webSocketHeaders(target.token),
  })
  const opened = await openUpstreamWebSocket(upstream)
  if (!opened) {
    rejectWebSocketUpgrade(socket, 502, {
      error: { message: "Orb PTY WebSocket unavailable", code: "orb_pty_unavailable" },
    })
    return
  }
  webSocketServer.handleUpgrade(request, socket, head, (client) => {
    bridgeWebSockets(client, upstream)
  })
}

const openUpstreamWebSocket = (socket: WebSocket) =>
  new Promise<boolean>((done) => {
    socket.once("open", () => done(true))
    socket.once("error", () => done(false))
    socket.once("close", () => done(false))
  })

const bridgeWebSockets = (client: WebSocket, upstream: WebSocket): void => {
  let closing = false
  const closeBoth = (code?: number, reason?: Buffer) => {
    if (closing) return
    closing = true
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close(code, reason)
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING)
      upstream.close(code, reason)
  }
  bridgeWebSocketDirection(client, upstream, closeBoth)
  bridgeWebSocketDirection(upstream, client, closeBoth)
  client.once("close", (code, reason) => closeBoth(code, reason))
  upstream.once("close", (code, reason) => closeBoth(code, reason))
  client.once("error", () => closeBoth())
  upstream.once("error", () => closeBoth())
}

const bridgeWebSocketDirection = (
  source: WebSocket,
  target: WebSocket,
  closeBoth: (code?: number, reason?: Buffer) => void,
): void => {
  let paused = false
  const pauseSource = () => {
    if (paused) return
    paused = true
    source.pause()
  }
  const resumeSource = () => {
    if (!paused || target.bufferedAmount > bridgeLowWaterBytes) return
    paused = false
    source.resume()
  }
  source.on("message", (data, isBinary) => {
    if (target.readyState !== WebSocket.OPEN) return
    if (target.bufferedAmount > bridgeHighWaterBytes) pauseSource()
    target.send(data, { binary: isBinary }, (error) => {
      if (error != null) {
        closeBoth(1011, Buffer.from("websocket bridge send failed"))
        return
      }
      resumeSource()
    })
    if (target.bufferedAmount > bridgeCloseBytes) {
      closeBoth(1011, Buffer.from("websocket bridge backpressure limit"))
      return
    }
    if (target.bufferedAmount > bridgeHighWaterBytes) pauseSource()
  })
}

export const resolveProxyTarget = async (input: ResolveProxyTargetInput): Promise<ProxyTarget> => {
  const url = new URL(input.request_url, "http://rika.local")
  const explicitOrbTarget = explicitOrbProxyTarget(url)
  if (explicitOrbTarget !== undefined) {
    const endpoint = await input.resolveEndpoint({ thread_id: explicitOrbTarget.thread_id })
    if (endpoint.kind !== "orb") {
      return {
        kind: "response",
        status: 404,
        body: {
          error: {
            message: `No running orb endpoint for thread ${explicitOrbTarget.thread_id}`,
            code: "orb_endpoint_not_found",
          },
        },
      }
    }
    return {
      kind: "proxy",
      url: `${endpoint.url.replace(/\/$/, "")}${explicitOrbTarget.path}${explicitOrbTarget.search}`,
      token: endpoint.token,
      body: input.body,
    }
  }
  const targetPath = url.pathname.slice(apiPrefix.length) || "/"
  const threadId = threadIdFromProxyRequest(targetPath, url, input.method, input.body)
  const endpoint = await input.resolveEndpoint(threadId === undefined ? {} : { thread_id: threadId })
  return {
    kind: "proxy",
    url: `${endpoint.url.replace(/\/$/, "")}${targetPath}${url.search}`,
    token: endpoint.token,
    body: input.body,
  }
}

export const resolveProxyWebSocketTarget = async (
  input: ResolveProxyWebSocketTargetInput,
): Promise<ProxyWebSocketTarget | ProxyResponseTarget> => {
  const url = new URL(input.request_url, "http://rika.local")
  const explicitOrbTarget = explicitOrbPtyProxyTarget(url)
  if (explicitOrbTarget === undefined) {
    return {
      kind: "response",
      status: 404,
      body: { error: { message: "WebSocket route not found", code: "websocket_route_not_found" } },
    }
  }
  const endpoint = await input.resolveEndpoint({ thread_id: explicitOrbTarget.thread_id })
  if (endpoint.kind !== "orb") {
    return {
      kind: "response",
      status: 404,
      body: {
        error: {
          message: `No running orb endpoint for thread ${explicitOrbTarget.thread_id}`,
          code: "orb_endpoint_not_found",
        },
      },
    }
  }
  return {
    kind: "websocket",
    url: orbPtyWebSocketTargetUrl(endpoint.url, explicitOrbTarget.search),
    token: endpoint.token,
  }
}

const explicitOrbProxyTarget = (
  url: URL,
): { readonly thread_id: string; readonly path: string; readonly search: string } | undefined => {
  const prefix = `${apiPrefix}/orb/by-thread/`
  if (!url.pathname.startsWith(prefix)) return undefined
  const suffix = url.pathname.slice(prefix.length)
  const slashIndex = suffix.indexOf("/")
  if (slashIndex < 0) return undefined
  const threadId = decodeURIComponent(suffix.slice(0, slashIndex))
  const path = suffix.slice(slashIndex)
  if (path !== "/v1/orb/files" && path !== "/v1/orb/file" && path !== "/v1/orb/changes") return undefined
  return { thread_id: threadId, path, search: orbProxySearch(url) }
}

const explicitOrbPtyProxyTarget = (url: URL): { readonly thread_id: string; readonly search: string } | undefined => {
  const prefix = `${apiPrefix}/orb/by-thread/`
  if (!url.pathname.startsWith(prefix)) return undefined
  const suffix = url.pathname.slice(prefix.length)
  const slashIndex = suffix.indexOf("/")
  if (slashIndex < 0) return undefined
  const threadId = decodeURIComponent(suffix.slice(0, slashIndex))
  const path = suffix.slice(slashIndex)
  if (path !== "/v1/orb/pty") return undefined
  return { thread_id: threadId, search: orbPtyProxySearch(url) }
}

const orbProxySearch = (url: URL) => {
  const params = new URLSearchParams()
  const path = url.searchParams.get("path")
  if (path !== null) params.set("path", path)
  const text = params.toString()
  return text.length === 0 ? "" : `?${text}`
}

const orbPtyProxySearch = (url: URL) => {
  const params = new URLSearchParams()
  params.set("cols", String(dimensionOrDefault(intParam(url, "cols"), 80, 1, 500)))
  params.set("rows", String(dimensionOrDefault(intParam(url, "rows"), 24, 1, 300)))
  return `?${params.toString()}`
}

const orbPtyWebSocketTargetUrl = (endpointUrl: string, search: string) => {
  const target = new URL(`${endpointUrl.replace(/\/$/, "")}/v1/orb/pty${search}`)
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:"
  return target.toString()
}

const orbPtyWebSocketUrlWithToken = (targetUrl: string, token: string) => {
  const target = new URL(targetUrl)
  if (token.length > 0) target.searchParams.set("token", token)
  return target.toString()
}

const threadIdFromProxyRequest = (
  targetPath: string,
  url: URL,
  method: string,
  body: Uint8Array | undefined,
): string | undefined => {
  const segments = targetPath.split("/").filter(Boolean)
  if (segments[0] === "v1" && segments[1] === "threads" && segments[2] !== undefined && segments[2] !== "search") {
    return decodeURIComponent(segments[2])
  }
  const queryThreadId = url.searchParams.get("thread_id")
  if (queryThreadId !== null) return queryThreadId
  if (method !== "POST") return undefined
  if (segments[0] !== "v1") return undefined
  const bodyCanContainThreadId =
    (segments[1] === "turns" && (segments.length === 2 || (segments[2] === "interrupt" && segments.length === 3))) ||
    (segments[1] === "threads" && segments.length === 2)
  return bodyCanContainThreadId ? threadIdFromJsonBody(body) : undefined
}

const threadIdFromJsonBody = (body: Uint8Array | undefined): string | undefined => {
  if (body === undefined || body.length === 0) return undefined
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(body))
    if (typeof value !== "object" || value === null || !("thread_id" in value)) return undefined
    return typeof value.thread_id === "string" ? value.thread_id : undefined
  } catch {
    return undefined
  }
}

const intParam = (url: URL, name: string): number | undefined => {
  const value = url.searchParams.get(name)
  if (value === null || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

const dimensionOrDefault = (value: number | undefined, fallback: number, minimum: number, maximum: number) =>
  value === undefined || value < minimum || value > maximum ? fallback : value

const yieldRequestBody = async (request: IncomingMessage): Promise<Uint8Array | undefined> => {
  const chunks: Array<Buffer> = []
  for await (const chunk of request) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
  return chunks.length === 0 ? undefined : Buffer.concat(chunks)
}

const rejectWebSocketUpgrade = (socket: Duplex, status: number, body: unknown): void => {
  const payload = JSON.stringify(body)
  socket.write(
    [
      `HTTP/1.1 ${status} ${httpStatusText(status)}`,
      "content-type: application/json",
      `content-length: ${Buffer.byteLength(payload)}`,
      "connection: close",
      "",
      payload,
    ].join("\r\n"),
  )
  socket.destroy()
}

const webSocketHeaders = (token: string): Record<string, string> =>
  token.length === 0 ? {} : { authorization: `Bearer ${token}` }

const proxyHeaders = (source: IncomingHttpHeaders, token: string) => {
  const headers = new Headers()
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || key === "host" || key === "connection" || key === "content-length") continue
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item)
    } else {
      headers.set(key, value)
    }
  }
  if (token.length > 0) headers.set("authorization", `Bearer ${token}`)
  return headers
}

const httpStatusText = (status: number) => {
  if (status === 404) return "Not Found"
  if (status === 502) return "Bad Gateway"
  if (status === 503) return "Service Unavailable"
  return "Error"
}

const writeJson = (response: ServerResponse, status: number, value: unknown) => {
  if (response.headersSent || response.writableEnded) return
  response.statusCode = status
  response.setHeader("content-type", "application/json")
  response.end(JSON.stringify(value))
}

function modeFromEnv(env: Record<string, string | undefined>): ConfigMode {
  const value = env.RIKA_MODE
  if (value === "rush" || value === "smart" || value === "deep1" || value === "deep2" || value === "deep3") return value
  return "smart"
}
