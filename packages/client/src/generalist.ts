/* oxlint-disable effecttsgo/strict-effect-provide -- this builder is the explicit runtime boundary for the fetch layer. */
import { Effect } from "effect"
import { HttpClient, HttpClientRequest, FetchHttpClient } from "effect/unstable/http"
import * as UrlParams from "effect/unstable/http/UrlParams"
import type { Prompt } from "effect/unstable/ai"
import * as GeneralistServer from "generalist/server"

export type GeneralistClient = GeneralistServer.Client
export type GeneralistConnection = GeneralistServer.Connection
export type GeneralistConnectionEvent = GeneralistServer.ConnectionEvent
export type GeneralistConnectionStatus = GeneralistServer.ConnectionStatus
export type GeneralistSnapshot = GeneralistServer.HostSessionSnapshot
export type GeneralistPrompt = Prompt.Prompt | string

export interface GeneralistRequestHeadersInput {
  readonly method: string
  readonly url: string
}

/**
 * The hosted credential boundary is deliberately transport-shaped. The caller owns credential storage and refresh;
 * this adapter only asks for the headers needed by one request or WebSocket upgrade and never persists a token.
 */
export interface GeneralistTransportAuth {
  readonly requestHeaders?: (
    input: GeneralistRequestHeadersInput,
  ) => Effect.Effect<Readonly<Record<string, string>>, never>
  readonly webSocketHeaders?: (
    input: { readonly method: "GET"; readonly url: string },
  ) => Effect.Effect<Readonly<Record<string, string>>, never>
}

export interface ExecutionClient {
  readonly raw: GeneralistClient
  readonly snapshot: GeneralistClient["sessions"]["snapshot"]
  readonly history: GeneralistClient["sessions"]["history"]
  readonly family: GeneralistClient["sessions"]["family"]
  readonly submit: GeneralistClient["sessions"]["submit"]
  readonly updateInput: GeneralistClient["sessions"]["updateInput"]
  readonly removeInput: GeneralistClient["sessions"]["removeInput"]
  readonly steer: GeneralistClient["runs"]["message"]
  readonly cancel: GeneralistClient["runs"]["cancel"]
  readonly control: GeneralistClient["sessions"]["control"]
  readonly runs: GeneralistClient["sessions"]["runs"]
  readonly connect: GeneralistClient["events"]["connect"]
  readonly subscribe: GeneralistClient["events"]["subscribe"]
}

/** Keep the complete execution surface on the released Generalist client. */
export const makeExecutionClient = (raw: GeneralistClient): ExecutionClient => ({
  raw,
  snapshot: raw.sessions.snapshot,
  history: raw.sessions.history,
  family: raw.sessions.family,
  submit: raw.sessions.submit,
  updateInput: raw.sessions.updateInput,
  removeInput: raw.sessions.removeInput,
  steer: raw.runs.message,
  cancel: raw.runs.cancel,
  control: raw.sessions.control,
  runs: raw.sessions.runs,
  connect: raw.events.connect,
  subscribe: raw.events.subscribe,
})

/** Build the public Generalist HTTP/WebSocket client with no Rika execution facade. */
export const makeGeneralistClient = (options: {
  readonly baseUrl: string | URL
  readonly auth?: GeneralistTransportAuth
  /** Retained for local callers while the hosted auth migration is completed. */
  readonly bearerToken?: string
}): Effect.Effect<GeneralistClient, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const base = yield* HttpClient.HttpClient
    let client = base
    const requestHeaders = options.auth?.requestHeaders
    if (requestHeaders !== undefined)
      client = HttpClient.mapRequestInputEffect(
        base,
        (request) => {
          const url = new URL(request.url, options.baseUrl)
          const query = UrlParams.toString(request.urlParams)
          if (query.length > 0) url.search = query
          return requestHeaders({ method: request.method, url: url.toString() }).pipe(
            Effect.map((headers) =>
              Object.entries(headers).reduce(
                (current, [name, value]) => HttpClientRequest.setHeader(current, name, value),
                request,
              ),
            ),
          )
        },
      )
    else if (options.bearerToken !== undefined)
      client = HttpClient.mapRequestInput(
        base,
        (request) => HttpClientRequest.setHeader(request, "authorization", `Bearer ${options.bearerToken}`),
      )
    return yield* GeneralistServer.Server.client({ baseUrl: options.baseUrl }).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
    )
  })

/** Supply fetch to `makeGeneralistClient`; WebSocket construction remains an explicit caller layer. */
export const makeGeneralistClientLayer = (options: {
  readonly baseUrl: string | URL
  readonly auth?: GeneralistTransportAuth
  readonly bearerToken?: string
}) =>
  makeGeneralistClient(options).pipe(Effect.provide(FetchHttpClient.layer))
