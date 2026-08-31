import { OpenAiClient as OpenAIClient, OpenAiSchema as OpenAISchema } from "@effect/ai-openai"
import * as OpenAi from "generalist/ai/openai"
import type * as OpenAiAuthContract from "@rika/product/openai-auth-contract"
import type * as OpenAiAuth from "@rika/product/openai-auth-service"
import { Effect, Function, Layer, Redacted, Schema, Stream } from "effect"
import { AiError } from "effect/unstable/ai"
import { FetchHttpClient, Headers, HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http"

const apiUrl = "https://chatgpt.com/backend-api/codex"
const responsesUrl = `${apiUrl}/responses`
const accountIdHeader = "ChatGPT-Account-ID"

export class CredentialError extends Schema.TaggedError<CredentialError>()(
  "@rika/execution/OpenAiAccountCredentialError",
  { operation: Schema.Literals(["acquire", "refreshRejected"]) },
) {}

export interface Credential {
  readonly accessToken: Redacted.Redacted<string>
  readonly accountId: string
  readonly generation: string
}

export interface Credentials {
  readonly acquire: Effect.Effect<Credential, CredentialError>
  readonly refreshRejected: (generation: string) => Effect.Effect<Credential, CredentialError>
}

const adapt = (
  operation: "acquire" | "refreshRejected",
  expectedFingerprint: string,
  effect: Effect.Effect<OpenAiAuthContract.Credential, OpenAiAuthContract.AuthError | OpenAiAuthContract.StoreError>,
): Effect.Effect<Credential, CredentialError> =>
  effect.pipe(
    Effect.filterOrFail(
      (credential) => credential.fingerprint === expectedFingerprint,
      () => CredentialError.make({ operation }),
    ),
    Effect.map((credential) => ({
      accessToken: credential.accessToken,
      accountId: Redacted.value(credential.accountId),
      generation: credential.generation,
    })),
    Effect.mapError(() => CredentialError.make({ operation })),
  )

const fromRikaAuthImpl = (auth: OpenAiAuth.CredentialAccess, expectedFingerprint: string): Credentials => ({
  acquire: adapt("acquire", expectedFingerprint, auth.acquire),
  refreshRejected: (generation) => adapt("refreshRejected", expectedFingerprint, auth.refreshRejected(generation)),
})

export const fromRikaAuth: {
  (expectedFingerprint: string): (auth: OpenAiAuth.CredentialAccess) => Credentials
  (auth: OpenAiAuth.CredentialAccess, expectedFingerprint: string): Credentials
} = Function.dual(2, fromRikaAuthImpl)

const credentialFailure = (request: HttpClientRequest.HttpClientRequest, error: CredentialError) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({
      request,
      cause: error,
      description: `OpenAI account credential ${error.operation} failed`,
    }),
  })

const withCredential = (request: HttpClientRequest.HttpClientRequest, credential: Credential) =>
  request.pipe(
    HttpClientRequest.setUrl(responsesUrl),
    HttpClientRequest.bearerToken(credential.accessToken),
    HttpClientRequest.setHeader(accountIdHeader, credential.accountId),
    HttpClientRequest.accept("text/event-stream"),
  )

const executeWithCredential = (
  client: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
  credential: Credential,
) =>
  client.postprocess(Effect.succeed(withCredential(request, credential))).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    Effect.updateService(Headers.CurrentRedactedNames, (names) => [...names, accountIdHeader]),
  )

const accountClient = (credentials: Credentials) => (client: HttpClient.HttpClient) =>
  HttpClient.transform(client, (_, request) =>
    credentials.acquire.pipe(
      Effect.mapError((error) => credentialFailure(request, error)),
      Effect.flatMap((credential) =>
        executeWithCredential(client, request, credential).pipe(
          Effect.catchIf(
            (error) => error.reason._tag === "StatusCodeError" && error.reason.response.status === 401,
            (error) => {
              if (error.reason._tag !== "StatusCodeError") return Effect.fail(error)
              return Stream.runDrain(error.reason.response.stream).pipe(
                Effect.ignore,
                Effect.andThen(credentials.refreshRejected(credential.generation)),
                Effect.mapError((credentialError) => credentialFailure(request, credentialError)),
                Effect.flatMap((refreshed) => executeWithCredential(client, request, refreshed)),
              )
            },
          ),
        ),
      ),
    ),
  )

const redactAccountHeader = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.updateService(Headers.CurrentRedactedNames, (names) => [...names, accountIdHeader]))

const withoutSocket = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(OpenAIClient.OpenAiSocket, undefined))

const accountError = (method: string, description: string) =>
  AiError.make({ module: "OpenAiClient", method, reason: AiError.UnknownError.make({ description }) })

const terminalResponse = (event: OpenAIClient.ResponseStreamEvent): OpenAISchema.Response | undefined => {
  if (event.type !== "response.completed" && event.type !== "response.incomplete") return undefined
  return "response" in event && Schema.is(OpenAISchema.Response)(event.response) ? event.response : undefined
}

const createResponse =
  (client: OpenAIClient.Service): OpenAIClient.Service["createResponse"] =>
  (options) => {
    const { stream: _stream, ...payload } = options
    return client.createResponseStream(payload).pipe(
      withoutSocket,
      Effect.flatMap(([response, events]) =>
        events.pipe(
          Stream.mapEffect((event) =>
            event.type === "error"
              ? Effect.fail(accountError("createResponse", JSON.stringify(event)))
              : Effect.succeed(terminalResponse(event)),
          ),
          Stream.runFold(
            (): ReturnType<typeof terminalResponse> => undefined,
            (found, current) => found ?? current,
          ),
          Effect.flatMap((result) =>
            result === undefined
              ? Effect.fail(accountError("createResponse", "OpenAI account response ended without a terminal event"))
              : Effect.succeed([result, response] as const),
          ),
        ),
      ),
    )
  }

const createEmbedding: OpenAIClient.Service["createEmbedding"] = () =>
  Effect.fail(accountError("createEmbedding", "The OpenAI account endpoint does not support embeddings"))

/** The account transport remains a Rika provider concern because Generalist 0.45 exposes no account model registration. */
export const layerClient = (
  credentials: Credentials,
): Layer.Layer<OpenAIClient.OpenAiClient, never, HttpClient.HttpClient> =>
  Layer.effect(
    OpenAIClient.OpenAiClient,
    OpenAIClient.make({
      apiUrl,
      transformClient: (client) => client.pipe(OpenAi.normalizeResponsesSSE, accountClient(credentials)),
    }).pipe(
      Effect.map((client) =>
        OpenAIClient.OpenAiClient.of({
          client: client.client,
          createResponse: (options) => redactAccountHeader(createResponse(client)(options)),
          createResponseStream: (options) =>
            client.createResponseStream(options).pipe(
              withoutSocket,
              redactAccountHeader,
              Effect.map(([response, events]) => [
                response,
                events.pipe(Stream.updateService(Headers.CurrentRedactedNames, (names) => [...names, accountIdHeader])),
              ]),
            ),
          createEmbedding,
        }),
      ),
    ),
  )
