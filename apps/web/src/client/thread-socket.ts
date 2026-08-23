import { Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"

export const frameEventName = "rika:thread-frame"

export class ThreadConnectionFailed extends Schema.TaggedError<ThreadConnectionFailed>()("ThreadConnectionFailed", {
  message: Schema.String,
}) {}

const Ticket = Schema.Struct({
  ticket: Schema.String,
  websocketUrl: Schema.String,
  protocol: Schema.String,
})
type Ticket = typeof Ticket.Type

const Json = Schema.fromJsonString(Schema.Unknown)
const encodeJson = Schema.encodeSync(Json)
const decodeJson = Schema.decodeUnknownSync(Json)

let socket: WebSocket | undefined
let sequence = 0

const failed = (message: string) => ThreadConnectionFailed.make({ message })
const requestId = (kind: string) => `${kind}:${(sequence += 1)}`
const emit = (detail: unknown) => window.dispatchEvent(new CustomEvent(frameEventName, { detail }))

const open = (ticket: Ticket) =>
  Effect.callback<WebSocket, ThreadConnectionFailed>((resume) => {
    const current = new WebSocket(ticket.websocketUrl, [ticket.protocol, `rika.ticket.${ticket.ticket}`])
    const opened = () => resume(Effect.succeed(current))
    const rejected = () => resume(Effect.fail(failed("The Thread connection could not be opened")))
    current.addEventListener("open", opened, { once: true })
    current.addEventListener("error", rejected, { once: true })
    return Effect.sync(() => {
      current.removeEventListener("open", opened)
      current.removeEventListener("error", rejected)
      if (current.readyState === WebSocket.CONNECTING) current.close()
    })
  })

export const connectThread = Effect.fn("ThreadSocket.connect")(function* (threadId: string) {
  const httpClient = yield* Effect.scoped(Layer.build(FetchHttpClient.layer))
  const response = yield* HttpClient.post("/api/v1/thread-sessions").pipe(
    Effect.provideContext(httpClient),
    Effect.mapError(() => failed("A Thread ticket could not be requested")),
  )
  if (response.status < 200 || response.status >= 300)
    return yield* failed(`Thread ticket request failed with HTTP ${response.status}`)
  const ticket = yield* response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Ticket)),
    Effect.mapError(() => failed("The Thread ticket response was invalid")),
  )
  socket?.close(1000, "replaced")
  const current = yield* open(ticket)
  socket = current
  current.addEventListener("message", (event) => {
    try {
      emit(decodeJson(String(event.data)))
    } catch {
      emit({ protocolVersion: 1, payload: { _tag: "ClientDecodeFailed", message: "Server frame was invalid" } })
    }
  })
  current.addEventListener("close", () => emit({ protocolVersion: 1, payload: { _tag: "ClientDisconnected" } }))
  current.send(
    encodeJson({
      protocolVersion: 1,
      requestId: requestId("attach"),
      command: { _tag: "AttachThread", threadId, afterCursor: "0" },
    }),
  )
  return threadId
})

export const sendPrompt = Effect.fn("ThreadSocket.sendPrompt")(function* (input: {
  readonly threadId: string
  readonly threadVersion: string
  readonly text: string
}) {
  const current = socket
  if (current === undefined || current.readyState !== WebSocket.OPEN)
    return yield* failed("Connect to the Thread before sending a prompt")
  const id = requestId("prompt")
  yield* Effect.try({
    try: () =>
      current.send(
        encodeJson({
          protocolVersion: 1,
          requestId: `${id}:request`,
          command: {
            _tag: "SubmitPrompt",
            commandId: id,
            idempotencyKey: id,
            expectedThreadVersion: input.threadVersion,
            text: input.text,
          },
        }),
      ),
    catch: () => failed("The prompt could not be sent"),
  })
})

export const openPortal = Effect.fn("ThreadSocket.openPortal")(function* (port: number) {
  const current = socket
  if (current === undefined || current.readyState !== WebSocket.OPEN)
    return yield* failed("Connect to the Thread before opening a portal")
  yield* Effect.try({
    try: () =>
      current.send(
        encodeJson({
          protocolVersion: 1,
          requestId: requestId("portal"),
          command: { _tag: "OpenPortal", port },
        }),
      ),
    catch: () => failed("The portal request could not be sent"),
  })
})
