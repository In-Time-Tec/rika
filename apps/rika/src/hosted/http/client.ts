import { Crypto, Effect, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { HostedError, type PrivateJwk, type Session } from "../contract"
import * as Dpop from "../dpop"
import { OAuthErrorWire, TokenWire, tokensFrom } from "./schema"

const failure = (kind: HostedError["kind"], message: string) => HostedError.make({ kind, message })

const detailLimit = 240

/** One line of the server's error body, preferring a JSON `message` field, bounded so it fits a status line. */
const ErrorBody = Schema.fromJsonString(
  Schema.Struct({
    message: Schema.optionalKey(Schema.String),
    error_description: Schema.optionalKey(Schema.String),
    error: Schema.optionalKey(Schema.String),
  }),
)
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody)

export const responseDetail = (body: string): string => {
  const trimmed = body.trim()
  if (trimmed === "") return ""
  const detail = Option.match(decodeErrorBody(trimmed), {
    onNone: () => trimmed,
    onSome: (parsed) => {
      const candidate = parsed.message ?? parsed.error_description ?? parsed.error
      return candidate === undefined || candidate.trim() === "" ? trimmed : candidate
    },
  })
  const line = detail.replace(/\s+/g, " ").trim()
  return `: ${line.length > detailLimit ? `${line.slice(0, detailLimit - 1)}…` : line}`
}

export const clientOperations = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient
  const crypto = yield* Crypto.Crypto
  const execute = (request: HttpClientRequest.HttpClientRequest) =>
    client.execute(request).pipe(
      Effect.timeoutOption("30 seconds"),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(failure("network", "Server request timed out")),
          onSome: Effect.succeed,
        }),
      ),
      Effect.mapError((error) => (Schema.is(HostedError)(error) ? error : failure("network", "Server request failed"))),
    )
  const decode = <S extends Schema.Constraint>(
    response: HttpClientResponse.HttpClientResponse,
    schema: S,
    message: string,
  ) => HttpClientResponse.schemaBodyJson(schema)(response).pipe(Effect.mapError(() => failure("protocol", message)))
  /**
   * Builds the failure for a non-2xx response. The status and a short body excerpt travel in the message so the
   * user and the diagnostics log see why the server refused, not only that it did.
   */
  const responseError = (
    response: HttpClientResponse.HttpClientResponse,
    action: string,
  ): Effect.Effect<never, HostedError> =>
    Effect.gen(function* () {
      if (response.status === 401) return yield* failure("login-required", "Identity login is required")
      if (response.status === 429) {
        const value = response.headers["x-retry-after"] ?? response.headers["retry-after"]
        const seconds = value === undefined ? Number.NaN : Number(value)
        const retryAfterMillis = Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1_000) : undefined
        const suffix = retryAfterMillis === undefined ? "" : `; retry in ${Math.ceil(retryAfterMillis / 1_000)} seconds`
        const limited = {
          kind: "rate-limit",
          message: `${action} was rate limited${suffix}`,
          status: response.status,
        } as const
        return yield* HostedError.make(retryAfterMillis === undefined ? limited : { ...limited, retryAfterMillis })
      }
      const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      return yield* HostedError.make({
        kind: response.status >= 500 ? "network" : "protocol",
        message: `${action} failed (HTTP ${response.status})${responseDetail(body)}`,
        status: response.status,
      })
    })
  const withDpop = Effect.fn("HostedHttp.withDpop")(function* (
    request: HttpClientRequest.HttpClientRequest,
    method: string,
    url: string,
    privateJwk: PrivateJwk,
    accessToken?: Redacted.Redacted<string>,
  ) {
    const jti = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(() => failure("host", "Could not create a DPoP identifier")),
    )
    const value = yield* Dpop.proof({ method, url, privateJwk, jti, accessToken })
    return request.pipe(
      HttpClientRequest.setHeader("DPoP", value),
      accessToken === undefined
        ? (current) => current
        : HttpClientRequest.setHeader("Authorization", `DPoP ${Redacted.value(accessToken)}`),
    )
  })
  const tokenResponse = Effect.fn("HostedHttp.tokenResponse")(function* (
    response: HttpClientResponse.HttpClientResponse,
    action: string,
    previousRefreshToken?: string,
  ) {
    if (response.status >= 200 && response.status < 300)
      return yield* decode(response, TokenWire, `${action} returned an invalid response`).pipe(
        Effect.flatMap(tokensFrom(previousRefreshToken)),
      )
    const oauth = yield* decode(response, OAuthErrorWire, `${action} failed`).pipe(Effect.option)
    if (Option.isSome(oauth) && (oauth.value.error === "invalid_grant" || oauth.value.error === "invalid_token"))
      return yield* failure("login-required", "Identity login is required")
    return yield* responseError(response, action)
  })
  const authenticatedJson = <S extends Schema.Constraint>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    request: HttpClientRequest.HttpClientRequest,
    session: Session,
    schema: S,
    action: string,
  ) =>
    withDpop(request, method, url, session.privateJwk, session.accessToken).pipe(
      Effect.flatMap(execute),
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300
          ? decode(response, schema, `${action} returned an invalid response`)
          : responseError(response, action),
      ),
    )
  const authenticatedEmpty = (
    method: "POST" | "PUT",
    url: string,
    request: HttpClientRequest.HttpClientRequest,
    session: Session,
    action: string,
  ) =>
    withDpop(request, method, url, session.privateJwk, session.accessToken).pipe(
      Effect.flatMap(execute),
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300 ? Effect.void : responseError(response, action),
      ),
    )
  return { authenticatedEmpty, authenticatedJson, decode, execute, responseError, tokenResponse, withDpop }
})
