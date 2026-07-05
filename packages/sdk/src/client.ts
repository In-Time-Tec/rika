import { Artifact, Codec, Event, Ide, Ids, Remote } from "@rika/schema"
import { Duration, Effect, Schedule, Schema, Stream } from "effect"

export interface RequestInput {
  readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT"
  readonly path: string
  readonly body?: unknown
}

export interface Transport {
  readonly user_id?: Ids.UserId
  readonly requestJson: (input: RequestInput) => Effect.Effect<unknown, SdkError>
  readonly streamJson: (input: RequestInput) => Stream.Stream<unknown, SdkError>
}

export interface FetchTransportInput {
  readonly base_url: string
  readonly user_id?: Ids.UserId
  readonly token?: string
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}

export class SdkError extends Schema.TaggedErrorClass<SdkError>()("SdkError", {
  message: Schema.String,
  operation: Schema.String,
  status: Schema.optional(Schema.Int),
  active_user_id: Schema.optional(Ids.UserId),
}) {}

export interface SubscribeThreadEventsInput extends Remote.SubscribeThreadEventsRequest {
  readonly onPresence?: (presence: Remote.PresencePayload) => void
}

export interface Interface {
  readonly backendHealth: () => Effect.Effect<Remote.BackendHealth, SdkError>
  readonly createThread: (input?: Remote.CreateThreadRequest) => Effect.Effect<Remote.ThreadSummary, SdkError>
  readonly createOrbThread: (input: Remote.CreateOrbThreadRequest) => Effect.Effect<Remote.ThreadSummary, SdkError>
  readonly orbChanges: () => Effect.Effect<Remote.OrbChangesResponse, SdkError>
  readonly orbFiles: (path?: string) => Effect.Effect<Remote.OrbFilesResponse, SdkError>
  readonly orbFile: (path: string) => Effect.Effect<Remote.OrbFileResponse, SdkError>
  readonly listOrbs: () => Effect.Effect<ReadonlyArray<Remote.OrbSummary>, SdkError>
  readonly getOrbByThread: (threadId: Ids.ThreadId) => Effect.Effect<Remote.OrbSummary, SdkError>
  readonly pauseOrb: (orbId: Ids.OrbId) => Effect.Effect<Remote.OrbSummary, SdkError>
  readonly resumeOrb: (orbId: Ids.OrbId) => Effect.Effect<Remote.OrbSummary, SdkError>
  readonly killOrb: (orbId: Ids.OrbId) => Effect.Effect<Remote.OrbSummary, SdkError>
  readonly listProjects: () => Effect.Effect<ReadonlyArray<Remote.ProjectSummary>, SdkError>
  readonly createProject: (input: Remote.CreateProjectRequest) => Effect.Effect<Remote.ProjectDetail, SdkError>
  readonly getProject: (projectId: Ids.ProjectId) => Effect.Effect<Remote.ProjectDetail, SdkError>
  readonly updateProject: (
    projectId: Ids.ProjectId,
    input: Remote.UpdateProjectRequest,
  ) => Effect.Effect<Remote.ProjectDetail, SdkError>
  readonly setProjectSecret: (
    projectId: Ids.ProjectId,
    name: string,
    input: Remote.SetProjectSecretRequest,
  ) => Effect.Effect<Remote.ProjectDetail, SdkError>
  readonly deleteProjectSecret: (
    projectId: Ids.ProjectId,
    name: string,
  ) => Effect.Effect<Remote.ProjectDetail, SdkError>
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
  readonly setThreadVisibility: (
    threadId: Ids.ThreadId,
    visibility: Remote.ThreadVisibility,
    userId?: Ids.UserId,
  ) => Effect.Effect<Remote.ThreadSummary, SdkError>
  readonly compactThread: (
    threadId: Ids.ThreadId,
    userId?: Ids.UserId,
  ) => Effect.Effect<Event.ContextCompacted, SdkError>
  readonly forkThread: (
    threadId: Ids.ThreadId,
    input?: Omit<Remote.ForkThreadRequest, "thread_id">,
  ) => Effect.Effect<Remote.ThreadSummary, SdkError>
  readonly searchThreads: (
    input: Remote.SearchThreadsRequest,
  ) => Effect.Effect<ReadonlyArray<Remote.ThreadSearchResult>, SdkError>
  readonly shareThread: (threadId: Ids.ThreadId, userId?: Ids.UserId) => Effect.Effect<Remote.ThreadExport, SdkError>
  readonly referenceThread: (input: Remote.ReferenceThreadRequest) => Effect.Effect<Remote.ThreadReference, SdkError>
  readonly subscribeThreadEvents: (input: SubscribeThreadEventsInput) => Stream.Stream<Event.Event, SdkError>
  readonly setThreadPresence: (input: Remote.SetThreadPresenceRequest) => Effect.Effect<Remote.PresenceFrame, SdkError>
  readonly startTurn: (input: Remote.StartTurnRequest) => Effect.Effect<Remote.StartTurnResponse, SdkError>
  readonly interruptTurn: (input: Remote.InterruptTurnRequest) => Effect.Effect<Event.TurnTerminal, SdkError>
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

const ApiErrorDetails = Schema.Struct({
  status: Schema.optional(Schema.Int),
  active_user_id: Schema.optional(Ids.UserId),
})

const userIdFor = (transport: Transport, userId: Ids.UserId | undefined) => userId ?? transport.user_id

const userIdQuery = (transport: Transport, userId: Ids.UserId | undefined) => {
  const resolved = userIdFor(transport, userId)
  return resolved === undefined ? {} : { user_id: resolved }
}

const withUserId = <A extends { readonly user_id?: Ids.UserId | undefined }>(transport: Transport, input: A): A => {
  const userId = input.user_id ?? transport.user_id
  return userId === undefined ? input : ({ ...input, user_id: userId } as A)
}

const presenceHeartbeatRetrySchedule = Schedule.exponential("250 millis", 2).pipe(
  Schedule.both(Schedule.recurs(3)),
  Schedule.modifyDelay((_error, delay) => Effect.succeed(Duration.min(delay, Duration.seconds(5)))),
)

export const make = (transport: Transport): Interface => ({
  backendHealth: () =>
    transport
      .requestJson({ method: "GET", path: "/health" })
      .pipe(Effect.flatMap(decodeEffect(Remote.BackendHealth, "backendHealth"))),
  createThread: (input: Remote.CreateThreadRequest = {}) =>
    transport
      .requestJson({
        method: "POST",
        path: "/v1/threads",
        body: Codec.encode(Remote.CreateThreadRequest)(withUserId(transport, input)),
      })
      .pipe(Effect.flatMap(decodeEffect(Remote.ThreadSummary, "createThread"))),
  createOrbThread: (input: Remote.CreateOrbThreadRequest) =>
    transport
      .requestJson({ method: "POST", path: "/v1/orbs", body: Codec.encode(Remote.CreateOrbThreadRequest)(input) })
      .pipe(Effect.flatMap(decodeEffect(Remote.ThreadSummary, "createOrbThread"))),
  orbChanges: () =>
    transport
      .requestJson({ method: "GET", path: "/v1/orb/changes" })
      .pipe(Effect.flatMap(decodeEffect(Remote.OrbChangesResponse, "orbChanges"))),
  orbFiles: (path = "") =>
    transport
      .requestJson({ method: "GET", path: `/v1/orb/files${path.length === 0 ? "" : query({ path })}` })
      .pipe(Effect.flatMap(decodeEffect(Remote.OrbFilesResponse, "orbFiles"))),
  orbFile: (path: string) =>
    transport
      .requestJson({ method: "GET", path: `/v1/orb/file${query({ path })}` })
      .pipe(Effect.flatMap(decodeEffect(Remote.OrbFileResponse, "orbFile"))),
  listOrbs: () =>
    transport
      .requestJson({ method: "GET", path: "/v1/orbs" })
      .pipe(Effect.flatMap(decodeEffect(Schema.Array(Remote.OrbSummary), "listOrbs"))),
  getOrbByThread: (threadId: Ids.ThreadId) =>
    transport
      .requestJson({ method: "GET", path: `/v1/orbs/by-thread/${encodeURIComponent(threadId)}` })
      .pipe(Effect.flatMap(decodeEffect(Remote.OrbSummary, "getOrbByThread"))),
  pauseOrb: (orbId: Ids.OrbId) =>
    transport
      .requestJson({ method: "POST", path: `/v1/orbs/${encodeURIComponent(orbId)}/pause` })
      .pipe(Effect.flatMap(decodeEffect(Remote.OrbSummary, "pauseOrb"))),
  resumeOrb: (orbId: Ids.OrbId) =>
    transport
      .requestJson({ method: "POST", path: `/v1/orbs/${encodeURIComponent(orbId)}/resume` })
      .pipe(Effect.flatMap(decodeEffect(Remote.OrbSummary, "resumeOrb"))),
  killOrb: (orbId: Ids.OrbId) =>
    transport
      .requestJson({ method: "POST", path: `/v1/orbs/${encodeURIComponent(orbId)}/kill` })
      .pipe(Effect.flatMap(decodeEffect(Remote.OrbSummary, "killOrb"))),
  listProjects: () =>
    transport
      .requestJson({ method: "GET", path: "/v1/projects" })
      .pipe(Effect.flatMap(decodeEffect(Schema.Array(Remote.ProjectSummary), "listProjects"))),
  createProject: (input: Remote.CreateProjectRequest) =>
    transport
      .requestJson({ method: "POST", path: "/v1/projects", body: Codec.encode(Remote.CreateProjectRequest)(input) })
      .pipe(Effect.flatMap(decodeEffect(Remote.ProjectDetail, "createProject"))),
  getProject: (projectId: Ids.ProjectId) =>
    transport
      .requestJson({ method: "GET", path: `/v1/projects/${encodeURIComponent(projectId)}` })
      .pipe(Effect.flatMap(decodeEffect(Remote.ProjectDetail, "getProject"))),
  updateProject: (projectId: Ids.ProjectId, input: Remote.UpdateProjectRequest) =>
    transport
      .requestJson({
        method: "PATCH",
        path: `/v1/projects/${encodeURIComponent(projectId)}`,
        body: Codec.encode(Remote.UpdateProjectRequest)(input),
      })
      .pipe(Effect.flatMap(decodeEffect(Remote.ProjectDetail, "updateProject"))),
  setProjectSecret: (projectId: Ids.ProjectId, name: string, input: Remote.SetProjectSecretRequest) =>
    transport
      .requestJson({
        method: "PUT",
        path: `/v1/projects/${encodeURIComponent(projectId)}/secrets/${encodeURIComponent(name)}`,
        body: Codec.encode(Remote.SetProjectSecretRequest)(input),
      })
      .pipe(Effect.flatMap(decodeEffect(Remote.ProjectDetail, "setProjectSecret"))),
  deleteProjectSecret: (projectId: Ids.ProjectId, name: string) =>
    transport
      .requestJson({
        method: "DELETE",
        path: `/v1/projects/${encodeURIComponent(projectId)}/secrets/${encodeURIComponent(name)}`,
      })
      .pipe(Effect.flatMap(decodeEffect(Remote.ProjectDetail, "deleteProjectSecret"))),
  listThreads: (input: Remote.ListThreadsRequest = {}) =>
    transport
      .requestJson({ method: "GET", path: `/v1/threads${query(withUserId(transport, input))}` })
      .pipe(Effect.flatMap(decodeEffect(Schema.Array(Remote.ThreadSummary), "listThreads"))),
  openThread: (threadId: Ids.ThreadId, userId?: Ids.UserId) =>
    transport
      .requestJson({
        method: "GET",
        path: `/v1/threads/${encodeURIComponent(threadId)}${query(userIdQuery(transport, userId))}`,
      })
      .pipe(Effect.flatMap(decodeEffect(Remote.ThreadRecord, "openThread"))),
  previewThread: (threadId: Ids.ThreadId, input: Omit<Remote.PreviewThreadRequest, "thread_id"> = {}) =>
    transport
      .requestJson({
        method: "GET",
        path: `/v1/threads/${encodeURIComponent(threadId)}/preview${query(withUserId(transport, input))}`,
      })
      .pipe(Effect.flatMap(decodeEffect(Remote.ThreadRecord, "previewThread"))),
  archiveThread: (threadId: Ids.ThreadId, userId?: Ids.UserId) =>
    transport
      .requestJson({
        method: "POST",
        path: `/v1/threads/${encodeURIComponent(threadId)}/archive${query(userIdQuery(transport, userId))}`,
      })
      .pipe(Effect.flatMap(decodeEffect(Remote.ThreadSummary, "archiveThread"))),
  unarchiveThread: (threadId: Ids.ThreadId, userId?: Ids.UserId) =>
    transport
      .requestJson({
        method: "POST",
        path: `/v1/threads/${encodeURIComponent(threadId)}/unarchive${query(userIdQuery(transport, userId))}`,
      })
      .pipe(Effect.flatMap(decodeEffect(Remote.ThreadSummary, "unarchiveThread"))),
  setThreadVisibility: (threadId: Ids.ThreadId, visibility: Remote.ThreadVisibility, userId?: Ids.UserId) =>
    transport
      .requestJson({
        method: "POST",
        path: `/v1/threads/${encodeURIComponent(threadId)}/visibility${query(userIdQuery(transport, userId))}`,
        body: Codec.encode(Remote.SetThreadVisibilityBody)({ visibility }),
      })
      .pipe(Effect.flatMap(decodeEffect(Remote.ThreadSummary, "setThreadVisibility"))),
  compactThread: (threadId: Ids.ThreadId, userId?: Ids.UserId) =>
    transport
      .requestJson({
        method: "POST",
        path: `/v1/threads/${encodeURIComponent(threadId)}/compact${query(userIdQuery(transport, userId))}`,
      })
      .pipe(Effect.flatMap(decodeEffect(Event.ContextCompacted, "compactThread"))),
  forkThread: (threadId: Ids.ThreadId, input: Omit<Remote.ForkThreadRequest, "thread_id"> = {}) =>
    transport
      .requestJson({
        method: "POST",
        path: `/v1/threads/${encodeURIComponent(threadId)}/fork`,
        body: Codec.encode(Remote.ForkThreadRequest)(withUserId(transport, { thread_id: threadId, ...input })),
      })
      .pipe(Effect.flatMap(decodeEffect(Remote.ThreadSummary, "forkThread"))),
  searchThreads: (input: Remote.SearchThreadsRequest) =>
    transport
      .requestJson({ method: "GET", path: `/v1/threads/search${query(withUserId(transport, input))}` })
      .pipe(Effect.flatMap(decodeEffect(Schema.Array(Remote.ThreadSearchResult), "searchThreads"))),
  shareThread: (threadId: Ids.ThreadId, userId?: Ids.UserId) =>
    transport
      .requestJson({
        method: "GET",
        path: `/v1/threads/${encodeURIComponent(threadId)}/share${query(userIdQuery(transport, userId))}`,
      })
      .pipe(Effect.flatMap(decodeEffect(Remote.ThreadExport, "shareThread"))),
  referenceThread: (input: Remote.ReferenceThreadRequest) => {
    const request = withUserId(transport, input)
    return transport
      .requestJson({
        method: "GET",
        path: `/v1/threads/${encodeURIComponent(input.thread_id)}/reference${query({
          ...(request.user_id === undefined ? {} : { user_id: request.user_id }),
          ...(input.query === undefined ? {} : { query: input.query }),
          ...(input.max_chars === undefined ? {} : { max_chars: input.max_chars }),
        })}`,
      })
      .pipe(Effect.flatMap(decodeEffect(Remote.ThreadReference, "referenceThread")))
  },
  subscribeThreadEvents: (input: SubscribeThreadEventsInput) => {
    const request = withUserId(transport, input)
    const events = transport
      .streamJson({
        method: "GET",
        path: `/v1/threads/${encodeURIComponent(request.thread_id)}/events${query({
          ...(request.user_id === undefined ? {} : { user_id: request.user_id }),
          ...(request.after_sequence === undefined ? {} : { after_sequence: request.after_sequence }),
        })}`,
      })
      .pipe(
        Stream.mapEffect((value) => decodeStreamFrame(value, input.onPresence)),
        Stream.flatMap((event) => (event === undefined ? Stream.empty : Stream.make(event))),
      )
    return request.user_id === undefined
      ? events
      : events.pipe(
          Stream.mergeEffect(
            setThreadPresenceRequest(transport, {
              thread_id: request.thread_id,
              user_id: request.user_id,
              state: "active",
            }).pipe(
              Effect.retry(presenceHeartbeatRetrySchedule),
              Effect.ignore,
              Effect.repeat(Schedule.spaced("15 seconds")),
              Effect.asVoid,
            ),
          ),
        )
  },
  setThreadPresence: (input: Remote.SetThreadPresenceRequest) => setThreadPresenceRequest(transport, input),
  startTurn: (input: Remote.StartTurnRequest) =>
    transport
      .requestJson({
        method: "POST",
        path: "/v1/turns",
        body: Codec.encode(Remote.StartTurnRequest)(withUserId(transport, input)),
      })
      .pipe(Effect.flatMap(decodeEffect(Remote.StartTurnResponse, "startTurn"))),
  interruptTurn: (input: Remote.InterruptTurnRequest) =>
    transport
      .requestJson({
        method: "POST",
        path: "/v1/turns/interrupt",
        body: Codec.encode(Remote.InterruptTurnRequest)(withUserId(transport, input)),
      })
      .pipe(Effect.flatMap(decodeEffect(Event.TurnTerminal, "interruptTurn"))),
  listArtifacts: (input: Remote.ListArtifactsRequest) =>
    transport
      .requestJson({ method: "GET", path: `/v1/artifacts${query(withUserId(transport, input))}` })
      .pipe(Effect.flatMap(decodeEffect(Schema.Array(Artifact.Artifact), "listArtifacts"))),
  getArtifact: (artifactId: Ids.ArtifactId, userId?: Ids.UserId) =>
    transport
      .requestJson({
        method: "GET",
        path: `/v1/artifacts/${encodeURIComponent(artifactId)}${query(userIdQuery(transport, userId))}`,
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
    ...(input.user_id === undefined ? {} : { user_id: input.user_id }),
    requestJson: (request) =>
      Effect.tryPromise({
        try: async (signal) => {
          const response = await fetchImpl(`${baseUrl}${request.path}`, fetchInit(request, input.token, signal))
          const status = response.status
          const body = await readResponseJson(response, "requestJson", status)
          if (!response.ok) throw apiError(body, "requestJson", status)
          return body
        },
        catch: (cause) => toSdkError(cause, "requestJson"),
      }),
    streamJson: (request) =>
      Stream.unwrap(
        Effect.tryPromise({
          try: async (signal) => {
            const response = await fetchImpl(`${baseUrl}${request.path}`, fetchInit(request, input.token, signal))
            const status = response.status
            if (!response.ok)
              throw apiError(await readResponseJson(response, "streamJson", status), "streamJson", status)
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

const setThreadPresenceRequest = (transport: Transport, input: Remote.SetThreadPresenceRequest) =>
  transport
    .requestJson({
      method: "POST",
      path: `/v1/threads/${encodeURIComponent(input.thread_id)}/presence`,
      body: Codec.encode(Remote.PresenceRequest)({ user_id: input.user_id, state: input.state }),
    })
    .pipe(Effect.flatMap(decodeEffect(Remote.PresenceFrame, "setThreadPresence")))

const decodeStreamFrame = (
  value: unknown,
  onPresence: ((presence: Remote.PresencePayload) => void) | undefined,
): Effect.Effect<Event.Event | undefined, SdkError> =>
  decodeEffect(
    Remote.StreamFrame,
    "subscribeThreadEvents",
  )(value).pipe(
    Effect.flatMap((frame) => {
      if (isApiErrorFrame(frame)) return Effect.fail(apiError(frame, "subscribeThreadEvents"))
      if (isPresenceFrame(frame)) {
        return Effect.try({
          try: () => onPresence?.(frame.presence),
          catch: (cause) => toSdkError(cause, "subscribeThreadEvents"),
        }).pipe(Effect.as(undefined))
      }
      return Effect.succeed(frame)
    }),
  )

const isApiErrorFrame = (frame: Remote.StreamFrame): frame is Remote.ApiError => "error" in frame

const isPresenceFrame = (frame: Remote.StreamFrame): frame is Remote.PresenceFrame => "presence" in frame

const isApiErrorBody = (value: unknown): value is Remote.ApiError =>
  Schema.decodeUnknownOption(Remote.ApiError)(value)._tag === "Some"

const fetchInit = (request: RequestInput, token: string | undefined, signal: AbortSignal): RequestInit => ({
  method: request.method,
  headers: {
    ...(request.body === undefined ? {} : { "content-type": "application/json" }),
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  },
  signal,
  ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
})

const readJson = async (response: Response) => parseJson(await response.text())

const readResponseJson = async (response: Response, operation: string, status: number) => {
  try {
    return await readJson(response)
  } catch (cause) {
    if (!response.ok) throw apiError(null, operation, status)
    throw cause
  }
}

const parseJson = (text: string) => {
  if (text.trim().length === 0) return null
  return JSON.parse(text) as unknown
}

const apiError = (body: unknown, operation: string, status?: number) => {
  const decoded = Schema.decodeUnknownOption(Remote.ApiError)(body)
  if (decoded._tag === "Some") {
    const details = apiErrorDetails(decoded.value)
    const decodedStatus = status ?? details.status
    return new SdkError({
      message: decoded.value.error.message,
      operation,
      ...(decodedStatus === undefined ? {} : { status: decodedStatus }),
      ...(details.active_user_id === undefined ? {} : { active_user_id: details.active_user_id }),
    })
  }
  return new SdkError({
    message: status === undefined ? "Rika API request failed" : `Rika API request failed with status ${status}`,
    operation,
    ...(status === undefined ? {} : { status }),
  })
}

const apiErrorDetails = (
  error: Remote.ApiError,
): { readonly status?: number; readonly active_user_id?: Ids.UserId } => {
  const decoded = Schema.decodeUnknownOption(ApiErrorDetails)(error.error.details)
  if (decoded._tag === "None") return {}
  return {
    ...(decoded.value.status === undefined ? {} : { status: decoded.value.status }),
    ...(decoded.value.active_user_id === undefined ? {} : { active_user_id: decoded.value.active_user_id }),
  }
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
