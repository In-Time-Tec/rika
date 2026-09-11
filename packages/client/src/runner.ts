import { WorkspaceBinding, workspaceExecutorWebSocketProtocol } from "@rika/execution"
import { CheckoutFingerprint, RemoteThreadCreationPreference, RunnerProfile } from "@rika/product/runner-registration"
import { Effect, Schema } from "effect"
import { ProductClientError, type ProductRequestHeaders, type ProductTransport } from "./product"

const ThreadId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const BoundedId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const maximumBindingBytes = 16_384

const protocol = (message: string, status?: number) => {
  if (status === undefined) return ProductClientError.make({ kind: "protocol", message })
  return ProductClientError.make({ kind: "protocol", message, status })
}

const network = () => ProductClientError.make({ kind: "network", message: "Runner request could not be sent" })

const statusFailure = (response: Response) => {
  if (response.status === 401)
    return ProductClientError.make({
      kind: "unauthorized",
      message: "Runner request was not authorized",
      status: response.status,
    })
  if (response.status === 403)
    return ProductClientError.make({
      kind: "forbidden",
      message: "Runner request was forbidden",
      status: response.status,
    })
  return protocol("Runner request returned an unexpected status", response.status)
}

const decodeFingerprint = (input: string) =>
  Schema.decodeEffect(CheckoutFingerprint)(input).pipe(
    Effect.mapError(() => protocol("Runner registration request was invalid")),
  )

const decodeProfile = (input: typeof RunnerProfile.Encoded) =>
  Schema.decodeEffect(RunnerProfile)(input).pipe(
    Effect.mapError(() => protocol("Runner registration request was invalid")),
  )

const decodeThreadId = (input: string) =>
  Schema.decodeEffect(ThreadId)(input).pipe(Effect.mapError(() => protocol("Runner Thread request was invalid")))

const encodeProfile = Schema.encodeEffect(Schema.fromJsonString(RunnerProfile))
const encodeRemoteThreadCreation = Schema.encodeEffect(Schema.fromJsonString(RemoteThreadCreationPreference))
const decodeBinding = Schema.decodeEffect(Schema.fromJsonString(WorkspaceBinding))

const PollRequestBody = Schema.Struct({
  supervisorId: BoundedId,
  activeAssignmentIds: Schema.Array(BoundedId).check(Schema.isMaxLength(64)),
})
const PollAssignment = Schema.Struct({
  assignmentId: Schema.String,
  threadId: Schema.String,
  workspaceId: Schema.String,
  resume: Schema.Boolean,
  leaseExpiresAt: Schema.NullOr(Schema.Finite),
})
const PollResponse = Schema.Struct({
  claimed: Schema.Boolean,
  assignment: Schema.NullOr(PollAssignment),
})
const encodePollRequestBody = Schema.encodeEffect(Schema.fromJsonString(PollRequestBody))
const decodePollResponse = Schema.decodeEffect(Schema.fromJsonString(PollResponse))

const endpoint = (baseUrl: string | URL, path: string) =>
  Effect.try({
    try: () => {
      const base = new URL(baseUrl)
      if (
        (base.protocol !== "http:" && base.protocol !== "https:") ||
        base.username.length > 0 ||
        base.password.length > 0 ||
        base.search.length > 0 ||
        base.hash.length > 0
      )
        throw new Error("invalid base URL")
      return new URL(path, `${base.toString().replace(/\/$/, "")}/`).toString()
    },
    catch: () => protocol("Runner base URL is invalid"),
  })

const webSocketEndpoint = (url: string) =>
  Effect.try({
    try: () => {
      const socketUrl = new URL(url)
      socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:"
      return socketUrl.toString()
    },
    catch: () => protocol("Runner enrollment URL is invalid"),
  })

const request = (input: {
  readonly transport: ProductTransport
  readonly requestHeaders: ProductRequestHeaders
  readonly method: string
  readonly url: string
  readonly body?: string
}) =>
  Effect.acquireRelease(
    input.requestHeaders({ method: input.method, url: input.url }).pipe(
      Effect.flatMap((extra) =>
        Effect.try({
          try: () => {
            const headers = new Headers()
            for (const [name, value] of Object.entries(extra)) headers.set(name, value)
            if (input.body !== undefined) headers.set("content-type", "application/json")
            return input.body === undefined
              ? new Request(input.url, { method: input.method, headers })
              : new Request(input.url, { method: input.method, headers, body: input.body })
          },
          catch: () => protocol("Runner request could not be constructed"),
        }),
      ),
      Effect.flatMap((outgoing) => input.transport.request(outgoing).pipe(Effect.mapError(network))),
      Effect.timeout("10 seconds"),
      Effect.catchTag("TimeoutError", network),
    ),
    (response) => {
      const body = response.body
      return body === null
        ? Effect.void
        : Effect.tryPromise(() => body.cancel()).pipe(Effect.timeout("100 millis"), Effect.ignore)
    },
    { interruptible: true },
  )

const readBoundedResponseText = (
  body: ReadableStream<Uint8Array> | null,
  contentLength: string | null,
  response: string,
) => {
  let completed = false
  return Effect.acquireUseRelease(
    Effect.try({
      try: () => body?.getReader(),
      catch: () => protocol(`${response} was invalid`),
    }),
    (reader) =>
      Effect.gen(function* () {
        if (contentLength !== null) {
          if (!/^(?:0|[1-9][0-9]*)$/.test(contentLength)) return yield* protocol(`${response} was invalid`)
          const declaredBytes = Number(contentLength)
          if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maximumBindingBytes)
            return yield* protocol(`${response} was invalid`)
        }
        if (reader === undefined) return ""
        const chunks: Uint8Array[] = []
        let totalBytes = 0
        while (true) {
          const next = yield* Effect.tryPromise({
            try: () => reader.read(),
            catch: () => protocol(`${response} was invalid`),
          })
          if (next.done) {
            completed = true
            if (contentLength !== null && totalBytes !== Number(contentLength))
              return yield* protocol(`${response} was invalid`)
            const bytes = new Uint8Array(totalBytes)
            let offset = 0
            for (const chunk of chunks) {
              bytes.set(chunk, offset)
              offset += chunk.byteLength
            }
            return yield* Effect.try({
              try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
              catch: () => protocol(`${response} was invalid`),
            })
          }
          if (totalBytes > maximumBindingBytes - next.value.byteLength)
            return yield* protocol(`${response} was invalid`)
          chunks.push(next.value)
          totalBytes += next.value.byteLength
        }
      }).pipe(
        Effect.timeout("10 seconds"),
        Effect.catchTag("TimeoutError", () => protocol(`${response} timed out`)),
      ),
    (reader) => {
      if (reader === undefined) return Effect.void
      const cancel = completed
        ? Effect.void
        : Effect.tryPromise({
            try: () => reader.cancel(),
            catch: () => protocol(`${response} was invalid`),
          }).pipe(Effect.timeout("100 millis"), Effect.ignore)
      return cancel.pipe(
        Effect.andThen(
          Effect.try({
            try: () => reader.releaseLock(),
            catch: () => protocol(`${response} was invalid`),
          }).pipe(Effect.ignore),
        ),
      )
    },
  )
}

export interface RunnerEnrollmentRequest {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly protocols: readonly string[]
}

export interface RunnerPollAssignment {
  readonly assignmentId: string
  readonly threadId: string
  readonly workspaceId: string
  readonly resume: boolean
  readonly leaseExpiresAt: number | null
}

export interface RunnerPollResponse {
  readonly claimed: boolean
  readonly assignment: RunnerPollAssignment | null
}

export interface RunnerClient {
  readonly register: (input: {
    readonly checkoutFingerprint: string
    readonly profile: typeof RunnerProfile.Encoded
  }) => Effect.Effect<void, ProductClientError>
  readonly setRemoteThreadCreation: (input: {
    readonly checkoutFingerprint: string
    readonly preference: "allowed" | "denied"
  }) => Effect.Effect<void, ProductClientError>
  readonly poll: (input: {
    readonly checkoutFingerprint: string
    readonly supervisorId: string
    readonly activeAssignmentIds: ReadonlyArray<string>
  }) => Effect.Effect<RunnerPollResponse, ProductClientError>
  readonly binding: (threadId: string) => Effect.Effect<WorkspaceBinding, ProductClientError>
  readonly enrollmentRequest: (threadId: string) => Effect.Effect<RunnerEnrollmentRequest, ProductClientError>
}

export const makeRunnerClient = (options: {
  readonly baseUrl: string | URL
  readonly transport: ProductTransport
  readonly requestHeaders: ProductRequestHeaders
}): RunnerClient => {
  const register: RunnerClient["register"] = (input) =>
    Effect.gen(function* () {
      const checkoutFingerprint = yield* decodeFingerprint(input.checkoutFingerprint)
      const profile = yield* decodeProfile(input.profile)
      const body = yield* encodeProfile(profile).pipe(
        Effect.mapError(() => protocol("Runner registration request was invalid")),
      )
      const url = yield* endpoint(options.baseUrl, `api/v2/runners/${encodeURIComponent(checkoutFingerprint)}`)
      const response = yield* request({
        transport: options.transport,
        requestHeaders: options.requestHeaders,
        method: "PUT",
        url,
        body,
      })
      if (response.status !== 204) return yield* statusFailure(response)
    }).pipe(Effect.scoped)

  const setRemoteThreadCreation: RunnerClient["setRemoteThreadCreation"] = (input) =>
    Effect.gen(function* () {
      const checkoutFingerprint = yield* decodeFingerprint(input.checkoutFingerprint)
      const preference = yield* Schema.decodeEffect(RemoteThreadCreationPreference)({
        preference: input.preference,
      }).pipe(Effect.mapError(() => protocol("Runner preference request was invalid")))
      const body = yield* encodeRemoteThreadCreation(preference).pipe(
        Effect.mapError(() => protocol("Runner preference request was invalid")),
      )
      const url = yield* endpoint(
        options.baseUrl,
        `api/v2/runners/${encodeURIComponent(checkoutFingerprint)}/remote-thread-creation`,
      )
      const response = yield* request({
        transport: options.transport,
        requestHeaders: options.requestHeaders,
        method: "PUT",
        url,
        body,
      })
      if (response.status !== 204) return yield* statusFailure(response)
    }).pipe(Effect.scoped)

  const poll: RunnerClient["poll"] = (input) =>
    Effect.gen(function* () {
      const checkoutFingerprint = yield* decodeFingerprint(input.checkoutFingerprint)
      const body = yield* Schema.decodeEffect(PollRequestBody)({
        supervisorId: input.supervisorId,
        activeAssignmentIds: input.activeAssignmentIds,
      }).pipe(
        Effect.mapError(() => protocol("Runner poll request was invalid")),
        Effect.flatMap((validated) =>
          encodePollRequestBody(validated).pipe(Effect.mapError(() => protocol("Runner poll request was invalid"))),
        ),
      )
      const url = yield* endpoint(options.baseUrl, `api/v2/runners/${encodeURIComponent(checkoutFingerprint)}/poll`)
      const response = yield* request({
        transport: options.transport,
        requestHeaders: options.requestHeaders,
        method: "POST",
        url,
        body,
      })
      if (response.status !== 200) return yield* statusFailure(response)
      const text = yield* readBoundedResponseText(
        response.body,
        response.headers.get("content-length"),
        "Runner poll response",
      )
      return yield* decodePollResponse(text).pipe(
        Effect.mapError(() => protocol("Runner poll response was invalid", response.status)),
      )
    }).pipe(Effect.scoped)

  const binding = (threadId: string) =>
    Effect.gen(function* () {
      const validatedThreadId = yield* decodeThreadId(threadId)
      const url = yield* endpoint(
        options.baseUrl,
        `api/v2/threads/${encodeURIComponent(validatedThreadId)}/executor/binding`,
      )
      const response = yield* request({
        transport: options.transport,
        requestHeaders: options.requestHeaders,
        method: "GET",
        url,
      })
      if (response.status !== 200) return yield* statusFailure(response)
      const text = yield* readBoundedResponseText(
        response.body,
        response.headers.get("content-length"),
        "Runner binding response",
      )
      const workspaceBinding = yield* decodeBinding(text).pipe(
        Effect.mapError(() => protocol("Runner binding response was invalid", response.status)),
      )
      if (workspaceBinding.placement._tag !== "Runner")
        return yield* protocol("Runner binding response has an incompatible placement", response.status)
      return workspaceBinding
    }).pipe(Effect.scoped)

  const enrollmentRequest = (threadId: string) =>
    Effect.gen(function* () {
      const validatedThreadId = yield* decodeThreadId(threadId)
      const url = yield* endpoint(options.baseUrl, `api/v2/threads/${encodeURIComponent(validatedThreadId)}/executor`)
      const enrollmentUrl = yield* webSocketEndpoint(url)
      const headers = yield* options.requestHeaders({ method: "GET", url: enrollmentUrl })
      return { url: enrollmentUrl, headers, protocols: [workspaceExecutorWebSocketProtocol] }
    })

  return { register, setRemoteThreadCreation, poll, binding, enrollmentRequest }
}
