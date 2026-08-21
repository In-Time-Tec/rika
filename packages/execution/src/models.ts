import { ModelRegistry } from "tenetkit"
import {
  AmazonBedrock,
  Anthropic,
  Deterministic,
  OpenAi,
  OpenAiChatCompletions,
  OpenAiResponses,
  OpenRouter,
} from "tenetkit/ai"
import { Errors } from "tenetkit/runtime"
import type * as ExecutionRoute from "@rika/product/execution-route-snapshot"
import type * as OpenAiAuth from "@rika/product/openai-auth-service"
import {
  ProviderCredentialStoreError,
  type ProviderCredentialStoreShape,
} from "@rika/product/provider-credential-store"
import { Config, Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/unstable/http"
import * as OpenAiAccountCredentials from "./openai-account-credentials"

type CandidateSnapshot = ExecutionRoute.ExecutionRouteModelCandidateSnapshot

const apiKey = (candidate: CandidateSnapshot) =>
  candidate.providerConnection.apiKeyEnvironment === undefined
    ? Config.succeed(Redacted.make(""))
    : Config.redacted(candidate.providerConnection.apiKeyEnvironment)

const storedCredentialApiKey = (
  candidate: CandidateSnapshot,
  store: ProviderCredentialStoreShape | undefined,
): Effect.Effect<Config.Config<Redacted.Redacted<string>>, ProviderCredentialStoreError> => {
  const identity = candidate.providerConnection.credentialIdentity
  if (identity === undefined || store === undefined) return Effect.succeed(apiKey(candidate))
  return store.load(identity).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            ProviderCredentialStoreError.make({
              kind: "missing",
              message: "Provider credential is unavailable",
            }),
          ),
        onSome: (credential) => Effect.succeed(Config.succeed(credential)),
      }),
    ),
  )
}

export const layer = (options: {
  readonly candidate: CandidateSnapshot
  readonly credentialStore?: ProviderCredentialStoreShape
  readonly openAiAccountAuth?: OpenAiAuth.ServiceInterface
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>
}): Layer.Layer<
  ModelRegistry.ModelRegistry,
  Config.ConfigError | Errors.ExecutableRegistrationInvalid | ProviderCredentialStoreError
> => {
  const { candidate, credentialStore, openAiAccountAuth } = options
  const httpClientLayer = options.httpClientLayer ?? FetchHttpClient.layer
  const registrationKey = candidate.registrationIdentity
  switch (candidate.providerConnection.protocol) {
    case "openai-responses":
      if (candidate.providerConnection.authentication === "account") {
        const fingerprint = candidate.providerConnection.credentialIdentity
        if (fingerprint === undefined)
          return Layer.effect(
            ModelRegistry.ModelRegistry,
            Effect.fail(
              Errors.ExecutableRegistrationInvalid.make({
                message: "OpenAI account route is missing its credential identity",
              }),
            ),
          )
        if (openAiAccountAuth === undefined)
          return Layer.effect(
            ModelRegistry.ModelRegistry,
            Effect.fail(
              Errors.ExecutableRegistrationInvalid.make({ message: "OpenAI account authentication is unavailable" }),
            ),
          )
        return OpenAi.layerAccount({
          model: candidate.model,
          registrationKey,
          config: OpenAiResponses.decodeConfig(candidate.providerOptions),
          credentials: OpenAiAccountCredentials.fromRikaAuth(openAiAccountAuth, fingerprint),
        }).pipe(Layer.provide(httpClientLayer))
      }
      return Layer.unwrap(
        storedCredentialApiKey(candidate, credentialStore).pipe(
          Effect.map((resolvedApiKey) =>
            OpenAiResponses.layer({
              model: candidate.model,
              provider: candidate.providerConnection.provider,
              registrationKey,
              config: OpenAiResponses.decodeConfig(candidate.providerOptions),
              apiKey: resolvedApiKey,
              baseUrl: candidate.providerConnection.baseUrl,
            }).pipe(Layer.provide(httpClientLayer)),
          ),
        ),
      )
    case "openai-chat-completions":
      return Layer.unwrap(
        storedCredentialApiKey(candidate, credentialStore).pipe(
          Effect.map((resolvedApiKey) =>
            OpenAiChatCompletions.layer({
              model: candidate.model,
              provider: candidate.providerConnection.provider,
              registrationKey,
              config: OpenAiChatCompletions.decodeConfig(candidate.providerOptions),
              apiKey: resolvedApiKey,
              baseUrl: candidate.providerConnection.baseUrl,
            }).pipe(Layer.provide(httpClientLayer)),
          ),
        ),
      )
    case "anthropic":
      return Layer.unwrap(
        storedCredentialApiKey(candidate, credentialStore).pipe(
          Effect.map((resolvedApiKey) =>
            Anthropic.layer({
              model: candidate.model,
              registrationKey,
              config: Anthropic.decodeConfig(candidate.providerOptions),
              apiKey: resolvedApiKey,
              clientConfig: { apiUrl: Config.succeed(candidate.providerConnection.baseUrl) },
            }).pipe(Layer.provide(httpClientLayer)),
          ),
        ),
      )
    case "openrouter":
      return Layer.unwrap(
        storedCredentialApiKey(candidate, credentialStore).pipe(
          Effect.map((resolvedApiKey) =>
            OpenRouter.layer({
              model: candidate.model,
              registrationKey,
              config: OpenRouter.decodeConfig(candidate.providerOptions),
              apiKey: resolvedApiKey,
              clientConfig: { apiUrl: Config.succeed(candidate.providerConnection.baseUrl) },
            }).pipe(Layer.provide(httpClientLayer)),
          ),
        ),
      )
    case "amazon-bedrock": {
      const connection = new URL(candidate.providerConnection.baseUrl)
      return AmazonBedrock.layer({
        model: candidate.model,
        registrationKey,
        config: AmazonBedrock.decodeConfig(candidate.providerOptions),
        client: {
          authMode: connection.searchParams.get("authMode") === "bearer" ? "bearer" : "default",
          ...(connection.searchParams.get("region") === null ? {} : { region: connection.searchParams.get("region")! }),
          ...(connection.searchParams.get("profile") === null
            ? {}
            : { profile: connection.searchParams.get("profile")! }),
          ...(connection.hostname === "default"
            ? {}
            : { endpoint: `${connection.protocol}//${connection.host}${connection.pathname}` }),
        },
      })
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
            message: `Unsupported TenetKit provider protocol ${candidate.providerConnection.protocol}`,
          }),
        ),
      )
  }
}
