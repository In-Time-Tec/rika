import { Clock, Context, Effect, Layer, Redacted, Schema } from "effect"

import {
  Box,
  BoxId,
  CreateRequest,
  ForkRequest,
  idempotencyWindowMillis,
  ResumeRequest,
  SnapshotReference,
  StopRequest,
  type CreateRequest as CreateRequestType,
  type ForkRequest as ForkRequestType,
  type ResumeRequest as ResumeRequestType,
  type StopRequest as StopRequestType,
} from "./contract"

export const maxProviderResponseBytes = 131_072

const ErrorCode = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))

export class BoxTransportError extends Schema.TaggedError<BoxTransportError>()("RikaBoxV2TransportError", {
  message: Schema.String,
}) {}

export interface BoxTransport {
  readonly request: (request: Request) => Effect.Effect<Response, BoxTransportError>
}

export const bunFetchTransport: BoxTransport = {
  request: (request) =>
    Effect.tryPromise({
      try: (signal) => Bun.fetch(request, { signal }),
      catch: () => BoxTransportError.make({ message: "Box request transport failed" }),
    }),
}

export class BoxProviderError extends Schema.TaggedError<BoxProviderError>()("RikaBoxV2ProviderError", {
  operation: Schema.Literals(["create", "fork", "resume", "stop", "get", "latest-snapshot"]),
  kind: Schema.Literals([
    "transport",
    "invalid-request",
    "invalid-response",
    "provider-rejected",
    "idempotency-reused",
    "idempotency-expired",
    "retry-exhausted",
    "outcome-unknown",
  ]),
  status: Schema.optionalKey(Schema.Int),
  code: Schema.optionalKey(ErrorCode),
  message: Schema.String,
}) {}

export type BoxProviderOperation = BoxProviderError["operation"]

const BoxInfoResponse = Schema.Struct({ box: Box })
const CreateResponse = Schema.Struct({ box: Box })
const ActionResponse = Schema.Struct({
  id: BoxId,
  status: Schema.String,
  box: Schema.optionalKey(Schema.NullOr(Box)),
})
const SnapshotLatestResponse = Schema.Struct({
  snapshot: Schema.NullOr(Schema.Struct({ ...SnapshotReference.fields, status: Schema.Literal("completed") })),
})
const ErrorResponse = Schema.Struct({
  status: Schema.Int,
  code: ErrorCode,
})

export interface BoxProviderService {
  readonly create: (request: CreateRequestType) => Effect.Effect<Box, BoxProviderError>
  readonly fork: (request: ForkRequestType) => Effect.Effect<Box, BoxProviderError>
  readonly resume: (request: ResumeRequestType) => Effect.Effect<Box, BoxProviderError>
  readonly stop: (request: StopRequestType) => Effect.Effect<Box, BoxProviderError>
  readonly get: (boxId: BoxId) => Effect.Effect<Box, BoxProviderError>
  readonly latestSnapshot: (boxId: BoxId) => Effect.Effect<SnapshotReference | null, BoxProviderError>
}

export class BoxProvider extends Context.Service<BoxProvider, BoxProviderService>()(
  "@rika/box-executor/provider/BoxProvider",
) {}

export interface BoxHttpProviderOptions {
  readonly baseUrl: string | URL
  readonly apiKey: Redacted.Redacted<string>
  readonly transport: BoxTransport
  readonly requestTimeoutMillis?: number
  readonly retryAttempts?: number
  readonly retryDelayMillis?: number
}

type ProviderBody =
  | CreateRequestType["body"]
  | ForkRequestType["body"]
  | ResumeRequestType["body"]
  | StopRequestType["body"]

const providerError = (
  operation: BoxProviderOperation,
  kind: BoxProviderError["kind"],
  message: string,
  status?: number,
  code?: string,
) => {
  if (status !== undefined && code !== undefined)
    return BoxProviderError.make({ operation, kind, message, status, code })
  if (status !== undefined) return BoxProviderError.make({ operation, kind, message, status })
  if (code !== undefined) return BoxProviderError.make({ operation, kind, message, code })
  return BoxProviderError.make({ operation, kind, message })
}

const endpoint = (baseUrl: string | URL, path: string): URL => {
  const base = new URL(baseUrl)
  return new URL(path.replace(/^\//, ""), `${base.toString().replace(/\/$/, "")}/`)
}

const responseText = (response: Response, operation: BoxProviderOperation) => {
  const body = response.body
  if (body === null) return Effect.succeed("")

  let completed = false

  return Effect.acquireUseRelease(
    Effect.try({
      try: () => body.getReader(),
      catch: () => providerError(operation, "invalid-response", "Box response body could not be read", response.status),
    }),
    (reader) => {
      const declared = response.headers.get("content-length")
      if (declared !== null) {
        const declaredBytes = Number(declared)
        if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || declaredBytes > maxProviderResponseBytes)
          return Effect.fail(
            providerError(
              operation,
              "invalid-response",
              "Box response declared an invalid byte length",
              response.status,
            ),
          )
      }

      const chunks: Array<Uint8Array> = []
      let totalBytes = 0
      const read = (): Effect.Effect<string, BoxProviderError> =>
        Effect.tryPromise<Bun.ReadableStreamDefaultReadResult<Uint8Array>, BoxProviderError>({
          try: () => reader.read(),
          catch: () =>
            providerError(operation, "invalid-response", "Box response body could not be read", response.status),
        }).pipe(
          Effect.flatMap((result) => {
            if (result.done) {
              completed = true
              const bytes = new Uint8Array(totalBytes)
              let offset = 0
              for (const chunk of chunks) {
                bytes.set(chunk, offset)
                offset += chunk.byteLength
              }
              return Effect.try({
                try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
                catch: () =>
                  providerError(
                    operation,
                    "invalid-response",
                    "Box response body was not valid UTF-8",
                    response.status,
                  ),
              })
            }

            if (totalBytes + result.value.byteLength > maxProviderResponseBytes)
              return Effect.fail(
                providerError(operation, "invalid-response", "Box response exceeded the byte bound", response.status),
              )

            chunks.push(result.value)
            totalBytes += result.value.byteLength
            return Effect.suspend(read)
          }),
        )

      return read()
    },
    (reader) =>
      (completed
        ? Effect.void
        : Effect.tryPromise({ try: () => reader.cancel(), catch: () => undefined }).pipe(
            Effect.timeout("100 millis"),
            Effect.ignore,
          )
      ).pipe(
        Effect.andThen(Effect.try({ try: () => reader.releaseLock(), catch: () => undefined }).pipe(Effect.ignore)),
      ),
  )
}

const invalidRequest = (operation: BoxProviderOperation) =>
  Effect.mapError(() => providerError(operation, "invalid-request", "Box request did not match its schema"))

const decodeResponse = <A, I>(
  schema: Schema.Codec<A, I, never, never>,
  response: Response,
  operation: BoxProviderOperation,
) =>
  responseText(response, operation).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
    Effect.mapError((error) =>
      Schema.is(BoxProviderError)(error)
        ? error
        : providerError(operation, "invalid-response", "Box response did not match its schema", response.status),
    ),
  )

const rejected = (response: Response, operation: BoxProviderOperation) =>
  decodeResponse(ErrorResponse, response, operation).pipe(
    Effect.match({
      onFailure: () =>
        providerError(operation, "provider-rejected", "Box provider rejected the request", response.status),
      onSuccess: (error) => {
        if (error.code === "idempotency_key_reused")
          return providerError(
            operation,
            "idempotency-reused",
            "Box idempotency key was reused with a different request body",
            response.status,
            error.code,
          )
        return providerError(
          operation,
          "provider-rejected",
          "Box provider rejected the request",
          response.status,
          error.code,
        )
      },
    }),
  )

const isRetryableBillableError = (error: BoxProviderError): boolean =>
  error.kind === "transport" ||
  (error.kind === "invalid-response" &&
    (error.status === undefined || (error.status >= 200 && error.status < 300) || error.status >= 500)) ||
  (error.status !== undefined && error.status >= 500) ||
  (error.status === 409 && error.code === "idempotency_in_progress")

const requestBody = (body: ProviderBody): string => JSON.stringify(body)

const boundedIntegerOption = (
  name: string,
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const configured = value ?? fallback
  if (!Number.isSafeInteger(configured) || configured < minimum || configured > maximum)
    throw new RangeError(`Box ${name} must be an integer between ${minimum} and ${maximum}`)
  return configured
}

export const makeBoxHttpProvider = (options: BoxHttpProviderOptions): BoxProviderService => {
  const requestTimeoutMillis = boundedIntegerOption("request timeout", options.requestTimeoutMillis, 30_000, 1, 120_000)
  const retryAttempts = boundedIntegerOption("retry attempts", options.retryAttempts, 4, 1, 8)
  const retryDelayMillis = boundedIntegerOption("retry delay", options.retryDelayMillis, 250, 0, 30_000)

  const send = (
    operation: BoxProviderOperation,
    method: "GET" | "POST",
    path: string,
    body?: ProviderBody,
    idempotencyKey?: string,
  ) => {
    const headers = new Headers({ authorization: `Bearer ${Redacted.value(options.apiKey)}` })
    if (body !== undefined) headers.set("content-type", "application/json")
    if (idempotencyKey !== undefined) headers.set("idempotency-key", idempotencyKey)
    const init: RequestInit = { method, headers }
    if (body !== undefined) init.body = requestBody(body)
    const request = new Request(endpoint(options.baseUrl, path).toString(), init)
    return options.transport
      .request(request)
      .pipe(Effect.mapError(() => providerError(operation, "transport", "Box request did not receive a response")))
  }

  const withinTimeout = <A, R>(
    operation: BoxProviderOperation,
    unknownOutcome: boolean,
    effect: Effect.Effect<A, BoxProviderError, R>,
  ): Effect.Effect<A, BoxProviderError, R> =>
    effect.pipe(
      Effect.timeout(`${requestTimeoutMillis} millis`),
      Effect.mapError((error) =>
        Schema.is(BoxProviderError)(error)
          ? error
          : providerError(
              operation,
              unknownOutcome ? "outcome-unknown" : "transport",
              unknownOutcome
                ? "Box provider did not confirm the lifecycle outcome"
                : "Box request did not receive a complete response",
            ),
      ),
    )

  const billable = <A, I>(
    operation: "create" | "fork",
    path: string,
    request: CreateRequestType | ForkRequestType,
    schema: Schema.Codec<A, I, never, never>,
    select: (decoded: A) => Box,
  ): Effect.Effect<Box, BoxProviderError> => {
    const attempt = (number: number): Effect.Effect<Box, BoxProviderError> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        if (
          request.expiresAtMillis - request.issuedAtMillis !== idempotencyWindowMillis ||
          now < request.issuedAtMillis
        )
          return yield* providerError(
            operation,
            "invalid-request",
            "Box billable request did not carry a currently valid idempotency window",
          )
        if (now >= request.expiresAtMillis)
          return yield* providerError(
            operation,
            "idempotency-expired",
            "Box idempotency window expired; positive reconciliation is required before another billable request",
          )
        const exchange = yield* Effect.result(
          withinTimeout(
            operation,
            false,
            send(operation, "POST", path, request.body, request.idempotencyKey).pipe(
              Effect.flatMap((response) => {
                if (response.ok) return decodeResponse(schema, response, operation).pipe(Effect.map(select))
                return rejected(response, operation).pipe(Effect.flatMap(Effect.fail))
              }),
            ),
          ),
        )
        if (exchange._tag === "Success") return exchange.success
        const error = exchange.failure
        if (!isRetryableBillableError(error)) return yield* error
        if (number >= retryAttempts)
          return yield* providerError(
            operation,
            "retry-exhausted",
            "Box acknowledgement remained unknown after bounded retries",
            error.status,
            error.code,
          )
        yield* Effect.sleep(retryDelayMillis)
        return yield* attempt(number + 1)
      })
    return attempt(1)
  }

  const action = <A, I>(
    operation: "resume" | "stop",
    path: string,
    body: ProviderBody,
    schema: Schema.Codec<A, I, never, never>,
    select: (decoded: A) => Box,
  ) =>
    withinTimeout(
      operation,
      true,
      send(operation, "POST", path, body).pipe(
        Effect.flatMap((response) => {
          if (response.ok) return decodeResponse(schema, response, operation).pipe(Effect.map(select))
          return rejected(response, operation).pipe(
            Effect.flatMap((error) =>
              Effect.fail(
                response.status >= 500
                  ? providerError(operation, "outcome-unknown", "Box provider did not confirm the lifecycle outcome")
                  : error,
              ),
            ),
          )
        }),
      ),
    ).pipe(
      Effect.mapError((error) =>
        error.kind === "transport" || error.kind === "invalid-response"
          ? providerError(operation, "outcome-unknown", "Box provider did not confirm the lifecycle outcome")
          : error,
      ),
    )

  const get = (boxId: BoxId) =>
    withinTimeout(
      "get",
      false,
      send("get", "GET", `/boxes/${encodeURIComponent(boxId)}`).pipe(
        Effect.flatMap((response) =>
          response.ok
            ? decodeResponse(BoxInfoResponse, response, "get").pipe(Effect.map((decoded) => decoded.box))
            : rejected(response, "get").pipe(Effect.flatMap(Effect.fail)),
        ),
      ),
    )

  return BoxProvider.of({
    create: (input) =>
      Schema.decodeEffect(CreateRequest)(input).pipe(
        invalidRequest("create"),
        Effect.flatMap((request) => billable("create", "/boxes", request, CreateResponse, (decoded) => decoded.box)),
      ),
    fork: (input) =>
      Schema.decodeEffect(ForkRequest)(input).pipe(
        invalidRequest("fork"),
        Effect.flatMap((request) =>
          billable(
            "fork",
            `/boxes/${encodeURIComponent(request.sourceBoxId)}/fork`,
            request,
            ActionResponse,
            (decoded) => decoded.box ?? { id: decoded.id, state: "provisioning", snapshotAvailable: false },
          ),
        ),
      ),
    resume: (input) =>
      Schema.decodeEffect(ResumeRequest)(input).pipe(
        invalidRequest("resume"),
        Effect.flatMap((request) =>
          action(
            "resume",
            `/boxes/${encodeURIComponent(request.boxId)}/resume`,
            request.body,
            ActionResponse,
            (decoded) => decoded.box ?? { id: decoded.id, state: "provisioning", snapshotAvailable: true },
          ),
        ),
      ),
    stop: (input) =>
      Schema.decodeEffect(StopRequest)(input).pipe(
        invalidRequest("stop"),
        Effect.flatMap((request) =>
          action(
            "stop",
            `/boxes/${encodeURIComponent(request.boxId)}/stop`,
            request.body,
            ActionResponse,
            (decoded) => decoded.box ?? { id: decoded.id, state: "archiving", snapshotAvailable: false },
          ),
        ),
      ),
    get: (input) => Schema.decodeEffect(BoxId)(input).pipe(invalidRequest("get"), Effect.flatMap(get)),
    latestSnapshot: (boxId) =>
      Schema.decodeEffect(BoxId)(boxId).pipe(
        invalidRequest("latest-snapshot"),
        Effect.flatMap((decodedBoxId) =>
          withinTimeout(
            "latest-snapshot",
            false,
            send("latest-snapshot", "GET", `/boxes/${encodeURIComponent(decodedBoxId)}/snapshots/latest`).pipe(
              Effect.flatMap((response) =>
                response.ok
                  ? decodeResponse(SnapshotLatestResponse, response, "latest-snapshot").pipe(
                      Effect.map(({ snapshot }) =>
                        snapshot === null
                          ? null
                          : {
                              id: snapshot.id,
                              boxId: snapshot.boxId,
                              generation: snapshot.generation,
                              completedAt: snapshot.completedAt,
                              sizeBytes: snapshot.sizeBytes,
                              fileCount: snapshot.fileCount,
                            },
                      ),
                    )
                  : rejected(response, "latest-snapshot").pipe(Effect.flatMap(Effect.fail)),
              ),
            ),
          ),
        ),
      ),
  })
}

export const boxHttpProviderLayer = (options: BoxHttpProviderOptions): Layer.Layer<BoxProvider> =>
  Layer.succeed(BoxProvider, makeBoxHttpProvider(options))

export const ProviderContract = {
  BoxProviderError,
  CreateRequest,
  ForkRequest,
  ResumeRequest,
  StopRequest,
  maxProviderResponseBytes,
}
