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
import * as ProviderCredentialStore from "@rika/product/provider-credential-store"
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
      if (candidate.providerConnection.authentication === "account") {
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
        return OpenAi.layerAccount({
          model: candidate.model,
          registrationKey,
          config: OpenAiResponses.decodeConfig(candidate.providerOptions),
          credentials: OpenAiAccountCredentials.fromRikaAuth(openAiAccountAccess(credentialIdentity), fingerprint),
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
      return AmazonBedrock.layer({
        model: candidate.model,
        registrationKey,
        config: AmazonBedrock.decodeConfig(candidate.providerOptions),
        client,
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
