import { createHash, timingSafeEqual } from "node:crypto"
import { Diagnostics } from "@rika/core"
import { OrbChanges, OrbFiles, OrbPty } from "@rika/orb"
import { Artifact, Codec, Event, Ide, Ids, Remote } from "@rika/schema"
import { Cause, Context, Effect, Exit, Fiber, Layer, Option, Queue, Schema, Stream } from "effect"
import * as RemoteControl from "./remote-control"

const defaultHost = "127.0.0.1"
const defaultPort = 4587

export interface ServeInput extends Schema.Schema.Type<typeof ServeInput> {}
export const ServeInput = Schema.Struct({
  host: Schema.optional(Schema.String),
  port: Schema.optional(Schema.Int),
  token: Schema.optional(Schema.String),
  workspace_root: Schema.optional(Schema.String),
  orb: Schema.optional(Schema.Boolean),
  base_commit: Schema.optional(Schema.String),
}).annotate({ identifier: "Rika.Server.HttpServer.ServeInput" })

export interface ServerHandle {
  readonly url: string
  readonly close: () => Effect.Effect<void>
}

export class HttpServerError extends Schema.TaggedErrorClass<HttpServerError>()("HttpServerError", {
  message: Schema.String,
  operation: Schema.String,
}) {}

export interface Interface {
  readonly handle: (request: Request) => Effect.Effect<Response>
  readonly serve: (input?: ServeInput) => Effect.Effect<ServerHandle, HttpServerError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/server/HttpServer") {}

const serviceLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const remote = yield* RemoteControl.Service
    const diagnostics = yield* Diagnostics.Service
    const orbChanges = yield* OrbChanges.Service
    const orbFiles = yield* OrbFiles.Service
    const orbPty = yield* OrbPty.Service
    return makeService(remote, diagnostics, orbChanges, orbFiles, orbPty)
  }),
)

export const layerWithOrbServices = (
  orbChangesLayer: Layer.Layer<OrbChanges.Service>,
  orbFilesLayer: Layer.Layer<OrbFiles.Service>,
) => serviceLayer.pipe(Layer.provide(orbChangesLayer), Layer.provide(orbFilesLayer))

export const layerWithOrbChanges = (orbChangesLayer: Layer.Layer<OrbChanges.Service>) =>
  layerWithOrbServices(orbChangesLayer, OrbFiles.layer)

export const layerFromEnv = (env: Record<string, string | undefined>) =>
  layerWithOrbChanges(OrbChanges.layer).pipe(Layer.provide(OrbPty.layerFromEnv(env)))

export const layer = layerFromEnv({})

export const handle = Effect.fn("HttpServer.handle.call")(function* (request: Request) {
  const service = yield* Service
  return yield* service.handle(request)
})

export const serve = Effect.fn("HttpServer.serve.call")(function* (input: ServeInput = {}) {
  const service = yield* Service
  return yield* service.serve(input)
})

interface OrbRouteMode {
  readonly workspace_root: string
  readonly base_commit: string
}

export interface OrbPtySocketData {
  readonly pty: OrbPty.Interface
  readonly diagnostics: Diagnostics.Interface
  readonly workspace_root: string
  readonly cols: number
  readonly rows: number
  closed: boolean
  pendingMessages: Array<OrbPtyClientMessage>
  openFiber?: Fiber.Fiber<void>
  outputQueue?: Queue.Queue<Uint8Array>
  drainQueue?: Queue.Queue<void>
  forwarder?: Fiber.Fiber<void>
  session?: OrbPty.Session
}

interface OrbPtyUpgradeServer {
  readonly upgrade: (request: Request, options: { readonly data: OrbPtySocketData }) => boolean
}

export interface OrbPtyWebSocket {
  readonly data: OrbPtySocketData
  readonly send: (bytes: Uint8Array) => number
  readonly close: (code?: number, reason?: string) => void
}

interface ResizeControl extends Schema.Schema.Type<typeof ResizeControl> {}
const ResizeControl = Schema.Struct({
  type: Schema.Literal("resize"),
  cols: Schema.Int,
  rows: Schema.Int,
}).annotate({ identifier: "Rika.Server.HttpServer.OrbPty.ResizeControl" })

type OrbPtyClientMessage =
  | { readonly type: "resize"; readonly cols: number; readonly rows: number }
  | { readonly type: "write"; readonly bytes: Uint8Array }

const orbPtyOutputQueueSize = 256
const orbPtyPendingMessageLimit = 256

const emptyOrbPtySocketData: OrbPtySocketData = {
  pty: OrbPty.Service.of({
    open: () =>
      Effect.fail(
        new OrbPty.OrbPtyError({
          message: "PTY socket data was not initialized",
          operation: "open",
        }),
      ),
  }),
  diagnostics: Diagnostics.Service.of({
    emit: () => Effect.die(new Error("PTY socket diagnostics were not initialized")),
    redactEntry: () => {
      throw new Error("PTY socket diagnostics were not initialized")
    },
    redactFields: () => {
      throw new Error("PTY socket diagnostics were not initialized")
    },
  }),
  workspace_root: "",
  cols: 80,
  rows: 24,
  closed: true,
  pendingMessages: [],
}

export const orbPtyWebSocketHandler: Bun.WebSocketHandler<OrbPtySocketData> = {
  data: emptyOrbPtySocketData,
  open: openOrbPtyWebSocket,
  message: messageOrbPtyWebSocket,
  drain: drainOrbPtyWebSocket,
  close: closeOrbPtyWebSocketHandler,
}

export function openOrbPtyWebSocket(ws: OrbPtyWebSocket) {
  const data = ws.data
  let fiber: Fiber.Fiber<void> | undefined
  fiber = Effect.runFork(
    Effect.suspend(() =>
      Effect.gen(function* () {
        const outputQueue = yield* Queue.bounded<Uint8Array>(orbPtyOutputQueueSize)
        const drainQueue = yield* Queue.unbounded<void>()
        const forwarder = yield* Effect.sync(() => Effect.runFork(forwardOrbPtyOutput(ws, outputQueue, drainQueue)))
        const ready = yield* Effect.sync(() => {
          if (data.closed) return false
          data.outputQueue = outputQueue
          data.drainQueue = drainQueue
          data.forwarder = forwarder
          return true
        })
        if (!ready) {
          yield* Fiber.interrupt(forwarder)
          yield* Queue.shutdown(outputQueue)
          yield* Queue.shutdown(drainQueue)
          return
        }
        const session = yield* data.pty.open({
          workspace_root: data.workspace_root,
          cols: data.cols,
          rows: data.rows,
          onData: (bytes) =>
            Effect.sync(() => {
              const queue = data.outputQueue
              if (data.closed || queue === undefined) return
              const offered = Queue.offerUnsafe(queue, new Uint8Array(bytes))
              if (!offered) closeOrbPtySocket(ws, 1011, "pty output buffer full", "output_overflow")
            }),
          onExit: (exit) =>
            Effect.sync(() => {
              closeOrbPtySocket(ws, 1000, `pty ${exit.source} exited`, "pty_exit")
            }),
        })
        const pending = yield* Effect.sync(() => {
          if (data.closed) return undefined
          data.session = session
          const messages = data.pendingMessages
          data.pendingMessages = []
          return messages
        })
        if (pending === undefined) {
          yield* session.close.pipe(Effect.ignore)
          return
        }
        yield* Effect.forEach(pending, (message) => applyOrbPtyClientMessage(ws, session, message), { discard: true })
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            closeOrbPtySocket(ws, 1011, "pty open failed", "open_failed")
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            const current = fiber
            if (current !== undefined && data.openFiber === current) delete data.openFiber
          }),
        ),
      ),
    ),
  )
  if (!data.closed) data.openFiber = fiber
}

export function messageOrbPtyWebSocket(ws: OrbPtyWebSocket, message: string | Buffer<ArrayBuffer>) {
  const decoded = decodeOrbPtyClientMessage(message)
  if (decoded === undefined) {
    closeOrbPtySocket(ws, 1008, "invalid control frame", "invalid_message")
    return
  }
  const session = ws.data.session
  if (session === undefined) {
    if (ws.data.pendingMessages.length >= orbPtyPendingMessageLimit) {
      closeOrbPtySocket(ws, 1011, "pty input buffer full", "input_overflow")
      return
    }
    ws.data.pendingMessages.push(decoded)
    return
  }
  Effect.runFork(applyOrbPtyClientMessage(ws, session, decoded))
}

export function drainOrbPtyWebSocket(ws: OrbPtyWebSocket) {
  const drainQueue = ws.data.drainQueue
  if (drainQueue !== undefined) Queue.offerUnsafe(drainQueue, undefined)
}

export function closeOrbPtyWebSocketHandler(ws: OrbPtyWebSocket, code: number = 1000, reason: string = "") {
  finalizeOrbPtySocket(ws, code, reason, "websocket_close")
}

const upgradeOrbPty = (
  orbPty: OrbPty.Interface,
  diagnostics: Diagnostics.Interface,
  request: Request,
  server: OrbPtyUpgradeServer,
  requiredToken: string | undefined,
  orbMode: OrbRouteMode | undefined,
) => {
  const url = new URL(request.url)
  if (request.method !== "GET" || url.pathname !== "/v1/orb/pty") return undefined
  if (orbMode === undefined) return notFound()
  const required = tokenValue(requiredToken)
  if (required !== undefined && !constantTimeTokenEquals(url.searchParams.get("token"), required))
    return unauthorizedJson()
  const upgraded = server.upgrade(request, {
    data: {
      pty: orbPty,
      diagnostics,
      workspace_root: orbMode.workspace_root,
      cols: dimensionOrDefault(intParam(url, "cols"), 80, 1, 500),
      rows: dimensionOrDefault(intParam(url, "rows"), 24, 1, 300),
      closed: false,
      pendingMessages: [],
    },
  })
  return upgraded ? undefined : json({ error: { message: "WebSocket upgrade failed", code: "upgrade_failed" } }, 400)
}

const decodeResizeControl = (message: string): ResizeControl | undefined => {
  try {
    const decoded = Schema.decodeUnknownSync(ResizeControl)(JSON.parse(message))
    if (!validDimension(decoded.cols, 1, 500) || !validDimension(decoded.rows, 1, 300)) return undefined
    return decoded
  } catch {
    return undefined
  }
}

const binaryMessage = (message: ArrayBuffer | Uint8Array) =>
  message instanceof Uint8Array ? message : new Uint8Array(message)

const decodeOrbPtyClientMessage = (message: string | Buffer<ArrayBuffer>): OrbPtyClientMessage | undefined => {
  if (typeof message === "string") {
    const resize = decodeResizeControl(message)
    return resize === undefined ? undefined : { type: "resize", cols: resize.cols, rows: resize.rows }
  }
  return { type: "write", bytes: binaryMessage(message) }
}

const applyOrbPtyClientMessage = (ws: OrbPtyWebSocket, session: OrbPty.Session, message: OrbPtyClientMessage) => {
  const applied = message.type === "resize" ? session.resize(message.cols, message.rows) : session.write(message.bytes)
  return applied.pipe(
    Effect.catch(() =>
      Effect.sync(() => {
        closeOrbPtySocket(ws, 1011, message.type === "resize" ? "pty resize failed" : "pty write failed", message.type)
      }),
    ),
  )
}

const forwardOrbPtyOutput = (
  ws: OrbPtyWebSocket,
  outputQueue: Queue.Queue<Uint8Array>,
  drainQueue: Queue.Queue<void>,
) =>
  Effect.forever(Queue.take(outputQueue).pipe(Effect.flatMap((bytes) => sendOrbPtyOutput(ws, bytes, drainQueue)))).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.sync(() => {
            closeOrbPtySocket(ws, 1011, "pty output forwarding failed", "output_forward")
          }),
    ),
  )

const sendOrbPtyOutput = (ws: OrbPtyWebSocket, bytes: Uint8Array, drainQueue: Queue.Queue<void>) =>
  Effect.suspend(() => {
    if (ws.data.closed) return Effect.void
    const status = ws.send(bytes)
    if (status > 0) return Effect.void
    if (status === -1) return Queue.take(drainQueue)
    return Effect.sync(() => {
      closeOrbPtySocket(ws, 1011, "pty output dropped", "output_dropped")
    })
  })

const closeOrbPtySocket = (ws: OrbPtyWebSocket, code: number, reason: string, source: string) => {
  const shouldClose = !ws.data.closed
  if (shouldClose) ws.close(code, reason)
  finalizeOrbPtySocket(ws, code, reason, source)
}

const finalizeOrbPtySocket = (ws: OrbPtyWebSocket, code: number, reason: string, source: string) => {
  const data = ws.data
  if (data.closed) return
  data.closed = true
  const openFiber = data.openFiber
  const forwarder = data.forwarder
  const outputQueue = data.outputQueue
  const drainQueue = data.drainQueue
  const session = data.session
  delete data.openFiber
  delete data.forwarder
  delete data.outputQueue
  delete data.drainQueue
  delete data.session
  data.pendingMessages = []
  if (openFiber !== undefined) Effect.runFork(Fiber.interrupt(openFiber))
  if (forwarder !== undefined) Effect.runFork(Fiber.interrupt(forwarder))
  if (outputQueue !== undefined) Effect.runFork(Queue.shutdown(outputQueue).pipe(Effect.asVoid))
  if (drainQueue !== undefined) Effect.runFork(Queue.shutdown(drainQueue).pipe(Effect.asVoid))
  if (session !== undefined) Effect.runFork(session.close.pipe(Effect.ignore))
  emitOrbPtySocketClose(data, code, reason, source)
}

const emitOrbPtySocketClose = (data: OrbPtySocketData, code: number, reason: string, source: string) => {
  Effect.runFork(
    Diagnostics.event("orb_pty.websocket_close", () => Effect.void, {
      workspace_root: data.workspace_root,
      code,
      reason,
      source,
    }).pipe(
      Effect.provideService(Diagnostics.Service, data.diagnostics),
      Effect.catchCause(() => Effect.void),
    ),
  )
}

const dimensionOrDefault = (value: number | undefined, fallback: number, minimum: number, maximum: number) =>
  value === undefined || !validDimension(value, minimum, maximum) ? fallback : value

const validDimension = (value: number, minimum: number, maximum: number) =>
  Number.isInteger(value) && value >= minimum && value <= maximum

const unauthorizedJson = () => json({ error: { message: "Unauthorized", code: "unauthorized" } }, 401)

const makeService = (
  remote: RemoteControl.Interface,
  diagnostics: Diagnostics.Interface,
  orbChanges: OrbChanges.Interface,
  orbFiles: OrbFiles.Interface,
  orbPty: OrbPty.Interface,
): Interface => {
  const handleRequest = (request: Request, requiredToken?: string, orbMode?: OrbRouteMode) =>
    route(remote, orbChanges, orbFiles, request, tokenValue(requiredToken), orbMode).pipe(
      Effect.provideService(Diagnostics.Service, diagnostics),
    )
  return Service.of({
    handle: (request) => handleRequest(request),
    serve: Effect.fn("HttpServer.serve")(function* (input: ServeInput = {}) {
      const host = input.host ?? defaultHost
      const port = input.port ?? defaultPort
      const orbMode = yield* orbRouteMode(input)
      if (!isLoopbackHost(host) && (input.token ?? "").length === 0) {
        return yield* new HttpServerError({
          message: "refusing to bind non-loopback host without --token",
          operation: "serve",
        })
      }
      const server = yield* Effect.try({
        try: () =>
          Bun.serve({
            hostname: host,
            port,
            fetch: (request, upgradeServer) => {
              const upgraded = upgradeOrbPty(orbPty, diagnostics, request, upgradeServer, input.token, orbMode)
              if (upgraded !== undefined) return upgraded
              return Effect.runPromise(handleRequest(request, input.token, orbMode))
            },
            websocket: {
              ...orbPtyWebSocketHandler,
              backpressureLimit: 1024 * 1024,
              closeOnBackpressureLimit: true,
            },
          }),
        catch: (cause) =>
          new HttpServerError({
            message: cause instanceof Error ? cause.message : String(cause),
            operation: "serve",
          }),
      })
      return {
        url: `http://${server.hostname}:${server.port}`,
        close: () => Effect.sync(() => server.stop(true)),
      }
    }),
  })
}

const orbRouteMode = (input: ServeInput): Effect.Effect<OrbRouteMode | undefined, HttpServerError> => {
  if (input.orb !== true) return Effect.succeed(undefined)
  if (input.workspace_root === undefined || input.base_commit === undefined) {
    return Effect.fail(
      new HttpServerError({
        message: "orb server mode requires --workspace and --base-commit",
        operation: "serve",
      }),
    )
  }
  return Effect.succeed({ workspace_root: input.workspace_root, base_commit: input.base_commit })
}

const route = (
  remote: RemoteControl.Interface,
  orbChanges: OrbChanges.Interface,
  orbFiles: OrbFiles.Interface,
  request: Request,
  requiredToken: string | undefined,
  orbMode: OrbRouteMode | undefined,
): Effect.Effect<Response, never, Diagnostics.Service> => {
  const url = new URL(request.url)
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID()
  return Diagnostics.event(
    "http.request",
    (fields) =>
      dispatch(remote, orbChanges, orbFiles, request, url, requiredToken, orbMode).pipe(
        Effect.tap((response) =>
          Effect.sync(() => {
            fields.status_code = response.status
          }),
        ),
        Effect.tapCause((cause: Cause.Cause<RemoteControl.RunError>) =>
          Effect.sync(() => {
            fields.status_code = errorResponseFromCause(cause).status
          }),
        ),
      ),
    requestFields(request, url, requestId),
  ).pipe(
    Effect.catchCause((cause: Cause.Cause<RemoteControl.RunError>) => Effect.succeed(errorResponseFromCause(cause))),
  )
}

const requestFields = (request: Request, url: URL, requestId: string): Diagnostics.Fields => {
  const segments = url.pathname.split("/").filter(Boolean)
  const threadIdPath =
    segments[1] === "threads" && segments[2] !== undefined && segments[2] !== "search"
      ? decodeURIComponent(segments[2])
      : undefined
  const artifactIdPath =
    segments[1] === "artifacts" && segments[2] !== undefined ? decodeURIComponent(segments[2]) : undefined
  const threadIdQuery = url.searchParams.get("thread_id")
  const workspaceId = url.searchParams.get("workspace_id")
  const userId = url.searchParams.get("user_id")
  const threadId = threadIdPath ?? threadIdQuery ?? undefined
  return {
    method: request.method,
    path: url.pathname,
    request_id: requestId,
    ...(threadId === undefined ? {} : { thread_id: threadId }),
    ...(artifactIdPath === undefined ? {} : { artifact_id: artifactIdPath }),
    ...(workspaceId === null ? {} : { workspace_id: workspaceId }),
    ...(userId === null ? {} : { user_id: userId }),
  }
}

const dispatch = (
  remote: RemoteControl.Interface,
  orbChanges: OrbChanges.Interface,
  orbFiles: OrbFiles.Interface,
  request: Request,
  url: URL,
  requiredToken: string | undefined,
  orbMode: OrbRouteMode | undefined,
): Effect.Effect<Response, RemoteControl.RunError, Diagnostics.Service> =>
  Effect.gen(function* () {
    if (url.pathname === "/health")
      return isAuthorized(request, requiredToken)
        ? yield* remote.backendHealth(serverUrl(url)).pipe(jsonEffect(Remote.BackendHealth))
        : json(Codec.encode(Remote.PublicBackendHealth)({ status: "ok" }))

    const unauthorized = unauthorizedResponse(request, requiredToken)
    if (unauthorized !== undefined) return unauthorized
    const authorization = authorizationFromToken(requiredToken)

    const segments = url.pathname.split("/").filter(Boolean)
    if (segments[0] !== "v1") return notFound()

    if (request.method === "GET" && segments[1] === "orb" && segments[2] === "files" && segments.length === 3) {
      if (orbMode === undefined) return notFound()
      const path = url.searchParams.get("path") ?? ""
      return yield* orbFiles
        .list({ workspace_root: orbMode.workspace_root, path })
        .pipe(Effect.mapError(orbFilesError), jsonEffect(Remote.OrbFilesResponse))
    }

    if (request.method === "GET" && segments[1] === "orb" && segments[2] === "file" && segments.length === 3) {
      if (orbMode === undefined) return notFound()
      const path = yield* orbFilePath(url)
      return yield* orbFiles
        .read({ workspace_root: orbMode.workspace_root, path })
        .pipe(Effect.mapError(orbFilesError), jsonEffect(Remote.OrbFileResponse))
    }

    if (request.method === "GET" && segments[1] === "orb" && segments[2] === "changes" && segments.length === 3) {
      if (orbMode === undefined) return notFound()
      return yield* orbChanges
        .changes({ workspace_root: orbMode.workspace_root, base_commit: orbMode.base_commit })
        .pipe(
          Effect.mapError(
            (error) =>
              new RemoteControl.RemoteControlError({
                message: error.message,
                operation: error.operation,
                status: 500,
              }),
          ),
          jsonEffect(Remote.OrbChangesResponse),
        )
    }

    if (request.method === "GET" && segments[1] === "threads" && segments.length === 2) {
      const input = withAuthorization(listThreadsRequest(url), authorization)
      return yield* remote.listThreads(input).pipe(jsonEffect(Schema.Array(Remote.ThreadSummary)))
    }

    if (request.method === "POST" && segments[1] === "threads" && segments.length === 2) {
      const input = withAuthorization(yield* decodeBody(request, Remote.CreateThreadRequest), authorization)
      return yield* remote.createThread(input).pipe(jsonEffect(Remote.ThreadSummary))
    }

    if (request.method === "POST" && segments[1] === "orbs" && segments.length === 2) {
      const input = yield* decodeBody(request, Remote.CreateOrbThreadRequest)
      return yield* remote.createOrbThread(input).pipe(jsonEffect(Remote.ThreadSummary))
    }

    if (request.method === "GET" && segments[1] === "orbs" && segments.length === 2) {
      return yield* remote.listOrbs().pipe(jsonEffect(Schema.Array(Remote.OrbSummary)))
    }

    if (
      request.method === "GET" &&
      segments[1] === "orbs" &&
      segments[2] === "by-thread" &&
      segments[3] !== undefined &&
      segments.length === 4
    ) {
      return yield* remote
        .getOrbByThread(Ids.ThreadId.make(decodeURIComponent(segments[3])))
        .pipe(jsonEffect(Remote.OrbSummary))
    }

    if (
      request.method === "POST" &&
      segments[1] === "orbs" &&
      segments[2] !== undefined &&
      segments[3] === "pause" &&
      segments.length === 4
    ) {
      return yield* remote.pauseOrb(Ids.OrbId.make(decodeURIComponent(segments[2]))).pipe(jsonEffect(Remote.OrbSummary))
    }

    if (
      request.method === "POST" &&
      segments[1] === "orbs" &&
      segments[2] !== undefined &&
      segments[3] === "resume" &&
      segments.length === 4
    ) {
      return yield* remote
        .resumeOrb(Ids.OrbId.make(decodeURIComponent(segments[2])))
        .pipe(jsonEffect(Remote.OrbSummary))
    }

    if (
      request.method === "POST" &&
      segments[1] === "orbs" &&
      segments[2] !== undefined &&
      segments[3] === "kill" &&
      segments.length === 4
    ) {
      return yield* remote.killOrb(Ids.OrbId.make(decodeURIComponent(segments[2]))).pipe(jsonEffect(Remote.OrbSummary))
    }

    if (request.method === "GET" && segments[1] === "projects" && segments.length === 2) {
      return yield* remote.listProjects().pipe(jsonEffect(Schema.Array(Remote.ProjectSummary)))
    }

    if (request.method === "POST" && segments[1] === "projects" && segments.length === 2) {
      const input = yield* decodeBody(request, Remote.CreateProjectRequest)
      return yield* remote.createProject(input).pipe(jsonEffect(Remote.ProjectDetail))
    }

    if (request.method === "GET" && segments[1] === "projects" && segments[2] !== undefined && segments.length === 3) {
      return yield* remote
        .getProject(Ids.ProjectId.make(decodeURIComponent(segments[2])))
        .pipe(jsonEffect(Remote.ProjectDetail))
    }

    if (
      request.method === "PATCH" &&
      segments[1] === "projects" &&
      segments[2] !== undefined &&
      segments.length === 3
    ) {
      const input = yield* decodeBody(request, Remote.UpdateProjectRequest)
      return yield* remote
        .updateProject(Ids.ProjectId.make(decodeURIComponent(segments[2])), input)
        .pipe(jsonEffect(Remote.ProjectDetail))
    }

    if (
      request.method === "PUT" &&
      segments[1] === "projects" &&
      segments[2] !== undefined &&
      segments[3] === "secrets" &&
      segments[4] !== undefined &&
      segments.length === 5
    ) {
      const input = yield* decodeBody(request, Remote.SetProjectSecretRequest)
      return yield* remote
        .setProjectSecret(Ids.ProjectId.make(decodeURIComponent(segments[2])), decodeURIComponent(segments[4]), input)
        .pipe(jsonEffect(Remote.ProjectDetail))
    }

    if (
      request.method === "DELETE" &&
      segments[1] === "projects" &&
      segments[2] !== undefined &&
      segments[3] === "secrets" &&
      segments[4] !== undefined &&
      segments.length === 5
    ) {
      return yield* remote
        .deleteProjectSecret(Ids.ProjectId.make(decodeURIComponent(segments[2])), decodeURIComponent(segments[4]))
        .pipe(jsonEffect(Remote.ProjectDetail))
    }

    if (request.method === "GET" && segments[1] === "threads" && segments[2] === "search" && segments.length === 3) {
      const input = withAuthorization(searchThreadsRequest(url), authorization)
      return yield* remote.searchThreads(input).pipe(jsonEffect(Schema.Array(Remote.ThreadSearchResult)))
    }

    if (request.method === "GET" && segments[1] === "threads" && segments[2] !== undefined && segments.length === 3) {
      const input = withAuthorization(openThreadRequest(url, segments[2]), authorization)
      return yield* remote.openThread(input).pipe(jsonEffect(Remote.ThreadRecord))
    }

    if (
      request.method === "GET" &&
      segments[1] === "threads" &&
      segments[2] !== undefined &&
      segments[3] === "preview" &&
      segments.length === 4
    ) {
      const input = withAuthorization(previewThreadRequest(url, segments[2]), authorization)
      return yield* remote.previewThread(input).pipe(jsonEffect(Remote.ThreadRecord))
    }

    if (
      request.method === "POST" &&
      segments[1] === "threads" &&
      segments[2] !== undefined &&
      segments[3] === "visibility" &&
      segments.length === 4
    ) {
      const input = withAuthorization(yield* setThreadVisibilityRequest(request, url, segments[2]), authorization)
      return yield* remote.setThreadVisibility(input).pipe(jsonEffect(Remote.ThreadSummary))
    }

    if (
      request.method === "POST" &&
      segments[1] === "threads" &&
      segments[2] !== undefined &&
      segments[3] === "archive" &&
      segments.length === 4
    ) {
      const input = withAuthorization(archiveThreadRequest(url, segments[2]), authorization)
      return yield* remote.archiveThread(input).pipe(jsonEffect(Remote.ThreadSummary))
    }

    if (
      request.method === "POST" &&
      segments[1] === "threads" &&
      segments[2] !== undefined &&
      segments[3] === "unarchive" &&
      segments.length === 4
    ) {
      const input = withAuthorization(archiveThreadRequest(url, segments[2]), authorization)
      return yield* remote.unarchiveThread(input).pipe(jsonEffect(Remote.ThreadSummary))
    }

    if (
      request.method === "POST" &&
      segments[1] === "threads" &&
      segments[2] !== undefined &&
      segments[3] === "compact" &&
      segments.length === 4
    ) {
      const input = withAuthorization(compactThreadRequest(url, segments[2]), authorization)
      return yield* remote.compactThread(input).pipe(jsonEffect(Event.ContextCompacted))
    }

    if (
      request.method === "POST" &&
      segments[1] === "threads" &&
      segments[2] !== undefined &&
      segments[3] === "fork" &&
      segments.length === 4
    ) {
      const input = withAuthorization(yield* forkThreadRequest(request, segments[2]), authorization)
      return yield* remote.forkThread(input).pipe(jsonEffect(Remote.ThreadSummary))
    }

    if (
      request.method === "GET" &&
      segments[1] === "threads" &&
      segments[2] !== undefined &&
      segments[3] === "share" &&
      segments.length === 4
    ) {
      const input = withAuthorization(shareThreadRequest(url, segments[2]), authorization)
      return yield* remote.shareThread(input).pipe(jsonEffect(Remote.ThreadExport))
    }

    if (
      request.method === "GET" &&
      segments[1] === "threads" &&
      segments[2] !== undefined &&
      segments[3] === "reference" &&
      segments.length === 4
    ) {
      const input = withAuthorization(referenceThreadRequest(url, segments[2]), authorization)
      return yield* remote.referenceThread(input).pipe(jsonEffect(Remote.ThreadReference))
    }

    if (
      request.method === "GET" &&
      segments[1] === "threads" &&
      segments[2] !== undefined &&
      segments[3] === "events" &&
      segments.length === 4
    ) {
      const input = withAuthorization(subscribeThreadEventsRequest(url, segments[2]), authorization)
      const diagnostics = yield* Diagnostics.Service
      return ndjson(
        diagnostics,
        input.thread_id,
        Stream.merge(
          remote.subscribeThreadEvents(input).pipe(Stream.map((event): Remote.StreamFrame => event)),
          remote.subscribeThreadPresence(input).pipe(Stream.map((frame): Remote.StreamFrame => frame)),
        ),
      )
    }

    if (
      request.method === "POST" &&
      segments[1] === "threads" &&
      segments[2] !== undefined &&
      segments[3] === "presence" &&
      segments.length === 4
    ) {
      const input = withAuthorization(yield* setThreadPresenceRequest(request, segments[2]), authorization)
      return yield* remote.setThreadPresence(input).pipe(jsonEffect(Remote.PresenceFrame))
    }

    if (request.method === "POST" && segments[1] === "turns" && segments.length === 2) {
      const input = withAuthorization(yield* decodeBody(request, Remote.StartTurnRequest), authorization)
      return yield* remote.startTurn(input).pipe(jsonEffect(Remote.StartTurnResponse))
    }

    if (request.method === "POST" && segments[1] === "turns" && segments[2] === "interrupt" && segments.length === 3) {
      const input = withAuthorization(yield* decodeBody(request, Remote.InterruptTurnRequest), authorization)
      return yield* remote.interruptTurn(input).pipe(jsonEffect(Event.TurnTerminal))
    }

    if (request.method === "GET" && segments[1] === "artifacts" && segments.length === 2) {
      const input = withAuthorization(yield* listArtifactsRequest(url), authorization)
      return yield* remote.listArtifacts(input).pipe(jsonEffect(Schema.Array(Artifact.Artifact)))
    }

    if (request.method === "GET" && segments[1] === "artifacts" && segments[2] !== undefined && segments.length === 3) {
      const input = withAuthorization(getArtifactRequest(url, segments[2]), authorization)
      return yield* remote.getArtifact(input).pipe(jsonEffect(Artifact.Artifact))
    }

    if (request.method === "GET" && segments[1] === "ide" && segments[2] === "status" && segments.length === 3) {
      return yield* remote.ideStatus().pipe(jsonEffect(Ide.Status))
    }

    if (request.method === "POST" && segments[1] === "ide" && segments[2] === "connect" && segments.length === 3) {
      const input = yield* decodeBody(request, Ide.ConnectRequest)
      return yield* remote.connectIde(input).pipe(jsonEffect(Ide.ConnectResponse))
    }

    if (request.method === "POST" && segments[1] === "ide" && segments[2] === "disconnect" && segments.length === 3) {
      const input = yield* decodeBody(request, Ide.DisconnectRequest)
      return yield* remote.disconnectIde(input).pipe(jsonEffect(Ide.Status))
    }

    if (request.method === "POST" && segments[1] === "ide" && segments[2] === "context" && segments.length === 3) {
      const input = yield* decodeBody(request, Ide.UpdateContextRequest)
      return yield* remote.updateIdeContext(input).pipe(jsonEffect(Ide.Status))
    }

    if (request.method === "POST" && segments[1] === "ide" && segments[2] === "open-file" && segments.length === 3) {
      const input = yield* decodeBody(request, Ide.OpenFileRequest)
      return yield* remote.openIdeFile(input).pipe(jsonEffect(Ide.OpenFileResult))
    }

    if (
      request.method === "GET" &&
      segments[1] === "ide" &&
      segments[2] === "navigation-requests" &&
      segments.length === 3
    ) {
      return yield* remote.ideNavigationRequests().pipe(jsonEffect(Schema.Array(Ide.OpenFileRequest)))
    }

    return notFound()
  })

const unauthorizedResponse = (request: Request, requiredToken: string | undefined) => {
  if (requiredToken === undefined) return undefined
  if (isAuthorized(request, requiredToken)) return undefined
  return json({ error: { message: "Unauthorized", code: "unauthorized" } }, 401)
}

const isAuthorized = (request: Request, requiredToken: string | undefined) =>
  requiredToken !== undefined &&
  constantTimeTokenEquals(request.headers.get("authorization"), `Bearer ${requiredToken}`)

const tokenValue = (token: string | undefined) => (token === undefined || token.length === 0 ? undefined : token)

const constantTimeTokenEquals = (actual: string | null | undefined, expected: string): boolean => {
  const actualValue = actual ?? ""
  const actualDigest = tokenDigest(actualValue)
  const expectedDigest = tokenDigest(expected)
  return timingSafeEqual(actualDigest, expectedDigest) && actualValue.length === expected.length
}

const tokenDigest = (value: string) => createHash("sha256").update(value, "utf8").digest()

const authorizationFromToken = (token: string | undefined): RemoteControl.AuthorizationContext => {
  const userId = userIdFromToken(token)
  return userId === undefined ? {} : { authorization_user_id: userId }
}

const userIdFromToken = (token: string | undefined): Ids.UserId | undefined => {
  if (token === undefined || !token.startsWith("user:")) return undefined
  const separator = token.indexOf(":", "user:".length)
  if (separator <= "user:".length) return undefined
  try {
    return Ids.UserId.make(decodeURIComponent(token.slice("user:".length, separator)))
  } catch {
    return undefined
  }
}

const withAuthorization = <A extends object>(
  input: A,
  authorization: RemoteControl.AuthorizationContext,
): A & RemoteControl.AuthorizationContext =>
  authorization.authorization_user_id === undefined
    ? input
    : { ...input, authorization_user_id: authorization.authorization_user_id }

const orbFilePath = (url: URL): Effect.Effect<string, RemoteControl.RemoteControlError> => {
  const path = url.searchParams.get("path")
  if (path !== null && path.length > 0) return Effect.succeed(path)
  return Effect.fail(
    new RemoteControl.RemoteControlError({
      message: "path query parameter is required",
      operation: "orbFile",
      status: 400,
    }),
  )
}

const orbFilesError = (error: OrbFiles.OrbFilesError) =>
  new RemoteControl.RemoteControlError({
    message: error.message,
    operation: error.operation,
    status:
      error.kind === "invalid_path" || error.kind === "not_file" || error.kind === "not_directory"
        ? 400
        : error.kind === "not_found"
          ? 404
          : 500,
  })

const isLoopbackHost = (host: string) => {
  const normalized = host.toLowerCase()
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]"
}

const decodeBody = <const S extends Schema.ConstraintDecoder<unknown>>(request: Request, schema: S) =>
  Effect.tryPromise({
    try: async () => Schema.decodeUnknownSync(schema)(await request.json()),
    catch: (cause) =>
      new RemoteControl.RemoteControlError({
        message: cause instanceof Error ? cause.message : String(cause),
        operation: "decodeBody",
        status: 400,
      }),
  })

const jsonEffect =
  <const S extends Schema.ConstraintEncoder<unknown>>(schema: S) =>
  <E>(effect: Effect.Effect<S["Type"], E>): Effect.Effect<Response, E> =>
    effect.pipe(Effect.map((value) => json(Codec.encode(schema)(value))))

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })

const ndjson = (
  diagnostics: Diagnostics.Interface,
  threadId: Ids.ThreadId,
  events: Stream.Stream<Remote.StreamFrame, RemoteControl.RunError>,
) => {
  const encoder = new TextEncoder()
  let frames = 0
  let closeReason = "completed"
  let closeDetail: string | undefined
  const encodeFrame = (frame: Remote.StreamFrame) => {
    frames += 1
    return encoder.encode(`${JSON.stringify(Codec.encode(Remote.StreamFrame)(frame))}\n`)
  }
  const emitClose = (reason: string) =>
    diagnostics
      .emit({
        level: reason === "error" ? "error" : "info",
        message: `thread.stream ${reason}`,
        data: {
          op: "thread.stream",
          thread_id: threadId,
          close_reason: reason,
          frames_sent: frames,
          ...(closeDetail === undefined ? {} : { error: closeDetail }),
        },
      })
      .pipe(Effect.catchCause(() => Effect.void))
  const body = events.pipe(
    Stream.catchCause((cause: Cause.Cause<RemoteControl.RunError>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        closeReason = "client_closed"
        return Stream.empty
      }
      closeReason = "error"
      closeDetail = Cause.pretty(cause)
      return Stream.make(errorFrameFromCause(cause))
    }),
    Stream.map(encodeFrame),
    Stream.onExit((exit) =>
      emitClose(Exit.isSuccess(exit) ? closeReason : Cause.hasInterruptsOnly(exit.cause) ? "client_closed" : "error"),
    ),
    Stream.toReadableStream,
  )
  return new Response(body, { headers: { "content-type": "application/x-ndjson" } })
}

const errorResponse = (error: RemoteControl.RunError) =>
  json(RemoteControl.errorToApi(error), RemoteControl.statusFromError(error))

const errorResponseFromCause = (cause: Cause.Cause<RemoteControl.RunError>) => {
  const failure = Cause.findErrorOption(cause)
  if (Option.isSome(failure)) return errorResponse(failure.value)
  if (Cause.hasInterruptsOnly(cause))
    return json({ error: { message: "Request interrupted", code: "interrupted" } }, 499)
  return errorResponse(causeError(cause, "handle"))
}

const errorFrameFromCause = (cause: Cause.Cause<RemoteControl.RunError>): Remote.ApiError => {
  const failure = Cause.findErrorOption(cause)
  if (Option.isSome(failure)) return RemoteControl.errorToApi(failure.value)
  return RemoteControl.errorToApi(causeError(cause, "stream"))
}

const causeError = (cause: Cause.Cause<RemoteControl.RunError>, operation: string) =>
  new RemoteControl.RemoteControlError({ message: Cause.pretty(cause), operation, status: 500 })

const notFound = () => json({ error: { message: "Not found", code: "not_found" } }, 404)

const listThreadsRequest = (url: URL): Remote.ListThreadsRequest => {
  const includeArchived = url.searchParams.get("include_archived")
  const workspaceId = url.searchParams.get("workspace_id")
  const userId = url.searchParams.get("user_id")
  const limit = intParam(url, "limit")
  return {
    ...(includeArchived === null ? {} : { include_archived: includeArchived === "true" }),
    ...(workspaceId === null ? {} : { workspace_id: Ids.WorkspaceId.make(workspaceId) }),
    ...(userId === null ? {} : { user_id: Ids.UserId.make(userId) }),
    ...(limit === undefined ? {} : { limit }),
  }
}

const openThreadRequest = (url: URL, encodedThreadId: string): Remote.OpenThreadRequest => {
  const userId = url.searchParams.get("user_id")
  return {
    thread_id: Ids.ThreadId.make(decodeURIComponent(encodedThreadId)),
    ...(userId === null ? {} : { user_id: Ids.UserId.make(userId) }),
  }
}

const previewThreadRequest = (url: URL, encodedThreadId: string): Remote.PreviewThreadRequest => {
  const userId = url.searchParams.get("user_id")
  const limit = intParam(url, "limit")
  return {
    thread_id: Ids.ThreadId.make(decodeURIComponent(encodedThreadId)),
    ...(userId === null ? {} : { user_id: Ids.UserId.make(userId) }),
    ...(limit === undefined ? {} : { limit }),
  }
}

const listArtifactsRequest = (
  url: URL,
): Effect.Effect<Remote.ListArtifactsRequest, RemoteControl.RemoteControlError> => {
  const threadId = url.searchParams.get("thread_id")
  if (threadId === null) {
    return Effect.fail(
      new RemoteControl.RemoteControlError({
        message: "thread_id query parameter is required",
        operation: "listArtifacts",
        status: 400,
      }),
    )
  }
  const kind = url.searchParams.get("kind")
  const userId = url.searchParams.get("user_id")
  const limit = intParam(url, "limit")
  return Effect.try({
    try: () => ({
      thread_id: Ids.ThreadId.make(threadId),
      ...(userId === null ? {} : { user_id: Ids.UserId.make(userId) }),
      ...(kind === null ? {} : { kind: Schema.decodeUnknownSync(Artifact.Kind)(kind) }),
      ...(limit === undefined ? {} : { limit }),
    }),
    catch: (cause) =>
      new RemoteControl.RemoteControlError({
        message: cause instanceof Error ? cause.message : String(cause),
        operation: "listArtifacts",
        status: 400,
      }),
  })
}

const getArtifactRequest = (url: URL, encodedArtifactId: string): Remote.GetArtifactRequest => {
  const userId = url.searchParams.get("user_id")
  return {
    artifact_id: Ids.ArtifactId.make(decodeURIComponent(encodedArtifactId)),
    ...(userId === null ? {} : { user_id: Ids.UserId.make(userId) }),
  }
}

const archiveThreadRequest = (url: URL, encodedThreadId: string): Remote.ArchiveThreadRequest => {
  const userId = url.searchParams.get("user_id")
  return {
    thread_id: Ids.ThreadId.make(decodeURIComponent(encodedThreadId)),
    ...(userId === null ? {} : { user_id: Ids.UserId.make(userId) }),
  }
}

const setThreadVisibilityRequest = (
  request: Request,
  url: URL,
  encodedThreadId: string,
): Effect.Effect<Remote.SetThreadVisibilityRequest, RemoteControl.RemoteControlError> =>
  decodeBody(request, Remote.SetThreadVisibilityBody).pipe(
    Effect.map((input) => {
      const userId = url.searchParams.get("user_id")
      return {
        thread_id: Ids.ThreadId.make(decodeURIComponent(encodedThreadId)),
        ...(userId === null ? {} : { user_id: Ids.UserId.make(userId) }),
        visibility: input.visibility,
      }
    }),
  )

const compactThreadRequest = (url: URL, encodedThreadId: string): Remote.CompactThreadRequest => {
  const userId = url.searchParams.get("user_id")
  return {
    thread_id: Ids.ThreadId.make(decodeURIComponent(encodedThreadId)),
    ...(userId === null ? {} : { user_id: Ids.UserId.make(userId) }),
  }
}

const forkThreadRequest = (
  request: Request,
  encodedThreadId: string,
): Effect.Effect<Remote.ForkThreadRequest, RemoteControl.RemoteControlError> =>
  Effect.gen(function* () {
    const input = yield* decodeBody(request, Remote.ForkThreadRequest)
    const pathThreadId = Ids.ThreadId.make(decodeURIComponent(encodedThreadId))
    if (input.thread_id === pathThreadId) return input
    return yield* new RemoteControl.RemoteControlError({
      message: `Fork request thread_id ${input.thread_id} does not match path thread ${pathThreadId}`,
      operation: "forkThread",
      status: 400,
    })
  })

const searchThreadsRequest = (url: URL): Remote.SearchThreadsRequest => {
  const queryValue = url.searchParams.get("query")
  const includeArchived = url.searchParams.get("include_archived")
  const workspaceId = url.searchParams.get("workspace_id")
  const userId = url.searchParams.get("user_id")
  const after = intParam(url, "after")
  const before = intParam(url, "before")
  const limit = intParam(url, "limit")
  return {
    ...(queryValue === null ? {} : { query: queryValue }),
    ...(includeArchived === null ? {} : { include_archived: includeArchived === "true" }),
    ...(workspaceId === null ? {} : { workspace_id: Ids.WorkspaceId.make(workspaceId) }),
    ...(userId === null ? {} : { user_id: Ids.UserId.make(userId) }),
    ...(after === undefined ? {} : { after }),
    ...(before === undefined ? {} : { before }),
    ...(limit === undefined ? {} : { limit }),
  }
}

const shareThreadRequest = (url: URL, encodedThreadId: string): Remote.ShareThreadRequest => {
  const userId = url.searchParams.get("user_id")
  return {
    thread_id: Ids.ThreadId.make(decodeURIComponent(encodedThreadId)),
    ...(userId === null ? {} : { user_id: Ids.UserId.make(userId) }),
  }
}

const referenceThreadRequest = (url: URL, encodedThreadId: string): Remote.ReferenceThreadRequest => {
  const userId = url.searchParams.get("user_id")
  const queryValue = url.searchParams.get("query")
  const maxChars = intParam(url, "max_chars")
  return {
    thread_id: Ids.ThreadId.make(decodeURIComponent(encodedThreadId)),
    ...(userId === null ? {} : { user_id: Ids.UserId.make(userId) }),
    ...(queryValue === null ? {} : { query: queryValue }),
    ...(maxChars === undefined ? {} : { max_chars: maxChars }),
  }
}

const subscribeThreadEventsRequest = (url: URL, encodedThreadId: string): Remote.SubscribeThreadEventsRequest => {
  const userId = url.searchParams.get("user_id")
  const afterSequence = intParam(url, "after_sequence")
  return {
    thread_id: Ids.ThreadId.make(decodeURIComponent(encodedThreadId)),
    ...(userId === null ? {} : { user_id: Ids.UserId.make(userId) }),
    ...(afterSequence === undefined ? {} : { after_sequence: afterSequence }),
  }
}

const setThreadPresenceRequest = (
  request: Request,
  encodedThreadId: string,
): Effect.Effect<Remote.SetThreadPresenceRequest, RemoteControl.RemoteControlError> =>
  decodeBody(request, Remote.PresenceRequest).pipe(
    Effect.map((input) => ({
      thread_id: Ids.ThreadId.make(decodeURIComponent(encodedThreadId)),
      ...input,
    })),
  )

const serverUrl = (url: URL) => `${url.protocol}//${url.host}`

const intParam = (url: URL, name: string) => {
  const value = url.searchParams.get(name)
  if (value === null) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}
