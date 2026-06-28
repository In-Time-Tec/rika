import { Artifact, Codec, Event, Ide, Ids, Remote } from "@rika/schema"
import { Context, Effect, Fiber, Layer, Schema, Stream } from "effect"
import * as RemoteControl from "./remote-control"

const defaultHost = "127.0.0.1"
const defaultPort = 4587

export interface ServeInput extends Schema.Schema.Type<typeof ServeInput> {}
export const ServeInput = Schema.Struct({
  host: Schema.optional(Schema.String),
  port: Schema.optional(Schema.Int),
  token: Schema.optional(Schema.String),
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

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const remote = yield* RemoteControl.Service
    return makeService(remote)
  }),
)

export const handle = Effect.fn("HttpServer.handle.call")(function* (request: Request) {
  const service = yield* Service
  return yield* service.handle(request)
})

export const serve = Effect.fn("HttpServer.serve.call")(function* (input: ServeInput = {}) {
  const service = yield* Service
  return yield* service.serve(input)
})

const makeService = (remote: RemoteControl.Interface): Interface => {
  const handleRequest = (request: Request) => route(remote, request)
  return Service.of({
    handle: handleRequest,
    serve: Effect.fn("HttpServer.serve")(function* (input: ServeInput = {}) {
      const host = input.host ?? defaultHost
      const port = input.port ?? defaultPort
      const server = yield* Effect.try({
        try: () =>
          Bun.serve({
            hostname: host,
            port,
            fetch: (request) => Effect.runPromise(handleRequest(withLocalAuth(request, input.token))),
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

const route = (remote: RemoteControl.Interface, request: Request): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const url = new URL(request.url)
    const unauthorized = unauthorizedResponse(request)
    if (unauthorized !== undefined) return unauthorized
    if (url.pathname === "/health") return json({ ok: true })

    const segments = url.pathname.split("/").filter(Boolean)
    if (segments[0] !== "v1") return notFound()

    if (request.method === "GET" && segments[1] === "threads" && segments.length === 2) {
      const input = listThreadsRequest(url)
      return yield* remote.listThreads(input).pipe(jsonEffect(Schema.Array(Remote.ThreadSummary)))
    }

    if (request.method === "POST" && segments[1] === "threads" && segments.length === 2) {
      const input = yield* decodeBody(request, Remote.CreateThreadRequest)
      return yield* remote.createThread(input).pipe(jsonEffect(Remote.ThreadSummary))
    }

    if (request.method === "GET" && segments[1] === "threads" && segments[2] !== undefined && segments.length === 3) {
      return yield* remote
        .openThread(Ids.ThreadId.make(decodeURIComponent(segments[2])))
        .pipe(jsonEffect(Remote.ThreadRecord))
    }

    if (request.method === "POST" && segments[1] === "turns" && segments.length === 2) {
      const input = yield* decodeBody(request, Remote.StartTurnRequest)
      return ndjson(remote.startTurn(input))
    }

    if (request.method === "POST" && segments[1] === "turns" && segments[2] === "interrupt" && segments.length === 3) {
      const input = yield* decodeBody(request, Remote.InterruptTurnRequest)
      return yield* remote.interruptTurn(input).pipe(jsonEffect(Event.TurnFailed))
    }

    if (request.method === "GET" && segments[1] === "artifacts" && segments.length === 2) {
      const input = yield* listArtifactsRequest(url)
      return yield* remote.listArtifacts(input).pipe(jsonEffect(Schema.Array(Artifact.Artifact)))
    }

    if (request.method === "GET" && segments[1] === "artifacts" && segments[2] !== undefined && segments.length === 3) {
      const input = { artifact_id: Ids.ArtifactId.make(decodeURIComponent(segments[2])) }
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
  }).pipe(Effect.catch((error) => Effect.succeed(errorResponse(error))))

const withLocalAuth = (request: Request, token: string | undefined) => {
  if (token === undefined || token.length === 0) return request
  const headers = new Headers(request.headers)
  headers.set("x-rika-required-token", token)
  return new Request(request, { headers })
}

const unauthorizedResponse = (request: Request) => {
  const token = request.headers.get("x-rika-required-token")
  if (token === null) return undefined
  if (request.headers.get("authorization") === `Bearer ${token}`) return undefined
  return json({ error: { message: "Unauthorized", code: "unauthorized" } }, 401)
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

const ndjson = (events: Stream.Stream<Event.Event, RemoteControl.RunError>) => {
  const encoder = new TextEncoder()
  let closed = false
  let fiber: Fiber.Fiber<void> | undefined
  const writeFrame = (controller: ReadableStreamDefaultController<Uint8Array>, frame: Remote.StreamFrame) => {
    if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(Codec.encode(Remote.StreamFrame)(frame))}\n`))
  }
  const close = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (closed) return
    closed = true
    controller.close()
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const pump = events.pipe(
        Stream.runForEach((event) => Effect.sync(() => writeFrame(controller, event))),
        Effect.catch((error) => Effect.sync(() => writeFrame(controller, RemoteControl.errorToApi(error)))),
        Effect.ensuring(Effect.sync(() => close(controller))),
      )
      fiber = Effect.runFork(pump)
    },
    cancel() {
      closed = true
      if (fiber !== undefined) {
        return Effect.runPromise(Fiber.interrupt(fiber)).then(
          () => undefined,
          () => undefined,
        )
      }
      return undefined
    },
  })
  return new Response(body, { headers: { "content-type": "application/x-ndjson" } })
}

const errorResponse = (error: RemoteControl.RunError) =>
  json(RemoteControl.errorToApi(error), RemoteControl.statusFromError(error))

const notFound = () => json({ error: { message: "Not found", code: "not_found" } }, 404)

const listThreadsRequest = (url: URL): Remote.ListThreadsRequest => {
  const includeArchived = url.searchParams.get("include_archived")
  const limit = intParam(url, "limit")
  return {
    ...(includeArchived === null ? {} : { include_archived: includeArchived === "true" }),
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
  const limit = intParam(url, "limit")
  return Effect.try({
    try: () => ({
      thread_id: Ids.ThreadId.make(threadId),
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

const intParam = (url: URL, name: string) => {
  const value = url.searchParams.get(name)
  if (value === null) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}
