import { ModelRegistry } from "generalist"
import * as AmazonBedrock from "generalist/ai/amazon-bedrock"
import * as Anthropic from "generalist/ai/anthropic"
import * as Deterministic from "generalist/ai/deterministic"
import * as OpenAi from "generalist/ai/openai"
import * as OpenAiChatCompletions from "generalist/ai/openai-chat-completions"
import * as OpenAiResponses from "generalist/ai/openai-responses"
import * as OpenRouter from "generalist/ai/openrouter"
import { Errors } from "generalist/runtime"
import type * as ExecutionRoute from "@rika/product/execution-route-snapshot"
import type * as OpenAiAuth from "@rika/product/openai-auth-service"
import * as ProviderCredentialStore from "@rika/product/provider-credential-store"
import { Config, Effect, Layer, Option, Redacted, Schema } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/unstable/http"
import * as OpenAiAccountCredentials from "./openai-account-credentials"

type CandidateSnapshot = ExecutionRoute.ExecutionRouteModelCandidateSnapshot
type ModelLayer = Layer.Layer<
  ModelRegistry.ModelRegistry,
  Config.ConfigError | Errors.ExecutableRegistrationInvalid | ProviderCredentialStore.ProviderCredentialStoreError
>

const apiKey = (candidate: CandidateSnapshot) =>
  candidate.providerConnection.apiKeyEnvironment === undefined
    ? Config.succeed(Redacted.make(""))
    : Config.redacted(candidate.providerConnection.apiKeyEnvironment)

const decodeProviderConfig = <A>(
  protocol: CandidateSnapshot["providerConnection"]["protocol"],
  decoded: Effect.Effect<A, Schema.SchemaError>,
): Effect.Effect<A, Errors.ExecutableRegistrationInvalid> =>
  decoded.pipe(
    Effect.mapError((cause) =>
      Errors.ExecutableRegistrationInvalid.make({
        message: `Invalid ${protocol} provider options: ${String(cause)}`,
      }),
    ),
  )

const storedCredentialApiKey = (
  candidate: CandidateSnapshot,
  store: ProviderCredentialStore.ProviderCredentialStore["Service"] | undefined,
): Effect.Effect<Config.Config<Redacted.Redacted<string>>, ProviderCredentialStore.ProviderCredentialStoreError> => {
  const identity = candidate.providerConnection.credentialIdentity
  if (identity === undefined || store === undefined) return Effect.succeed(apiKey(candidate))
  return store.load(identity).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            ProviderCredentialStore.ProviderCredentialStoreError.make({
              kind: "missing",
              message: "Provider credential is unavailable",
            }),
          ),
        onSome: (credential) => Effect.succeed(Config.succeed(credential)),
      }),
    ),
  )
}

const openAiResponsesLayer = (
  candidate: CandidateSnapshot,
  credentialStore: ProviderCredentialStore.ProviderCredentialStore["Service"] | undefined,
  openAiAccountAccess: ((credentialIdentity: string) => OpenAiAuth.CredentialAccess) | undefined,
  httpClientLayer: Layer.Layer<HttpClient.HttpClient>,
): ModelLayer => {
  const registrationKey = candidate.registrationIdentity
  if (candidate.providerConnection.authentication !== "account")
    return Layer.unwrap(
      Effect.all({
        apiKey: storedCredentialApiKey(candidate, credentialStore),
        config: decodeProviderConfig(
          candidate.providerConnection.protocol,
          OpenAiResponses.decodeConfig(candidate.providerOptions),
        ),
      }).pipe(
        Effect.map(({ apiKey: resolvedApiKey, config }) =>
          OpenAiResponses.layer({
            model: candidate.model,
            provider: candidate.providerConnection.provider,
            registrationKey,
            config,
            apiKey: resolvedApiKey,
            baseUrl: candidate.providerConnection.baseUrl,
          }).pipe(Layer.provide(httpClientLayer)),
        ),
      ),
    )
  const credentialIdentity = candidate.providerConnection.credentialIdentity
  const fingerprint = candidate.providerConnection.accountFingerprint
  if (credentialIdentity === undefined || fingerprint === undefined)
    return Layer.effect(
      ModelRegistry.ModelRegistry,
      Effect.fail(
        Errors.ExecutableRegistrationInvalid.make({
          message: "OpenAI account route is missing its credential identity or fingerprint",
        }),
      ),
    )
  if (openAiAccountAccess === undefined)
    return Layer.effect(
      ModelRegistry.ModelRegistry,
      Effect.fail(
        Errors.ExecutableRegistrationInvalid.make({ message: "OpenAI account authentication is unavailable" }),
      ),
    )
  const credentials = OpenAiAccountCredentials.fromRikaAuth(openAiAccountAccess(credentialIdentity), fingerprint)
  return Layer.unwrap(
    decodeProviderConfig(
      candidate.providerConnection.protocol,
      OpenAiResponses.decodeConfig(candidate.providerOptions),
    ).pipe(
      Effect.map((config) =>
        ModelRegistry.layer([
          OpenAi.registration({
            model: candidate.model,
            registrationKey,
            config,
          }),
        ]).pipe(Layer.provide(OpenAiAccountCredentials.layerClient(credentials)), Layer.provide(httpClientLayer)),
      ),
    ),
  )
}

export const layer = (options: {
  readonly candidate: CandidateSnapshot
  readonly credentialStore?: ProviderCredentialStore.ProviderCredentialStoreService
  readonly openAiAccountAccess?: (credentialIdentity: string) => OpenAiAuth.CredentialAccess
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>
}): Layer.Layer<
  ModelRegistry.ModelRegistry,
  Config.ConfigError | Errors.ExecutableRegistrationInvalid | ProviderCredentialStore.ProviderCredentialStoreError
> => {
  const { candidate, credentialStore, openAiAccountAccess } = options
  const httpClientLayer = options.httpClientLayer ?? FetchHttpClient.layer
  const registrationKey = candidate.registrationIdentity
  switch (candidate.providerConnection.protocol) {
    case "openai-responses":
      return openAiResponsesLayer(candidate, credentialStore, openAiAccountAccess, httpClientLayer)
    case "openai-chat-completions":
      return Layer.unwrap(
        Effect.all({
          apiKey: storedCredentialApiKey(candidate, credentialStore),
          config: decodeProviderConfig(
            candidate.providerConnection.protocol,
            OpenAiChatCompletions.decodeConfig(candidate.providerOptions),
          ),
        }).pipe(
          Effect.map(({ apiKey: resolvedApiKey, config }) =>
            OpenAiChatCompletions.layer({
              model: candidate.model,
              provider: candidate.providerConnection.provider,
              registrationKey,
              config,
              apiKey: resolvedApiKey,
              baseUrl: candidate.providerConnection.baseUrl,
            }).pipe(Layer.provide(httpClientLayer)),
          ),
        ),
      )
    case "anthropic":
      return Layer.unwrap(
        Effect.all({
          apiKey: storedCredentialApiKey(candidate, credentialStore),
          config: decodeProviderConfig(
            candidate.providerConnection.protocol,
            Anthropic.decodeConfig(candidate.providerOptions),
          ),
        }).pipe(
          Effect.map(({ apiKey: resolvedApiKey, config }) =>
            Anthropic.layer({
              model: candidate.model,
              registrationKey,
              config,
              apiKey: resolvedApiKey,
              clientConfig: { apiUrl: Config.succeed(candidate.providerConnection.baseUrl) },
            }).pipe(Layer.provide(httpClientLayer)),
          ),
        ),
      )
    case "openrouter":
      return Layer.unwrap(
        Effect.all({
          apiKey: storedCredentialApiKey(candidate, credentialStore),
          config: decodeProviderConfig(
            candidate.providerConnection.protocol,
            OpenRouter.decodeConfig(candidate.providerOptions),
          ),
        }).pipe(
          Effect.map(({ apiKey: resolvedApiKey, config }) =>
            OpenRouter.layer({
              model: candidate.model,
              registrationKey,
              config,
              apiKey: resolvedApiKey,
              clientConfig: { apiUrl: Config.succeed(candidate.providerConnection.baseUrl) },
            }).pipe(Layer.provide(httpClientLayer)),
          ),
        ),
      )
    case "amazon-bedrock": {
      const connection = new URL(candidate.providerConnection.baseUrl)
      const region = connection.searchParams.get("region")
      const profile = connection.searchParams.get("profile")
      const endpoint = `${connection.protocol}//${connection.host}${connection.pathname}`
      const authMode: "bearer" | "default" = connection.searchParams.get("authMode") === "bearer" ? "bearer" : "default"
      const client = {
        authMode,
      }
      if (region !== null) Object.assign(client, { region })
      if (profile !== null) Object.assign(client, { profile })
      if (connection.hostname !== "default") Object.assign(client, { endpoint })
      return Layer.unwrap(
        decodeProviderConfig(
          candidate.providerConnection.protocol,
          AmazonBedrock.decodeConfig(candidate.providerOptions),
        ).pipe(
          Effect.map((config) =>
            AmazonBedrock.layer({
              model: candidate.model,
              registrationKey,
              config,
              client,
            }),
          ),
        ),
      )
    }
    case "test":
      return Deterministic.layer({
        provider: candidate.providerConnection.provider,
        model: candidate.model,
        registrationKey,
      })
    default:
      return Layer.effect(
        ModelRegistry.ModelRegistry,
        Effect.fail(
          Errors.ExecutableRegistrationInvalid.make({
            message: `Unsupported Generalist provider protocol ${candidate.providerConnection.protocol}`,
          }),
        ),
      )
  }
}
