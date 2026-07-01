import { Artifact, Codec, Event, Ide, Ids, Remote } from "@rika/schema"
import { Effect, Schema, Stream } from "effect"

export interface RequestInput {
  readonly method: "GET" | "POST"
  readonly path: string
  readonly body?: unknown
}

export interface Transport {
  readonly requestJson: (input: RequestInput) => Effect.Effect<unknown, SdkError>
  readonly streamJson: (input: RequestInput) => Stream.Stream<unknown, SdkError>
}

export interface FetchTransportInput {
  readonly base_url: string
  readonly token?: string
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}

export class SdkError extends Schema.TaggedErrorClass<SdkError>()("SdkError", {
  message: Schema.String,
  operation: Schema.String,
  status: Schema.optional(Schema.Int),
}) {}

export interface Interface {
  readonly backendHealth: () => Effect.Effect<Remote.BackendHealth, SdkError>
  readonly createThread: (input?: Remote.CreateThreadRequest) => Effect.Effect<Remote.ThreadSummary, SdkError>
  readonly listThreads: (
    input?: Remote.ListThreadsRequest,
  ) => Effect.Effect<ReadonlyArray<Remote.ThreadSummary>, SdkError>
  readonly openThread: (threadId: Ids.ThreadId, userId?: Ids.UserId) => Effect.Effect<Remote.ThreadRecord, SdkError>
  readonly previewThread: (
    threadId: Ids.ThreadId,
    input?: Omit<Remote.PreviewThreadRequest, "thread_id">,
  ) => Effect.Effect<Remote.ThreadRecord, SdkError>
  readonly archiveThread: (threadId: Ids.ThreadId, userId?: Ids.UserId) => Effect.Effect<Remote.ThreadSummary, SdkError>
  readonly unarchiveThread: (
    threadId: Ids.ThreadId,
    userId?: Ids.UserId,
  ) => Effect.Effect<Remote.ThreadSummary, SdkError>
  readonly searchThreads: (
    input: Remote.SearchThreadsRequest,
  ) => Effect.Effect<ReadonlyArray<Remote.ThreadSearchResult>, SdkError>
  readonly shareThread: (threadId: Ids.ThreadId, userId?: Ids.UserId) => Effect.Effect<Remote.ThreadExport, SdkError>
  readonly referenceThread: (input: Remote.ReferenceThreadRequest) => Effect.Effect<Remote.ThreadReference, SdkError>
  readonly subscribeThreadEvents: (input: Remote.SubscribeThreadEventsRequest) => Stream.Stream<Event.Event, SdkError>
  readonly startTurn: (input: Remote.StartTurnRequest) => Effect.Effect<Remote.StartTurnResponse, SdkError>
  readonly interruptTurn: (input: Remote.InterruptTurnRequest) => Effect.Effect<Event.TurnFailed, SdkError>
  readonly listArtifacts: (
    input: Remote.ListArtifactsRequest,
  ) => Effect.Effect<ReadonlyArray<Artifact.Artifact>, SdkError>
  readonly getArtifact: (artifactId: Ids.ArtifactId, userId?: Ids.UserId) => Effect.Effect<Artifact.Artifact, SdkError>
  readonly connectIde: (input: Ide.ConnectRequest) => Effect.Effect<Ide.ConnectResponse, SdkError>
  readonly disconnectIde: (input: Ide.DisconnectRequest) => Effect.Effect<Ide.Status, SdkError>
  readonly updateIdeContext: (input: Ide.UpdateContextRequest) => Effect.Effect<Ide.Status, SdkError>
  readonly ideStatus: () => Effect.Effect<Ide.Status, SdkError>
  readonly openIdeFile: (input: Ide.OpenFileRequest) => Effect.Effect<Ide.OpenFileResult, SdkError>
  readonly ideNavigationRequests: () => Effect.Effect<ReadonlyArray<Ide.OpenFileRequest>, SdkError>
}

const ApiErrorDetails = Schema.Struct({ status: Schema.Int })

export const make = (transport: Transport): Interface => ({
  backendHealth: () =>
    transport
      .requestJson({ method: "GET", path: "/health" })
      .pipe(Effect.flatMap(decodeEffect(Remote.BackendHealth, "backendHealth"))),
  createThread: (input: Remote.CreateThreadRequest = {}) =>
    transport
      .requestJson({ method: "POST", path: "/v1/threads", body: Codec.encode(Remote.CreateThreadRequest)(input) })
      .pipe(Effect.flatMap(decodeEffect(Remote.ThreadSummary, "createThread"))),
  listThreads: (input: Remote.ListThreadsRequest = {}) =>
    transport
      .requestJson({ method: "GET", path: `/v1/threads${query(input)}` })
      .pipe(Effect.flatMap(decodeEffect(Schema.Array(Remote.ThreadSummary), "listThreads"))),
  openThread: (threadId: Ids.ThreadId, userId?: Ids.UserId) =>
    transport
      .requestJson({
        method: "GET",
        path: `/v1/threads/${encodeURIComponent(threadId)}${query(userId === undefined ? {} : { user_id: userId })}`,
      })
      .pipe(Effect.flatMap(decodeEffect(Remote.ThreadRecord, "openThread"))),
  previewThread: (threadId: Ids.ThreadId, input: Omit<Remote.PreviewThreadRequest, "thread_id"> = {}) =>
    transport
      .requestJson({
        method: "GET",
        path: `/v1/threads/${encodeURIComponent(threadId)}/preview${query(input)}`,
      })
      .pipe(Effect.flatMap(decodeEffect(Remote.ThreadRecord, "previewThread"))),
  archiveThread: (threadId: Ids.ThreadId, userId?: Ids.UserId) =>
    transport
      .requestJson({
        method: "POST",
        path: `/v1/threads/${encodeURIComponent(threadId)}/archive${query(userId === undefined ? {} : { user_id: userId })}`,
      })
      .pipe(Effect.flatMap(decodeEffect(Remote.ThreadSummary, "archiveThread"))),
  unarchiveThread: (threadId: Ids.ThreadId, userId?: Ids.UserId) =>
    transport
      .requestJson({
        method: "POST",
        path: `/v1/threads/${encodeURIComponent(threadId)}/unarchive${query(userId === undefined ? {} : { user_id: userId })}`,
      })
      .pipe(Effect.flatMap(decodeEffect(Remote.ThreadSummary, "unarchiveThread"))),
  searchThreads: (input: Remote.SearchThreadsRequest) =>
    transport
      .requestJson({ method: "GET", path: `/v1/threads/search${query(input)}` })
      .pipe(Effect.flatMap(decodeEffect(Schema.Array(Remote.ThreadSearchResult), "searchThreads"))),
  shareThread: (threadId: Ids.ThreadId, userId?: Ids.UserId) =>
    transport
      .requestJson({
        method: "GET",
        path: `/v1/threads/${encodeURIComponent(threadId)}/share${query(userId === undefined ? {} : { user_id: userId })}`,
      })
      .pipe(Effect.flatMap(decodeEffect(Remote.ThreadExport, "shareThread"))),
  referenceThread: (input: Remote.ReferenceThreadRequest) =>
    transport
      .requestJson({
        method: "GET",
        path: `/v1/threads/${encodeURIComponent(input.thread_id)}/reference${query({
          ...(input.user_id === undefined ? {} : { user_id: input.user_id }),
          ...(input.query === undefined ? {} : { query: input.query }),
          ...(input.max_chars === undefined ? {} : { max_chars: input.max_chars }),
        })}`,
      })
      .pipe(Effect.flatMap(decodeEffect(Remote.ThreadReference, "referenceThread"))),
  subscribeThreadEvents: (input: Remote.SubscribeThreadEventsRequest) =>
    transport
      .streamJson({
        method: "GET",
        path: `/v1/threads/${encodeURIComponent(input.thread_id)}/events${query({
          ...(input.user_id === undefined ? {} : { user_id: input.user_id }),
          ...(input.after_sequence === undefined ? {} : { after_sequence: input.after_sequence }),
        })}`,
      })
      .pipe(Stream.mapEffect(decodeStreamFrame)),
  startTurn: (input: Remote.StartTurnRequest) =>
    transport
      .requestJson({ method: "POST", path: "/v1/turns", body: Codec.encode(Remote.StartTurnRequest)(input) })
      .pipe(Effect.flatMap(decodeEffect(Remote.StartTurnResponse, "startTurn"))),
  interruptTurn: (input: Remote.InterruptTurnRequest) =>
    transport
      .requestJson({
        method: "POST",
        path: "/v1/turns/interrupt",
        body: Codec.encode(Remote.InterruptTurnRequest)(input),
      })
      .pipe(Effect.flatMap(decodeEffect(Event.TurnFailed, "interruptTurn"))),
  listArtifacts: (input: Remote.ListArtifactsRequest) =>
    transport
      .requestJson({ method: "GET", path: `/v1/artifacts${query(input)}` })
      .pipe(Effect.flatMap(decodeEffect(Schema.Array(Artifact.Artifact), "listArtifacts"))),
  getArtifact: (artifactId: Ids.ArtifactId, userId?: Ids.UserId) =>
    transport
      .requestJson({
        method: "GET",
        path: `/v1/artifacts/${encodeURIComponent(artifactId)}${query(userId === undefined ? {} : { user_id: userId })}`,
      })
      .pipe(Effect.flatMap(decodeEffect(Artifact.Artifact, "getArtifact"))),
  connectIde: (input: Ide.ConnectRequest) =>
    transport
      .requestJson({ method: "POST", path: "/v1/ide/connect", body: Codec.encode(Ide.ConnectRequest)(input) })
      .pipe(Effect.flatMap(decodeEffect(Ide.ConnectResponse, "connectIde"))),
  disconnectIde: (input: Ide.DisconnectRequest) =>
    transport
      .requestJson({ method: "POST", path: "/v1/ide/disconnect", body: Codec.encode(Ide.DisconnectRequest)(input) })
      .pipe(Effect.flatMap(decodeEffect(Ide.Status, "disconnectIde"))),
  updateIdeContext: (input: Ide.UpdateContextRequest) =>
    transport
      .requestJson({ method: "POST", path: "/v1/ide/context", body: Codec.encode(Ide.UpdateContextRequest)(input) })
      .pipe(Effect.flatMap(decodeEffect(Ide.Status, "updateIdeContext"))),
  ideStatus: () =>
    transport
      .requestJson({ method: "GET", path: "/v1/ide/status" })
      .pipe(Effect.flatMap(decodeEffect(Ide.Status, "ideStatus"))),
  openIdeFile: (input: Ide.OpenFileRequest) =>
    transport
      .requestJson({ method: "POST", path: "/v1/ide/open-file", body: Codec.encode(Ide.OpenFileRequest)(input) })
      .pipe(Effect.flatMap(decodeEffect(Ide.OpenFileResult, "openIdeFile"))),
  ideNavigationRequests: () =>
    transport
      .requestJson({ method: "GET", path: "/v1/ide/navigation-requests" })
      .pipe(Effect.flatMap(decodeEffect(Schema.Array(Ide.OpenFileRequest), "ideNavigationRequests"))),
})

export const fetchTransport = (input: FetchTransportInput): Transport => {
  const fetchImpl = input.fetch ?? fetch
  const baseUrl = input.base_url.replace(/\/$/, "")
  return {
    requestJson: (request) =>
      Effect.tryPromise({
        try: async () => {
          const response = await fetchImpl(`${baseUrl}${request.path}`, fetchInit(request, input.token))
          const body = await readJson(response)
          if (!response.ok) throw apiError(body, "requestJson", response.status)
          return body
        },
        catch: (cause) => toSdkError(cause, "requestJson"),
      }),
    streamJson: (request) =>
      Stream.unwrap(
        Effect.tryPromise({
          try: async () => {
            const response = await fetchImpl(`${baseUrl}${request.path}`, fetchInit(request, input.token))
            if (!response.ok) throw apiError(await readJson(response), "streamJson", response.status)
            if (response.body === null) {
              throw new SdkError({
                message: "Rika API stream response did not include a body",
                operation: "streamJson",
              })
            }
            return response.body
          },
          catch: (cause) => toSdkError(cause, "streamJson"),
        }).pipe(Effect.map(decodeNdjsonStream)),
      ),
  }
}

const decodeNdjsonStream = (body: ReadableStream<Uint8Array>) =>
  Stream.fromReadableStream({
    evaluate: () => body,
    onError: (cause) => toSdkError(cause, "streamJson"),
  }).pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.filter((line) => line.trim().length > 0),
    Stream.mapEffect((line) =>
      Effect.try({
        try: () => JSON.parse(line) as unknown,
        catch: (cause) => toSdkError(cause, "streamJson"),
      }),
    ),
  )

const decodeEffect =
  <const S extends Schema.ConstraintDecoder<unknown>>(schema: S, operation: string) =>
  (value: unknown): Effect.Effect<S["Type"], SdkError> =>
    isApiErrorBody(value)
      ? Effect.fail(apiError(value, operation))
      : Effect.try({
          try: () => Schema.decodeUnknownSync(schema)(value),
          catch: (cause) => toSdkError(cause, operation),
        })

const decodeStreamFrame = (value: unknown): Effect.Effect<Event.Event, SdkError> =>
  decodeEffect(
    Remote.StreamFrame,
    "subscribeThreadEvents",
  )(value).pipe(
    Effect.flatMap((frame) =>
      isApiErrorFrame(frame) ? Effect.fail(apiError(frame, "subscribeThreadEvents")) : Effect.succeed(frame),
    ),
  )

const isApiErrorFrame = (frame: Remote.StreamFrame): frame is Remote.ApiError => "error" in frame

const isApiErrorBody = (value: unknown): value is Remote.ApiError =>
  Schema.decodeUnknownOption(Remote.ApiError)(value)._tag === "Some"

const fetchInit = (request: RequestInput, token: string | undefined): RequestInit => ({
  method: request.method,
  headers: {
    ...(request.body === undefined ? {} : { "content-type": "application/json" }),
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  },
  ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
})

const readJson = async (response: Response) => parseJson(await response.text())

const parseJson = (text: string) => {
  if (text.trim().length === 0) return null
  return JSON.parse(text) as unknown
}

const apiError = (body: unknown, operation: string, status?: number) => {
  const decoded = Schema.decodeUnknownOption(Remote.ApiError)(body)
  if (decoded._tag === "Some") {
    const decodedStatus = status ?? apiErrorStatus(decoded.value)
    return new SdkError({
      message: decoded.value.error.message,
      operation,
      ...(decodedStatus === undefined ? {} : { status: decodedStatus }),
    })
  }
  return new SdkError({
    message: status === undefined ? "Rika API request failed" : `Rika API request failed with status ${status}`,
    operation,
    ...(status === undefined ? {} : { status }),
  })
}

const apiErrorStatus = (error: Remote.ApiError) => {
  const decoded = Schema.decodeUnknownOption(ApiErrorDetails)(error.error.details)
  return decoded._tag === "Some" ? decoded.value.status : undefined
}

const toSdkError = (cause: unknown, operation: string) => {
  if (cause instanceof SdkError) return cause
  return new SdkError({ message: cause instanceof Error ? cause.message : String(cause), operation })
}

const query = (input: Record<string, unknown>) => {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(input)) {
    const encoded = queryValue(value)
    if (encoded !== undefined) params.set(key, encoded)
  }
  const text = params.toString()
  return text.length === 0 ? "" : `?${text}`
}

const queryValue = (value: unknown) => {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return undefined
}
