import { Effect, Layer, Option } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"

// The AI providers record `hash: Option.getOrUndefined(request.hash)` on the
// response-metadata part. An absent fragment becomes `undefined`, and persisting the
// run event through JSON drops the key entirely. Baton then replays the stored event
// against `Schema.UndefinedOr(Schema.String)`, which accepts `undefined` but still
// requires the key, so every model call fails to decode after a round trip.
// Carrying an empty fragment keeps the key present without changing the request:
// a URL fragment is never sent to the server.
export const withDecodableRequestDetails: (client: HttpClient.HttpClient) => HttpClient.HttpClient =
  HttpClient.mapRequest((request) => (Option.isSome(request.hash) ? request : HttpClientRequest.setHash(request, "")))

export const providerHttpClientLayer = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(HttpClient.HttpClient, withDecodableRequestDetails),
).pipe(Layer.provide(FetchHttpClient.layer))
