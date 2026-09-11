/* oxlint-disable anti-slop -- the released Rivet client is a foreign Fetch/WebSocket boundary. */
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion */
/* oxlint-disable effecttsgo/async-function -- the released client exposes Promise-based transport methods. */
/* oxlint-disable effecttsgo/missing-pipeable-signature -- exported pure transport helpers are testable interop seams. */
/* oxlint-disable typescript/no-unsafe-type-assertion -- the public client adapter narrows only documented raw methods. */
/* oxlint-disable effecttsgo/prefer-schema-over-json -- Generalist's released HTTP endpoint consumes JSON. */
import { Effect } from "effect"
import type { ThreadPartition } from "../runtime/partition"
import {
  RuntimeGatewayError,
  type RootSessionReceipt,
  type RuntimeGateway,
  type RuntimeWebSocket,
} from "./runtime-gateway"
import { createRawRivetClient, type RawRivetClient } from "../runtime/rivet-actor"
import { RIKA_ORIGINAL_AUTHORIZATION, RIKA_ORIGINAL_REQUEST_URL, RIVET_ORIGINAL_REQUEST_URL } from "./rivet-protocol"

export {
  RIKA_DOWNSTREAM_CREDENTIAL,
  RIKA_ORIGINAL_AUTHORIZATION,
  RIKA_ORIGINAL_REQUEST_METHOD,
  RIKA_ORIGINAL_REQUEST_URL,
  RIVET_ORIGINAL_REQUEST_URL,
} from "./rivet-protocol"

export interface RawRivetClientOptions {
  /** Engine endpoint; this is the released Client transport endpoint, not the serverless pool URL. */
  readonly endpoint: string
  readonly token?: string
  readonly namespace?: string
}

export interface RawRivetGatewayOptions extends RawRivetClientOptions {
  /** Inject the released raw client seam for deterministic transport tests. */
  readonly client?: RawRivetClient
}

const runtimeError = (error: unknown, kind: RuntimeGatewayError["kind"] = "unknown") =>
  RuntimeGatewayError.make({ kind, message: error instanceof Error ? error.message : String(error) })

const requestHeaders = (request: Request, originalUrl: string) => {
  const headers = Object.fromEntries(request.headers.entries())
  headers[RIKA_ORIGINAL_REQUEST_URL] = originalUrl
  const authorization = headers.authorization
  const {
    [RIKA_ORIGINAL_AUTHORIZATION]: _originalAuthorization,
    [RIVET_ORIGINAL_REQUEST_URL]: _internalOriginalUrl,
    ...safeHeaders
  } = headers
  if (authorization !== undefined && /^DPoP \S+$/i.test(authorization)) {
    safeHeaders[RIKA_ORIGINAL_AUTHORIZATION] = authorization
    safeHeaders.authorization = `Bearer ${authorization.slice("DPoP ".length)}`
  }
  void _originalAuthorization
  void _internalOriginalUrl
  return safeHeaders
}

const actorRequest = (request: Request | undefined, path: string, init: RequestInit) => {
  const source = request ?? new Request("https://rika.invalid/runtime")
  const originalUrl = source.headers.get(RIKA_ORIGINAL_REQUEST_URL) ?? source.url
  const merged = new Headers(source.headers)
  new Headers(init.headers).forEach((value, key) => merged.set(key, value))
  const headers = Object.fromEntries(merged.entries())
  headers[RIKA_ORIGINAL_REQUEST_URL] = originalUrl
  const {
    [RIKA_ORIGINAL_AUTHORIZATION]: _originalAuthorization,
    [RIVET_ORIGINAL_REQUEST_URL]: _internalOriginalUrl,
    ...safeHeaders
  } = headers
  const authorization = safeHeaders.authorization
  if (authorization !== undefined && /^DPoP \S+$/i.test(authorization)) {
    safeHeaders[RIKA_ORIGINAL_AUTHORIZATION] = authorization
    safeHeaders.authorization = `Bearer ${authorization.slice("DPoP ".length)}`
  }
  void _originalAuthorization
  void _internalOriginalUrl
  const next: RequestInit = { ...init, headers: safeHeaders }
  return new Request(new URL(path, source.url).toString(), next)
}

const copyBodyRequest = (request: Request, path: string) => {
  const clone = request.clone()
  const init: RequestInit = {
    method: clone.method,
    headers: requestHeaders(request, request.headers.get(RIKA_ORIGINAL_REQUEST_URL) ?? request.url),
    signal: clone.signal,
  }
  if (clone.method !== "GET" && clone.method !== "HEAD" && clone.body !== null)
    Object.assign(init, { body: clone.body, duplex: "half" })
  return new Request(new URL(path, clone.url).toString(), init)
}

const responseIsSuccess = (response: Response) => response.status >= 200 && response.status < 300

/**
 * Forward existing Generalist HTTP routes through Rivet's released public client. Actor identity is always resolved by
 * the stable partition key; this adapter does not reimplement the EngineControlClient protocol.
 */
export const makeRawRivetClient = (options: RawRivetClientOptions): RawRivetClient => {
  const config = {
    endpoint: options.endpoint,
    disableMetadataLookup: false,
    encoding: "bare" as const,
  }
  if (options.token !== undefined) Object.assign(config, { token: options.token })
  if (options.namespace !== undefined) Object.assign(config, { namespace: options.namespace })
  return createRawRivetClient(config)
}

export const makeRawRivetGateway = (options: RawRivetGatewayOptions): RuntimeGateway => {
  const client = options.client ?? makeRawRivetClient(options)
  const actorFor = (partition: ThreadPartition, create = false) =>
    (create ? client.getOrCreate : client.get)("rikaRuntime", [...partition.actorKey])

  return {
    ensureRootSession: (partition, commandId, request): Effect.Effect<RootSessionReceipt, RuntimeGatewayError> =>
      Effect.tryPromise({
        // ast-grep-ignore: effect-prefer-program-construction -- released Rivet client transport is Promise-based.
        try: async () => {
          const actor = actorFor(partition)
          const existing = await actor.fetch(
            actorRequest(request, `/sessions/${encodeURIComponent(partition.rootSessionId)}`, { method: "GET" }),
          )
          if (responseIsSuccess(existing)) return { sessionId: partition.rootSessionId, created: false }
          const create = actorRequest(request, "/sessions", {
            method: "POST",
            headers: { "content-type": "application/json", "x-command-id": commandId },
            body: JSON.stringify({ id: partition.rootSessionId, title: `Thread ${partition.threadId}`, agent: "rika" }),
          })
          const response = await actorFor(partition, true).fetch(create)
          if (responseIsSuccess(response)) return { sessionId: partition.rootSessionId, created: true }
          const retry = await actor.fetch(
            actorRequest(request, `/sessions/${encodeURIComponent(partition.rootSessionId)}`, { method: "GET" }),
          )
          if (responseIsSuccess(retry)) return { sessionId: partition.rootSessionId, created: false }
          throw new Error(`Generalist Session create/read failed (${response.status}/${retry.status})`)
        },
        catch: (error) => runtimeError(error, "unavailable"),
      }),
    handle: (partition, request, websocket?: RuntimeWebSocket): Effect.Effect<Response, RuntimeGatewayError> =>
      Effect.tryPromise({
        // ast-grep-ignore: effect-prefer-program-construction -- released Rivet client transport is Promise-based.
        try: async () => {
          const actor = actorFor(partition)
          if (websocket !== undefined && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
            const gatewayUrl = gatewayWebSocketUrl(await actor.getGatewayUrl(), request.url)
            const headers = Object.fromEntries(
              Object.entries(
                requestHeaders(request, request.headers.get(RIKA_ORIGINAL_REQUEST_URL) ?? request.url),
              ).filter(
                ([name]) =>
                  ![
                    "connection",
                    "host",
                    "sec-websocket-accept",
                    "sec-websocket-extensions",
                    "sec-websocket-key",
                    "sec-websocket-protocol",
                    "sec-websocket-version",
                    "upgrade",
                  ].includes(name),
              ),
            )
            const upstream = openServerWebSocket(gatewayUrl, headers)
            bridgeWebSocket(upstream, websocket)
            return new Response(null, { status: 101 })
          }
          return actor.fetch(copyBodyRequest(request, new URL(request.url).pathname + new URL(request.url).search))
        },
        catch: (error) => runtimeError(error, "unavailable"),
      }),
  }
}

const openServerWebSocket = (url: URL, headers: Record<string, string>) =>
  // ast-grep-ignore: effect-prefer-socket -- Bun's server-side WebSocket constructor is the explicit transport adapter.
  new WebSocket(url.toString(), { protocols: ["rivet", "rivet_encoding.bare"], headers })

export const gatewayWebSocketUrl = (gateway: string, request: string) => {
  const gatewayUrl = new URL(gateway)
  const requestUrl = new URL(request)
  gatewayUrl.pathname = `${gatewayUrl.pathname.replace(/\/$/, "")}/websocket${requestUrl.pathname}`
  const query = new URLSearchParams(gatewayUrl.search)
  requestUrl.searchParams.forEach((value, key) => query.append(key, value))
  gatewayUrl.search = query.toString()
  return gatewayUrl
}

type WebSocketData = string | ArrayBuffer | ArrayBufferView

const webSocketDataSize = (data: WebSocketData) =>
  typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength

const isWebSocketData = (data: unknown): data is WebSocketData =>
  typeof data === "string" || data instanceof ArrayBuffer || ArrayBuffer.isView(data)

export const bridgeWebSocket = (upstream: unknown, downstream: RuntimeWebSocket) => {
  const socket = upstream as {
    readonly addEventListener?: (
      type: string,
      listener: (event: { readonly data?: unknown; readonly code?: number; readonly reason?: string }) => void,
    ) => void
    readonly send?: (data: WebSocketData) => void
    readonly close?: (code?: number, reason?: string) => void
  }
  const pending: WebSocketData[] = []
  let pendingBytes = 0
  let opened = false
  let closed = false

  const closeBoth = (code: number, reason: string, closeUpstream: boolean, closeDownstream: boolean) => {
    if (closed) return
    closed = true
    pending.length = 0
    pendingBytes = 0
    if (closeUpstream) {
      try {
        socket.close?.(code, reason)
      } catch {
        // Keep downstream fail-closed when the foreign socket close throws.
      }
    }
    if (closeDownstream) {
      try {
        downstream.close(code, reason)
      } catch {
        // The local host owns this socket; there is no recovery after close failure.
      }
    }
  }

  const send = (data: unknown) => {
    if (closed) return
    if (!isWebSocketData(data)) return
    if (!opened) {
      const size = webSocketDataSize(data)
      if (pending.length >= 128 || pendingBytes + size > 4 * 1024 * 1024) {
        closeBoth(1009, "Upstream WebSocket buffer exceeded", true, true)
        return
      }
      pending.push(data)
      pendingBytes += size
      return
    }
    try {
      socket.send?.(data)
    } catch {
      closeBoth(1011, "Upstream WebSocket failed", true, true)
    }
  }
  socket.addEventListener?.("open", () => {
    if (closed) {
      try {
        socket.close?.(1000, "Downstream WebSocket closed")
      } catch {
        // The foreign socket is already unavailable.
      }
      return
    }
    opened = true
    while (pending.length > 0) {
      if (closed) break
      const data = pending.shift()
      if (data === undefined) continue
      pendingBytes -= webSocketDataSize(data)
      try {
        socket.send?.(data)
      } catch {
        closeBoth(1011, "Upstream WebSocket failed", true, true)
      }
    }
  })
  socket.addEventListener?.("message", (event) => {
    if (!closed && isWebSocketData(event.data)) {
      try {
        downstream.send(event.data)
      } catch {
        closeBoth(1011, "Downstream WebSocket failed", true, true)
      }
    }
  })
  socket.addEventListener?.("error", () => {
    closeBoth(1011, "Upstream WebSocket failed", true, true)
  })
  socket.addEventListener?.("close", (event) => {
    closeBoth(event.code ?? 1000, event.reason ?? "Upstream WebSocket closed", false, true)
  })
  downstream.addEventListener?.("message", (event) => send(event.data))
  downstream.addEventListener?.("close", () => {
    closeBoth(1000, "Downstream WebSocket closed", true, false)
  })
}
