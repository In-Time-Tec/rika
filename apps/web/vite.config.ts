import { Buffer } from "node:buffer"
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { foldkit } from "@foldkit/vite-plugin"
import type * as BackendEndpoint from "@rika/cli/backend-endpoint"
import { defineConfig, type Plugin } from "vite"

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const workspaceRoot = process.env.RIKA_WORKSPACE_ROOT ?? rootDir
const dataDir = process.env.RIKA_DATA_DIR ?? join(workspaceRoot, ".rika")
const apiPrefix = "/api/rika"
type ConfigMode = "rush" | "smart" | "deep1" | "deep2" | "deep3"

interface ProxyTarget {
  readonly url: string
  readonly token: string
  readonly body: Uint8Array | undefined
}

interface ResolveProxyTargetInput {
  readonly request_url: string
  readonly method: string
  readonly body?: Uint8Array
  readonly resolveEndpoint: (input: { readonly thread_id?: string }) => Promise<BackendEndpoint.BackendEndpoint>
}

interface ProxyResolver {
  readonly resolveEndpoint: ResolveProxyTargetInput["resolveEndpoint"]
  readonly dispose: () => Promise<void>
}

export default defineConfig({
  plugins: [foldkit(), localBackendProxy()],
})

function localBackendProxy(): Plugin {
  let resolver: Promise<ProxyResolver> | undefined
  const proxyResolver = () => {
    resolver ??= makeProxyResolver()
    return resolver
  }
  return {
    name: "rika-local-backend-proxy",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        void proxyResolver()
          .then((runtime) => proxyRequest(request, response, next, runtime.resolveEndpoint))
          .catch(next)
      })
      server.httpServer?.once("close", () => {
        if (resolver !== undefined) void resolver.then((runtime) => runtime.dispose())
      })
    },
  }
}

async function makeProxyResolver(): Promise<ProxyResolver> {
  const [Core, Persistence, SchemaModule, EffectRuntime, BackendEndpointModule, LocalBackend] = await Promise.all([
    import("@rika/core"),
    import("@rika/persistence"),
    import("@rika/schema"),
    import("effect"),
    import("@rika/cli/backend-endpoint"),
    import("@rika/cli/local-backend"),
  ])
  const env = process.env
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
  const orbStoreLayer = Persistence.OrbStore.layer.pipe(
    EffectRuntime.Layer.provideMerge(databaseLayer),
    EffectRuntime.Layer.provideMerge(timeLayer),
    EffectRuntime.Layer.provideMerge(Core.IdGenerator.layer),
  )
  const storageLayer = EffectRuntime.Layer.mergeAll(
    configLayer,
    databaseLayer,
    Persistence.Migration.layer,
    timeLayer,
    Core.IdGenerator.layer,
    orbStoreLayer,
  )
  const migratedStorageLayer = EffectRuntime.Layer.effectDiscard(Persistence.Migration.migrate()).pipe(
    EffectRuntime.Layer.provideMerge(storageLayer),
  )
  const layer = BackendEndpointModule.resolverLayerFromEnv(env).pipe(
    EffectRuntime.Layer.provideMerge(LocalBackend.layerFromInput({ env, cwd: workspaceRoot })),
    EffectRuntime.Layer.provideMerge(BackendEndpointModule.healthLayer),
    EffectRuntime.Layer.provideMerge(migratedStorageLayer),
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

export const resolveProxyTarget = async (input: ResolveProxyTargetInput): Promise<ProxyTarget> => {
  const url = new URL(input.request_url, "http://rika.local")
  const targetPath = url.pathname.slice(apiPrefix.length) || "/"
  const threadId = threadIdFromProxyRequest(targetPath, url, input.method, input.body)
  const endpoint = await input.resolveEndpoint(threadId === undefined ? {} : { thread_id: threadId })
  return {
    url: `${endpoint.url.replace(/\/$/, "")}${targetPath}${url.search}`,
    token: endpoint.token,
    body: input.body,
  }
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

const yieldRequestBody = async (request: IncomingMessage): Promise<Uint8Array | undefined> => {
  const chunks: Array<Buffer> = []
  for await (const chunk of request) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
  return chunks.length === 0 ? undefined : Buffer.concat(chunks)
}

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

const writeJson = (response: ServerResponse, status: number, value: unknown) => {
  response.statusCode = status
  response.setHeader("content-type", "application/json")
  response.end(JSON.stringify(value))
}

function modeFromEnv(env: Record<string, string | undefined>): ConfigMode {
  const value = env.RIKA_MODE
  if (value === "rush" || value === "smart" || value === "deep1" || value === "deep2" || value === "deep3") return value
  return "smart"
}
