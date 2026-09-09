/* oxlint-disable anti-slop-effect/no-service-constructor-imports -- this explicit host is the application composition root. */
/* oxlint-disable effecttsgo/async-function -- the host exposes the platform Fetch contract. */
/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion */
import { Effect, Schema } from "effect"
import type { ApiV2ApplicationOptions, ApiV2ApplicationService } from "./application"
import { makeApiV2Application } from "./application"
import type { RuntimeRegistry } from "./rivet-actor"
import type { RuntimeWebSocket } from "./runtime-gateway"

class ApiV2LocalHostError extends Schema.TaggedError<ApiV2LocalHostError>()("RikaApiV2LocalHostError", {
  message: Schema.String,
}) {}

export interface ApiV2LocalHost {
  readonly application: ApiV2ApplicationService
  readonly registry: RuntimeRegistry
  // ast-grep-ignore: effect-prefer-effect-signatures -- Bun Fetch is the explicit local host boundary.
  readonly fetch: (request: Request, websocket?: RuntimeWebSocket) => Promise<Response>
  // ast-grep-ignore: effect-prefer-effect-signatures -- Bun registry shutdown is a foreign lifecycle boundary.
  readonly close: () => Promise<void>
}


const runtimeWebSocket = (socket: {
  readonly send: (data: string | Blob | ArrayBuffer | ArrayBufferView) => number
  readonly close: (code?: number, reason?: string) => void
}): RuntimeWebSocket => {
  const listeners = new Map<string, Set<(event: { readonly data: unknown }) => void>>()
  const dispatch = (type: string, event: { readonly data: unknown }) => {
    listeners.get(type)?.forEach((listener) => listener(event))
  }
  return {
    send: (data) => {
      if (typeof data === "string" || data instanceof ArrayBuffer || data instanceof Blob) return socket.send(data)
      return socket.send(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    },
    close: (code, reason) => socket.close(code, reason),
    addEventListener: (type, listener) => {
      const bucket = listeners.get(type) ?? new Set()
      bucket.add(listener)
      listeners.set(type, bucket)
    },
    dispatch: (event) => dispatch(event.type ?? "message", event),
  }
}

export interface ApiV2LocalServer extends ApiV2LocalHost {
  readonly url: string
}

export interface ApiV2LocalServerOptions extends ApiV2LocalHostOptions {
  readonly port: number
  readonly hostname?: string
}

export interface ApiV2LocalHostOptions extends ApiV2ApplicationOptions {
  /** Warm the Rivet serverless registry before returning. Defaults to true for explicit local compositions. */
  readonly startRegistry?: boolean
}

const isRivetRequest = (request: Request) => {
  const pathname = new URL(request.url).pathname
  return pathname === "/api/rivet" || pathname.startsWith("/api/rivet/")
}

/**
 * Compose one explicit local host. Rika HTTP owns `/api/v2`; Rivet owns `/api/rivet`, and the default gateway uses the
 * same registry instance instead of a fake callback or a second execution protocol.
 */
export const makeApiV2LocalHost = (options: ApiV2LocalHostOptions) =>
  makeApiV2Application(options).pipe(
    Effect.flatMap((application) => {
      const start =
        options.startRegistry === false
          ? Effect.void
          : Effect.tryPromise(() => application.registry.handler(new Request("http://rivet.local/api/rivet/metadata"))).pipe(
              Effect.flatMap((response) =>
                response.ok
                  ? Effect.void
                  : Effect.fail(ApiV2LocalHostError.make({ message: `Rivet registry readiness failed: ${response.status}` })),
              ),
            )
      return start.pipe(
        Effect.as({
          application,
          registry: application.registry,
          // ast-grep-ignore: effect-prefer-program-construction -- Bun Fetch is the explicit local host boundary.
          fetch: async (request: Request, websocket?: RuntimeWebSocket) => {
            if (isRivetRequest(request)) return application.registry.handler(request)
            const input = {
              authority: application.authority,
              gateway: application.gateway,
              environment: application.environment,
              request,
            }
            if (websocket !== undefined) Object.assign(input, { websocket })
            return Effect.runPromise(application.handle(input))
          },
          close: () => application.registry.shutdown(),
        } satisfies ApiV2LocalHost),
      )
    }),
  )

/** Start the explicit Bun HTTP host used by local acceptance tests and development probes. */
export const serveApiV2LocalHost = (options: ApiV2LocalServerOptions) =>
  // ast-grep-ignore: effect-prefer-program-construction -- Bun Server is a foreign lifecycle API.
  Effect.tryPromise(async () => {
    const hostname = options.hostname ?? "127.0.0.1"
    const localOptions = { ...options, startRegistry: false }
    const registry = localOptions.registry
    const pool = { url: `http://${hostname}:${options.port}/api/rivet` }
    if (registry === undefined) Object.assign(localOptions, { registry: { configurePool: pool } })
    else if (registry.configurePool === undefined) Object.assign(localOptions, { registry: { ...registry, configurePool: pool } })
    const host = await Effect.runPromise(makeApiV2LocalHost(localOptions))
    const serveOptions = {
      port: options.port,
      fetch: host.fetch,
    }
    if (options.hostname !== undefined) Object.assign(serveOptions, { hostname: options.hostname })
    const server = Bun.serve<{ readonly request: Request; websocket?: RuntimeWebSocket }>({
      ...serveOptions,
      fetch: (request, runtime) => {
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return host.fetch(request)
        const accepted = runtime.upgrade(request, { data: { request } })
        return accepted ? undefined : new Response("WebSocket upgrade failed", { status: 400 })
      },
      websocket: {
        open: (socket) => {
          const data = socket.data
          const websocket = runtimeWebSocket({
            send: (payload) => {
              if (typeof payload === "string" || payload instanceof ArrayBuffer || payload instanceof Blob)
                return socket.send(payload)
              return socket.send(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength))
            },
            close: (code, reason) => socket.close(code, reason),
          })
          Object.assign(data, { websocket })
          // ast-grep-ignore: effect-prefer-promise-composition -- Bun WebSocket lifecycle is a foreign host callback.
          void host
            .fetch(data.request, websocket)
            .then((response) => {
              if (response.status !== 101) websocket.close(1008, `WebSocket rejected (${response.status})`)
              return undefined
            })
            .catch(() => websocket.close(1011, "WebSocket failed"))
        },
        message: (socket, message) => {
          const data = socket.data
          const websocket = data.websocket
          if (websocket === undefined) return
          websocket.dispatch?.({ data: typeof message === "string" ? message : String(message) })
        },
        close: (socket) => socket.data.websocket?.dispatch?.({ type: "close", data: undefined }),
      },
    })
    const ready = await host.registry.handler(new Request(`http://${server.hostname}:${server.port}/api/rivet/metadata`))
    if (!ready.ok) {
      await server.stop(true)
      await host.close()
      throw new Error(`Rivet registry readiness failed: ${ready.status}`)
    }
    return {
      ...host,
      url: `http://${server.hostname}:${server.port}`,
      // ast-grep-ignore: effect-prefer-program-construction -- Bun Server is a foreign lifecycle API.
      close: async () => {
        await server.stop(true)
        await host.close()
      },
    } satisfies ApiV2LocalServer
  })
