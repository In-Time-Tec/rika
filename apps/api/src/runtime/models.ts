import { AnthropicClient } from "@effect/ai-anthropic"
import { OpenAiClient } from "@effect/ai-openai"
import { OpenRouterClient } from "@effect/ai-openrouter"
import { Effect, Layer, Option, Redacted, Schema, Scope } from "effect"
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http"
import { ModelRegistry } from "generalist"
import * as Anthropic from "generalist/providers/anthropic"
import * as OpenAi from "generalist/providers/openai"
import * as OpenAiResponses from "generalist/providers/openai-responses"
import * as OpenRouter from "generalist/providers/openrouter"
import type { ModelConfiguration, SecureCredentialReference } from "@rika/context"

export class ModelRegistryConfigurationError extends Schema.TaggedError<ModelRegistryConfigurationError>()(
  "RikaApiV2ModelRegistryConfigurationError",
  {
    reason: Schema.Literals(["provider", "credential", "settings"]),
    message: Schema.String,
  },
) {}

export class ModelCredentialResolutionError extends Schema.TaggedError<ModelCredentialResolutionError>()(
  "RikaApiV2ModelCredentialResolutionError",
  {
    reason: Schema.Literals(["missing", "revoked", "corrupt", "unavailable"]),
    message: Schema.String,
  },
) {}

export interface ModelCredentialAccess {
  readonly resolve: (input: {
    readonly ownerId: string
    readonly selection: ModelRegistry.ModelSelection
    readonly reference: SecureCredentialReference
  }) => Effect.Effect<Redacted.Redacted<string>, ModelCredentialResolutionError, Scope.Scope>
}

export interface ModelRegistryLayerOptions {
  readonly ownerId: string
  readonly model: ModelConfiguration
  readonly credentials: ModelCredentialAccess
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>
}

const configurationError = (reason: ModelRegistryConfigurationError["reason"], message: string) =>
  ModelRegistryConfigurationError.make({ reason, message })

const selectionFor = (model: ModelConfiguration): ModelRegistry.ModelSelection => {
  const selection = { provider: model.selection.provider, model: model.selection.model }
  return model.selection.registrationKey === undefined
    ? selection
    : { ...selection, registrationKey: model.selection.registrationKey }
}

const credentialReferenceFor = (
  model: ModelConfiguration,
): Effect.Effect<SecureCredentialReference, ModelRegistryConfigurationError> => {
  const references = model.credentialRefs.filter((reference) => reference.provider === model.selection.provider)
  if (references.length === 1) return Effect.succeed(references[0]!)
  return Effect.fail(
    configurationError(
      "credential",
      references.length === 0
        ? "The selected model has no matching credential reference"
        : "The selected model has ambiguous credential references",
    ),
  )
}

const JsonRecord = Schema.Record(Schema.String, Schema.Json)
const decodeJsonRecord = Schema.decodeUnknownOption(JsonRecord)
const emptyJsonRecord: Record<string, Schema.Json> = {}

const jsonRecord = (value: Schema.Json | undefined): Record<string, Schema.Json> =>
  Option.match(decodeJsonRecord(value), {
    onNone: () => ({ ...emptyJsonRecord }),
    onSome: (record) => ({ ...record }),
  })

const openAiOptions = (model: ModelConfiguration) => {
  const options = jsonRecord(model.settings.options)
  if (model.settings.temperature !== undefined) options.temperature = model.settings.temperature
  if (model.settings.maxOutputTokens !== undefined) options.max_output_tokens = model.settings.maxOutputTokens
  if (model.settings.reasoningEffort !== undefined)
    options.reasoning = { ...jsonRecord(options.reasoning), effort: model.settings.reasoningEffort }
  return options
}

const anthropicOptions = (model: ModelConfiguration) => {
  const options = jsonRecord(model.settings.options)
  if (model.settings.temperature !== undefined) options.temperature = model.settings.temperature
  if (model.settings.maxOutputTokens !== undefined) options.max_tokens = model.settings.maxOutputTokens
  if (model.settings.reasoningEffort !== undefined)
    options.output_config = { ...jsonRecord(options.output_config), effort: model.settings.reasoningEffort }
  return options
}

const openRouterOptions = (model: ModelConfiguration) => {
  const options = jsonRecord(model.settings.options)
  if (model.settings.temperature !== undefined) options.temperature = model.settings.temperature
  if (model.settings.maxOutputTokens !== undefined) options.max_tokens = model.settings.maxOutputTokens
  if (model.settings.reasoningEffort !== undefined)
    options.reasoning = { ...jsonRecord(options.reasoning), effort: model.settings.reasoningEffort }
  return options
}

type CredentialHeader = (
  request: HttpClientRequest.HttpClientRequest,
  credential: Redacted.Redacted<string>,
) => HttpClientRequest.HttpClientRequest

const bearerCredential: CredentialHeader = (request, credential) => HttpClientRequest.bearerToken(request, credential)

const anthropicCredential: CredentialHeader = (request, credential) =>
  HttpClientRequest.setHeader(request, "x-api-key", Redacted.value(credential))

const credentialFailure = (request: HttpClientRequest.HttpClientRequest) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request, description: "Model credential is unavailable" }),
  })

const transformClient =
  (
    options: ModelRegistryLayerOptions,
    selection: ModelRegistry.ModelSelection,
    reference: SecureCredentialReference,
    header: CredentialHeader,
  ): ((client: HttpClient.HttpClient) => HttpClient.HttpClient) =>
  (client: HttpClient.HttpClient) =>
    HttpClient.mapRequestEffect(client, (request) =>
      Effect.scoped(
        options.credentials.resolve({ ownerId: options.ownerId, selection, reference }).pipe(
          Effect.map((credential) => header(request, credential)),
          Effect.mapError(() => credentialFailure(request)),
        ),
      ),
    )

const httpClientLayer = (options: ModelRegistryLayerOptions): Layer.Layer<HttpClient.HttpClient> =>
  options.httpClientLayer ?? FetchHttpClient.layer

const openAiLayer = (
  options: ModelRegistryLayerOptions,
  selection: ModelRegistry.ModelSelection,
  reference: SecureCredentialReference,
  config: OpenAi.Config,
): Layer.Layer<ModelRegistry.ModelRegistry> => {
  const registration = {
    provider: selection.provider,
    model: selection.model,
    layer: OpenAiResponses.layerModel({ provider: selection.provider, model: selection.model, config }),
    classifyFailure: OpenAi.classifyFailure,
    toolJsonSchemaCompiler: OpenAi.toolJsonSchemaCompiler,
  }
  if (selection.registrationKey !== undefined)
    Object.assign(registration, { registrationKey: selection.registrationKey })
  return ModelRegistry.layer([ModelRegistry.registration(registration)]).pipe(
    Layer.provide(
      OpenAiClient.layer({ transformClient: transformClient(options, selection, reference, bearerCredential) }),
    ),
    Layer.provide(httpClientLayer(options)),
  )
}

const anthropicLayer = (
  options: ModelRegistryLayerOptions,
  selection: ModelRegistry.ModelSelection,
  reference: SecureCredentialReference,
  config: Anthropic.Config,
): Layer.Layer<ModelRegistry.ModelRegistry> => {
  const registration = {
    provider: selection.provider,
    model: selection.model,
    layer: Anthropic.layerModel({ model: selection.model, config }),
    classifyFailure: Anthropic.classifyFailure,
    toolJsonSchemaCompiler: Anthropic.toolJsonSchemaCompiler,
  }
  if (selection.registrationKey !== undefined)
    Object.assign(registration, { registrationKey: selection.registrationKey })
  return ModelRegistry.layer([ModelRegistry.registration(registration)]).pipe(
    Layer.provide(
      AnthropicClient.layer({ transformClient: transformClient(options, selection, reference, anthropicCredential) }),
    ),
    Layer.provide(httpClientLayer(options)),
  )
}

const openRouterLayer = (
  options: ModelRegistryLayerOptions,
  selection: ModelRegistry.ModelSelection,
  reference: SecureCredentialReference,
  config: OpenRouter.Config,
): Layer.Layer<ModelRegistry.ModelRegistry> => {
  const registration = {
    provider: selection.provider,
    model: selection.model,
    layer: OpenRouter.layerModel({ model: selection.model, config }),
    classifyFailure: OpenRouter.classifyFailure,
    toolJsonSchemaCompiler: OpenRouter.toolJsonSchemaCompiler(selection.model),
  }
  if (selection.registrationKey !== undefined)
    Object.assign(registration, { registrationKey: selection.registrationKey })
  return ModelRegistry.layer([ModelRegistry.registration(registration)]).pipe(
    Layer.provide(
      OpenRouterClient.layer({ transformClient: transformClient(options, selection, reference, bearerCredential) }),
    ),
    Layer.provide(httpClientLayer(options)),
  )
}

const registryLayer = (
  options: ModelRegistryLayerOptions,
): Effect.Effect<Layer.Layer<ModelRegistry.ModelRegistry>, ModelRegistryConfigurationError> =>
  Effect.gen(function* () {
    const selection = selectionFor(options.model)
    const reference = yield* credentialReferenceFor(options.model)
    switch (selection.provider) {
      case "openai": {
        const config = yield* OpenAiResponses.decodeConfig(openAiOptions(options.model)).pipe(
          Effect.mapError(() => configurationError("settings", "OpenAI model settings are invalid")),
        )
        return openAiLayer(options, selection, reference, config)
      }
      case "anthropic": {
        const config = yield* Anthropic.decodeConfig(anthropicOptions(options.model)).pipe(
          Effect.mapError(() => configurationError("settings", "Anthropic model settings are invalid")),
        )
        return anthropicLayer(options, selection, reference, config)
      }
      case "openrouter": {
        const config = yield* OpenRouter.decodeConfig(openRouterOptions(options.model)).pipe(
          Effect.mapError(() => configurationError("settings", "OpenRouter model settings are invalid")),
        )
        return openRouterLayer(options, selection, reference, config)
      }
      default:
        return yield* configurationError("provider", "The selected model provider is not supported")
    }
  })

export const modelRegistryLayer = (options: ModelRegistryLayerOptions) => Layer.unwrap(registryLayer(options))
