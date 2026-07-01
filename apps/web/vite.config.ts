import { Buffer } from "node:buffer"
import { readFile } from "node:fs/promises"
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { foldkit } from "@foldkit/vite-plugin"
import { defineConfig, type Plugin } from "vite"

interface BackendRecord {
  readonly url: string
  readonly token: string
}

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const workspaceRoot = process.env.RIKA_WORKSPACE_ROOT ?? rootDir
const dataDir = process.env.RIKA_DATA_DIR ?? join(workspaceRoot, ".rika")
const recordPath = join(dataDir, "local-backend.json")
const apiPrefix = "/api/rika"

export default defineConfig({
  plugins: [foldkit(), localBackendProxy()],
})

function localBackendProxy(): Plugin {
  return {
    name: "rika-local-backend-proxy",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        void proxyRequest(request, response, next).catch(next)
      })
    },
  }
}

const proxyRequest = async (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => {
  if (request.url === undefined || !request.url.startsWith(apiPrefix)) {
    next()
    return
  }
  const backend = await readBackendRecord()
  if (backend === undefined) {
    writeJson(response, 503, {
      error: {
        message: "Rika local backend is not running. Start a Rika CLI session or run rika server first.",
        code: "backend_not_running",
      },
    })
    return
  }
  const targetPath = request.url.slice(apiPrefix.length) || "/"
  const target = `${backend.url.replace(/\/$/, "")}${targetPath}`
  const headers = proxyHeaders(request.headers, backend.token)
  const method = request.method ?? "GET"
  const body = method === "GET" || method === "HEAD" ? undefined : yieldRequestBody(request)
  const requestInit: RequestInit & { duplex?: "half" } = {
    method,
    headers,
  }
  if (body !== undefined) {
    const requestBody = await body
    if (requestBody !== undefined) requestInit.body = requestBody
  }
  const proxied = await fetch(target, requestInit)
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

const readBackendRecord = async (): Promise<BackendRecord | undefined> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(recordPath, "utf8"))
    return backendRecord(parsed)
  } catch {
    return undefined
  }
}

const backendRecord = (value: unknown): BackendRecord | undefined => {
  if (typeof value !== "object" || value === null || !("url" in value) || !("token" in value)) return undefined
  if (typeof value.url !== "string" || typeof value.token !== "string") return undefined
  return { url: value.url, token: value.token }
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
