/* oxlint-disable anti-slop-effect/no-service-constructor-imports -- this explicit host is the application composition root. */
/* oxlint-disable effecttsgo/async-function -- the host exposes the platform Fetch contract. */
/* oxlint-disable effecttsgo/global-timers -- shutdown deadlines bridge the foreign host lifecycle. */
/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion */
import { Effect, Schema } from "effect"
import type { ApiV2ApplicationOptions, ApiV2ApplicationService } from "../application"
import { makeApiV2Application } from "../application"
import type { RuntimeRegistry } from "../runtime/rivet-actor"
import type { RuntimeWebSocket } from "./runtime-gateway"
import { workspaceExecutorWebSocketProtocol } from "@rika/execution"
import { prepareRunnerUpgrade, runnerThreadPath, type RunnerUpgrade } from "./runner-upgrade"
import { boxExecutorRequestId } from "../executor/box-enrollment"
import { canonicalPublicRequest } from "./public-request"

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
  readonly publicUrl?: string
}

export interface ApiV2LocalHostOptions extends ApiV2ApplicationOptions {
  /** Warm the Rivet serverless registry before returning. Defaults to true for explicit local compositions. */
  readonly startRegistry?: boolean
}

const isRivetRequest = (request: Request) => {
  const pathname = new URL(request.url).pathname
  return pathname === "/api/rivet" || pathname.startsWith("/api/rivet/")
}

const shutdownDeadlineMillis = 250

interface ActiveApplicationRequest {
  // ast-grep-ignore: effect-prefer-effect-signatures -- this interface is a foreign Fetch lifecycle adapter.
  readonly complete: Promise<void>
  // ast-grep-ignore: effect-prefer-effect-signatures -- this interface is a foreign Fetch lifecycle adapter.
  readonly abort: () => Promise<void>
}

const waitFor = (durationMillis: number) =>
  // oxlint-disable-next-line effecttsgo/new-promise -- this timer bridges the foreign host lifecycle boundary.
  new Promise<void>((resolve) => {
    // ast-grep-ignore: effect-prefer-scheduling -- this timer bounds a foreign transport shutdown.
    setTimeout(resolve, durationMillis)
  })

// ast-grep-ignore: effect-prefer-effect-signatures -- this helper is a foreign Fetch lifecycle adapter.
const bounded = async <A>(operation: Promise<A>, durationMillis: number) => {
  // oxlint-disable-next-line effecttsgo/promise-composition -- shutdown races foreign transport cleanup against a deadline.
  // ast-grep-ignore: effect-prefer-promise-composition -- shutdown races foreign transport cleanup against a deadline.
  await Promise.race([operation, waitFor(durationMillis)])
}

// ast-grep-ignore: effect-prefer-effect-signatures -- this helper tracks a foreign Fetch response body lifecycle.
const trackResponse = (active: Set<Promise<unknown>>, operation: Promise<Response>) => {
  // ast-grep-ignore: effect-prefer-promise-composition -- this helper tracks a foreign Fetch response lifecycle.
  const tracked = operation.then(
    (response) => {
      active.delete(tracked)
      if (response.body === null) return response
      if (response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") !== true) return response
      const reader = response.body.getReader()
      let resolveDone: (() => void) | undefined
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolveDone?.()
      }
      // oxlint-disable-next-line effecttsgo/new-promise -- Fetch body lifetime needs a foreign stream completion promise.
      const bodyDone = new Promise<void>((resolve) => {
        resolveDone = resolve
      })
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const result = await reader.read()
            if (result.done) {
              controller.close()
              finish()
              // oxlint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-type-assertion -- Bun's ReadableStream reader widens its chunk type.
            } else controller.enqueue(result.value as Uint8Array)
          } catch (error) {
            controller.error(error)
            finish()
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason)
          } finally {
            finish()
          }
        },
      })
      // ast-grep-ignore: effect-prefer-promise-composition -- this helper tracks a foreign Fetch response body.
      bodyDone.finally(() => active.delete(bodyDone)).catch(() => undefined)
      active.add(bodyDone)
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    },
    (error) => {
      active.delete(tracked)
      throw error
    },
  )
  active.add(tracked)
  return tracked
}

const trackApplicationResponse = (
  active: Set<ActiveApplicationRequest>,
  // ast-grep-ignore: effect-prefer-effect-signatures -- this argument is a foreign Fetch lifecycle adapter.
  operation: Promise<Response>,
  websocket: RuntimeWebSocket | undefined,
) => {
  let resolveComplete: (() => void) | undefined
  // ast-grep-ignore: effect-prefer-promise-composition -- this callback is a foreign Fetch lifecycle adapter.
  let abort = () => Promise.resolve()
  // oxlint-disable-next-line effecttsgo/new-promise -- this completion bridge tracks a foreign Fetch lifecycle.
  const complete = new Promise<void>((resolve) => {
    resolveComplete = resolve
  })
  const request: ActiveApplicationRequest = {
    complete,
    abort: () => abort(),
  }
  // ast-grep-ignore: effect-prefer-promise-composition -- this helper removes a foreign request after lifecycle close.
  complete.finally(() => active.delete(request)).catch(() => undefined)
  active.add(request)
  // ast-grep-ignore: effect-prefer-promise-composition -- this helper tracks a foreign Fetch response lifecycle.
  const tracked = operation.then(
    (response) => {
      if (response.status === 101 && websocket !== undefined) {
        let resolveSocket: (() => void) | undefined
        // oxlint-disable-next-line effecttsgo/new-promise -- this close bridge tracks a foreign WebSocket lifecycle.
        const socketClosed = new Promise<void>((resolve) => {
          resolveSocket = resolve
        })
        websocket.addEventListener?.("close", () => {
          resolveSocket?.()
          resolveComplete?.()
          active.delete(request)
        })
        abort = async () => {
          websocket.close(1001, "Rika host is closing")
          await bounded(socketClosed, shutdownDeadlineMillis)
          resolveSocket?.()
          resolveComplete?.()
          active.delete(request)
        }
        return response
      } else if (
        response.body !== null &&
        response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") === true
      ) {
        const reader = response.body.getReader()
        let bodyFinished = false
        let bodyCancelled = false
        let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined
        const finish = () => {
          if (bodyFinished) return
          bodyFinished = true
          resolveComplete?.()
        }
        abort = async () => {
          bodyCancelled = true
          bodyController?.error(new Error("Rika host is closing"))
          const cancellation = reader.cancel("Rika host is closing")
          await bounded(cancellation, shutdownDeadlineMillis)
          finish()
        }
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            bodyController = controller
            if (bodyCancelled) {
              controller.error(new Error("Rika host is closing"))
              finish()
              return
            }
            try {
              const result = await reader.read()
              if (result.done) {
                controller.close()
                finish()
                // oxlint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-type-assertion -- Bun's ReadableStream reader widens its chunk type.
              } else controller.enqueue(result.value as Uint8Array)
            } catch (error) {
              controller.error(error)
              finish()
            }
          },
          async cancel(reason) {
            try {
              await reader.cancel(reason)
            } finally {
              finish()
            }
          },
        })
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      }
      resolveComplete?.()
      active.delete(request)
      return response
    },
    (error) => {
      resolveComplete?.()
      active.delete(request)
      throw error
    },
  )
  return tracked
}

// ast-grep-ignore: effect-prefer-effect-signatures -- this helper drains foreign Fetch promises at shutdown.
const drain = (active: Set<Promise<unknown>>) =>
  // ast-grep-ignore: effect-prefer-promise-composition -- this helper drains a foreign Fetch promise set.
  Promise.allSettled(active).then(() => undefined)

const drainApplication = (active: Set<ActiveApplicationRequest>) =>
  // ast-grep-ignore: effect-prefer-promise-composition -- this helper drains a foreign Fetch request set.
  Promise.allSettled([...active].map((item) => item.complete)).then(() => undefined)

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
          : Effect.tryPromise(() =>
              application.registry.handler(new Request("http://rivet.local/api/rivet/metadata")),
            ).pipe(
              Effect.flatMap((response) =>
                response.ok
                  ? Effect.void
                  : Effect.fail(
                      ApiV2LocalHostError.make({ message: `Rivet registry readiness failed: ${response.status}` }),
                    ),
              ),
            )
      const activeApplication = new Set<ActiveApplicationRequest>()
      // ast-grep-ignore: effect-prefer-effect-signatures -- local host owns this foreign promise drain set.
      const activeRivet = new Set<Promise<unknown>>()
      let closed = false
      // ast-grep-ignore: effect-prefer-effect-signatures -- local host owns this foreign shutdown promise.
      let closePromise: Promise<void> | undefined
      const fetch = async (request: Request, websocket?: RuntimeWebSocket) => {
        if (closed) return new Response("Rika host is closed", { status: 503 })
        if (isRivetRequest(request)) return trackResponse(activeRivet, application.registry.handler(request))
        const input = {
          authority: application.authority,
          gateway: application.gateway,
          environment: application.environment,
          request,
        }
        if (options.product !== undefined) Object.assign(input, { product: options.product })
        if (websocket !== undefined) Object.assign(input, { websocket })
        return trackApplicationResponse(activeApplication, Effect.runPromise(application.handle(input)), websocket)
      }
      const close = async () => {
        if (closePromise !== undefined) return closePromise
        closed = true
        closePromise = (async () => {
          await bounded(
            // ast-grep-ignore: effect-prefer-promise-composition -- shutdown races foreign request aborts against a deadline.
            Promise.allSettled([...activeApplication].map((request) => request.abort())),
            shutdownDeadlineMillis,
          )
          await bounded(application.registry.shutdown(), shutdownDeadlineMillis)
          await bounded(drainApplication(activeApplication), shutdownDeadlineMillis)
          await bounded(drain(activeRivet), shutdownDeadlineMillis)
        })()
        return closePromise
      }
      return start.pipe(
        Effect.as({
          application,
          registry: application.registry,
          fetch,
          close,
        } satisfies ApiV2LocalHost),
      )
    }),
  )

/** Start the explicit Bun HTTP host used by local acceptance tests and development probes. */
export const serveApiV2LocalHost = (options: ApiV2LocalServerOptions) =>
  Effect.tryPromise(async () => {
    const hostname = options.hostname ?? "127.0.0.1"
    const localOptions = { ...options, startRegistry: false }
    const registry = localOptions.registry
    const pool = {
      url:
        options.publicUrl === undefined
          ? `http://${hostname}:${options.port}/api/rivet`
          : new URL("/api/rivet", options.publicUrl).href,
    }
    if (registry === undefined) Object.assign(localOptions, { registry: { configurePool: pool } })
    else if (registry.configurePool === undefined)
      Object.assign(localOptions, { registry: { ...registry, configurePool: pool } })
    const host = await Effect.runPromise(makeApiV2LocalHost(localOptions))
    const runnerUpgrades = new Set<RunnerUpgrade>()
    let stopping = false
    const serveOptions = {
      port: options.port,
      fetch: host.fetch,
    }
    if (options.hostname !== undefined) Object.assign(serveOptions, { hostname: options.hostname })
    const server = Bun.serve<{ readonly request: Request; websocket?: RuntimeWebSocket; runner?: RunnerUpgrade }>({
      ...serveOptions,
      fetch: async (request, runtime) => {
        if (stopping) return new Response("Rika server is closing", { status: 503 })
        const publicRequest = canonicalPublicRequest({ request, baseUrl: options.publicUrl })
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          const response = await host.fetch(publicRequest)
          if (
            response.ok &&
            response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") === true
          )
            runtime.timeout(request, 0)
          return response
        }
        const threadId = runnerThreadPath(request)
        const boxId = boxExecutorRequestId(request)
        const routingId = threadId ?? boxId
        if (routingId !== undefined) {
          const gateway = threadId === undefined ? options.boxGateway : options.runnerGateway
          if (gateway === undefined)
            return new Response("Workspace Executor connections are unavailable", { status: 503 })
          const runner = await Effect.runPromise(
            prepareRunnerUpgrade({
              request: publicRequest,
              threadId: routingId,
              gateway,
            }),
            { signal: request.signal },
          )
          if (runner instanceof Response) return runner
          runnerUpgrades.add(runner)
          if (
            !stopping &&
            runtime.upgrade(request, {
              data: { request: publicRequest, runner },
              headers: { "sec-websocket-protocol": workspaceExecutorWebSocketProtocol },
            })
          )
            return undefined
          runnerUpgrades.delete(runner)
          await Effect.runPromise(runner.close)
          return new Response("Runner WebSocket upgrade failed", { status: 503 })
        }
        const accepted = runtime.upgrade(request, { data: { request: publicRequest } })
        return accepted ? undefined : new Response("WebSocket upgrade failed", { status: 400 })
      },
      websocket: {
        open: (socket) => {
          const data = socket.data
          if (data.runner !== undefined) {
            Effect.runSync(
              data.runner.opened({
                send: (frame) => {
                  socket.send(frame)
                },
                close: (code, reason) => socket.close(code, reason),
              }),
            )
            return
          }
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
          if (data.runner !== undefined) {
            Effect.runFork(data.runner.receive(message))
            return
          }
          const websocket = data.websocket
          if (websocket === undefined) return
          websocket.dispatch?.({ data: typeof message === "string" ? message : String(message) })
        },
        close: (socket) => {
          const runner = socket.data.runner
          if (runner !== undefined) {
            runnerUpgrades.delete(runner)
            Effect.runFork(runner.close)
          } else socket.data.websocket?.dispatch?.({ type: "close", data: undefined })
        },
      },
    })
    const ready = await host.registry.handler(
      new Request(`http://${server.hostname}:${server.port}/api/rivet/metadata`),
    )
    if (!ready.ok) {
      try {
        await host.close()
      } finally {
        await server.stop(true)
      }
      throw new Error(`Rivet registry readiness failed: ${ready.status}`)
    }
    return {
      ...host,
      url: `http://${server.hostname}:${server.port}`,
      close: async () => {
        stopping = true
        try {
          await Effect.runPromise(
            Effect.forEach(runnerUpgrades, (runner) => runner.close, { concurrency: "unbounded", discard: true }),
          )
          runnerUpgrades.clear()
          await host.close()
        } finally {
          await server.stop(true)
        }
      },
    } satisfies ApiV2LocalServer
  })
