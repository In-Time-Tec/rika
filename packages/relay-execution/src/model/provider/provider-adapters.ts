import {
  isNativeOpenAiRoute,
  normalizedBaseUrl,
  RuntimeError,
  type ProviderRuntimePin,
  type RuntimeModelRoute,
} from "./model-provider-route"
import * as ModelRoute from "@rika/configuration/model-route"
import * as ModelRouteResolution from "@rika/configuration/model-route-resolution"
import * as SettingsDefaults from "@rika/configuration/configuration-settings"
import * as PromptCache from "../../prompt-cache"
import { withStreamingOnlyModel } from "../../streaming-only-model"
import { ModelRegistry } from "@batonfx/core"
import * as Anthropic from "@batonfx/providers/anthropic"
import * as AmazonBedrock from "@batonfx/providers/amazon-bedrock"
import * as OpenAi from "@batonfx/providers/openai"
import { OpenAiAccountCredentialError, type OpenAiAccountCredentials } from "@batonfx/providers/openai"
import * as OpenAiAuth from "@rika/product/openai-auth-service"
import * as OpenAiAuthContract from "@rika/product/openai-auth-contract"
import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http"
import { createHash } from "node:crypto"

interface Resolution {
  readonly runtime: ProviderRuntimePin
  readonly options: Readonly<Record<string, unknown>>
  readonly registrationKey: string
}
interface Account {
  readonly fingerprint: string
  readonly auth: OpenAiAuth.ServiceInterface
}
export interface Adapter {
  readonly id: string
  readonly matchesConfigured: (route: ModelRouteResolution.ResolvedModelRoute, account?: Account) => boolean
  readonly matchesPinned: (route: RuntimeModelRoute) => boolean
  readonly resolve: (route: ModelRouteResolution.ResolvedModelRoute, account?: Account) => ProviderRuntimePin
  readonly options: (route: ModelRouteResolution.ResolvedModelRoute) => Readonly<Record<string, unknown>>
  readonly register: (
    route: ModelRouteResolution.ResolvedModelRoute,
    resolution: Resolution,
    account?: Account,
  ) => Effect.Effect<ModelRegistry.Registration, RuntimeError, import("effect").Scope.Scope>
  readonly restore: (
    route: RuntimeModelRoute,
    runtime: ProviderRuntimePin,
  ) => Effect.Effect<ModelRegistry.Registration, RuntimeError, import("effect").Scope.Scope>
}

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`
}

const sanitizeChatCompletion = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) return value
  const record = value as Record<string, unknown>
  if (Array.isArray(record.choices))
    for (const choice of record.choices as Array<Record<string, unknown>>) {
      const message = choice.message as Record<string, unknown> | undefined
      if (message?.tool_calls === null) delete message.tool_calls
      if (message !== undefined && message.content === undefined) message.content = null
    }
  return value
}

const sanitizedFetchLayer = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    return HttpClient.transformResponse(client, (effect) =>
      Effect.flatMap(effect, (response) => {
        const contentType = String(response.headers["content-type"] ?? "")
        if (!contentType.includes("application/json")) return Effect.succeed(response)
        return response.text.pipe(
          Effect.map((text) => {
            const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text)
            if (Option.isNone(decoded)) return response
            return HttpClientResponse.fromWeb(
              response.request,
              new Response(Schema.encodeSync(Schema.UnknownFromJsonString)(sanitizeChatCompletion(decoded.value)), {
                status: response.status,
                headers: { "content-type": contentType },
              }),
            )
          }),
          Effect.orElseSucceed(() => response),
        )
      }),
    )
  }),
).pipe(Layer.provide(FetchHttpClient.layer))

const provideScoped = <A, E, R, RO, LE, RI>(effect: Effect.Effect<A, E, R>, layer: Layer.Layer<RO, LE, RI>) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const parent = yield* Effect.context<RI | Exclude<R, RO>>()
    const provided = yield* Layer.buildWithScope(layer, scope)
    return yield* effect.pipe(Effect.provideContext(Context.merge(parent, provided)))
  })

const credential = (
  name: string | undefined,
  provider: string,
): Effect.Effect<Redacted.Redacted<string> | undefined, RuntimeError> =>
  name === undefined
    ? Effect.void.pipe(Effect.as(undefined as Redacted.Redacted<string> | undefined))
    : Config.option(Config.redacted(name)).pipe(
        Effect.flatMap((value) =>
          Option.match(value, {
            onNone: () =>
              Effect.fail(
                RuntimeError.make({ message: `Missing environment variable ${name} for provider ${provider}` }),
              ),
            onSome: Effect.succeed,
          }),
        ),
        Effect.mapError(() =>
          RuntimeError.make({ message: `Missing environment variable ${name} for provider ${provider}` }),
        ),
      )

const batonCredentials = (auth: OpenAiAuth.ServiceInterface, fingerprint: string): OpenAiAccountCredentials => {
  const adapt = (
    operation: "acquire" | "refreshRejected",
    effect: Effect.Effect<OpenAiAuthContract.Credential, OpenAiAuthContract.AuthError | OpenAiAuthContract.StoreError>,
  ) =>
    effect.pipe(
      Effect.filterOrFail(
        (value) => value.fingerprint === fingerprint,
        () => OpenAiAccountCredentialError.make({ operation }),
      ),
      Effect.map((value) => ({
        accessToken: value.accessToken,
        accountId: Redacted.value(value.accountId),
        generation: value.generation,
      })),
      Effect.mapError(() => OpenAiAccountCredentialError.make({ operation })),
    )
  return {
    acquire: adapt("acquire", auth.acquire),
    refreshRejected: (generation) => adapt("refreshRejected", auth.refreshRejected(generation)),
  }
}

const streamingOnlyRegistration =
  (streamingOnly: boolean) =>
  (registration: ModelRegistry.Registration): ModelRegistry.Registration =>
    streamingOnly ? withStreamingOnlyModel(registration) : registration

export const routeAcceptsPromptCacheRetention = (route: ModelRouteResolution.ResolvedModelRoute): boolean =>
  route.providerConnection.promptCaching ?? isNativeOpenAiRoute(route)

const routeStreamingOnly = (route: ModelRouteResolution.ResolvedModelRoute): boolean =>
  route.providerConnection.protocol !== "amazon-bedrock" &&
  (route.providerConnection.streamingOnly ?? ModelRoute.isStreamingOnlyBaseUrl(route.providerConnection.baseUrl))

const bedrockOptions = (route: ModelRouteResolution.ResolvedModelRoute) => {
  const {
    output_config,
    additionalModelRequestFields,
    max_output_tokens: _,
    max_tokens: __,
    ...options
  } = route.options
  return {
    ...options,
    maxTokens: route.maxOutputTokens,
    ...(output_config === undefined && additionalModelRequestFields === undefined
      ? {}
      : {
          additionalModelRequestFields: {
            ...(typeof additionalModelRequestFields === "object" && additionalModelRequestFields !== null
              ? additionalModelRequestFields
              : {}),
            ...(output_config === undefined ? {} : { output_config }),
          },
        }),
  }
}

const authRefreshFingerprint = (command: ModelRoute.ModelRoute.BedrockAuthRefresh) =>
  `sha256:${createHash("sha256")
    .update(canonical([command.command, ...command.args]))
    .digest("hex")}`

const registerBedrock = (
  route: ModelRouteResolution.ResolvedModelRoute,
  resolution: Resolution,
  recovery?: AmazonBedrock.Recovery,
) => {
  const connection = route.providerConnection
  if (connection.protocol !== "amazon-bedrock")
    return Effect.fail(RuntimeError.make({ message: "Invalid Amazon Bedrock connection" }))
  return provideScoped(
    ModelRegistry.registrations().pipe(
      Effect.map((items) => ({ ...PromptCache.withPromptCaching(items[0]!), provider: route.providerId })),
    ),
    AmazonBedrock.layer({
      model: route.model,
      registrationKey: resolution.registrationKey,
      config: resolution.options as AmazonBedrock.Config,
      client: {
        ...(connection.region === undefined ? {} : { region: connection.region }),
        ...(connection.profile === undefined ? {} : { profile: connection.profile }),
        ...(connection.endpoint === undefined ? {} : { endpoint: connection.endpoint }),
        authMode: connection.authMode,
        ...(recovery === undefined ? {} : { recovery }),
      },
    }),
  ).pipe(Effect.mapError(() => RuntimeError.make({ message: "Amazon Bedrock provider registration failed" })))
}

const registerOpenAi = (route: ModelRouteResolution.ResolvedModelRoute, resolution: Resolution) =>
  credential(route.providerConnection.apiKeyEnv, route.providerId).pipe(
    Effect.flatMap((apiKey) =>
      provideScoped(
        ModelRegistry.registrations().pipe(
          Effect.map((items) => streamingOnlyRegistration(routeStreamingOnly(route))(items[0]!)),
        ),
        OpenAi.layer({
          model: route.model,
          registrationKey: resolution.registrationKey,
          config: resolution.options as NonNullable<Parameters<typeof OpenAi.layer>[0]["config"]>,
          apiKey: Config.succeed(apiKey!),
          clientConfig: { apiUrl: Config.succeed(route.providerConnection.baseUrl!) },
        }).pipe(Layer.provide(sanitizedFetchLayer), Layer.orDie),
      ),
    ),
    Effect.mapError((error) =>
      Schema.is(RuntimeError)(error) ? error : RuntimeError.make({ message: String(error) }),
    ),
  )

const registerAnthropic = (route: ModelRouteResolution.ResolvedModelRoute, resolution: Resolution) =>
  credential(route.providerConnection.apiKeyEnv, route.providerId).pipe(
    Effect.flatMap((apiKey) =>
      provideScoped(
        ModelRegistry.registrations().pipe(
          Effect.map((items) =>
            streamingOnlyRegistration(routeStreamingOnly(route))(PromptCache.withPromptCaching(items[0]!)),
          ),
        ),
        Anthropic.layer({
          model: route.model,
          registrationKey: resolution.registrationKey,
          config: resolution.options as NonNullable<Parameters<typeof Anthropic.layer>[0]["config"]>,
          apiKey: Config.succeed(apiKey!),
          clientConfig: { apiUrl: Config.succeed(route.providerConnection.baseUrl!) },
        }).pipe(Layer.provide(sanitizedFetchLayer), Layer.orDie),
      ),
    ),
    Effect.mapError((error) =>
      Schema.is(RuntimeError)(error) ? error : RuntimeError.make({ message: String(error) }),
    ),
  )

const unavailableRestore = (route: RuntimeModelRoute) =>
  Effect.fail(RuntimeError.make({ message: `Pinned provider adapter for ${route.provider} is unavailable` }))

const configuredFromPin = (
  route: RuntimeModelRoute,
  runtime: ProviderRuntimePin,
): ModelRouteResolution.ResolvedModelRoute => ({
  alias: route.alias,
  displayName: route.alias,
  effort: route.effort as ModelRoute.ModelRoute.Effort,
  fast: route.fast,
  providerId: route.provider as ModelRoute.ModelRoute.ProviderId,
  providerConnection:
    route.providerProtocol === "amazon-bedrock"
      ? {
          protocol: "amazon-bedrock",
          authMode: runtime.connectionIdentity?.authMode === "bearer" ? "bearer" : "default",
          ...(runtime.connectionIdentity?.region === undefined ? {} : { region: runtime.connectionIdentity.region }),
          ...(runtime.connectionIdentity?.profile === undefined ? {} : { profile: runtime.connectionIdentity.profile }),
          ...(runtime.connectionIdentity?.endpoint === undefined
            ? {}
            : { endpoint: runtime.connectionIdentity.endpoint }),
        }
      : {
          protocol: route.providerProtocol as "openai" | "anthropic",
          baseUrl: route.providerBaseUrl,
          ...(runtime.credentialIdentity === undefined ? {} : { apiKeyEnv: runtime.credentialIdentity }),
        },
  candidates: [route.model],
  model: route.model,
  compaction: route.compaction,
  maxOutputTokens: Number(
    (route.providerOptions ?? {}).max_output_tokens ??
      (route.providerOptions ?? {}).max_tokens ??
      route.compaction.reserveTokens,
  ),
  options: route.providerOptions ?? {},
})

const adapters = (
  auth: OpenAiAuth.ServiceInterface,
  bedrockRecovery: (runtime: ProviderRuntimePin) => AmazonBedrock.Recovery | undefined = () => undefined,
): ReadonlyArray<Adapter> => [
  {
    id: "amazon-bedrock",
    matchesConfigured: (route) => route.providerConnection.protocol === "amazon-bedrock",
    matchesPinned: (route) =>
      route.providerRuntime?.adapter === "amazon-bedrock" && route.providerProtocol === "amazon-bedrock",
    resolve: (route) => {
      const connection = route.providerConnection
      if (connection.protocol !== "amazon-bedrock") return { adapter: "amazon-bedrock" }
      const fingerprint =
        connection.authRefresh === undefined ? undefined : authRefreshFingerprint(connection.authRefresh)
      return {
        adapter: "amazon-bedrock",
        connectionIdentity: {
          authMode: connection.authMode,
          ...(connection.region === undefined ? {} : { region: connection.region }),
          ...(connection.profile === undefined ? {} : { profile: connection.profile }),
          ...(connection.endpoint === undefined ? {} : { endpoint: connection.endpoint }),
          ...(fingerprint === undefined ? {} : { authRefreshFingerprint: fingerprint }),
        },
      }
    },
    options: bedrockOptions,
    register: (route, resolution) => registerBedrock(route, resolution, bedrockRecovery(resolution.runtime)),
    restore: (route, runtime) =>
      registerBedrock(
        configuredFromPin(route, runtime),
        {
          runtime,
          registrationKey: route.registrationKey,
          options: route.providerOptions ?? {},
        },
        bedrockRecovery(runtime),
      ),
  },
  {
    id: "openai-account",
    matchesConfigured: (route, account) => account !== undefined && isNativeOpenAiRoute(route),
    matchesPinned: (route) =>
      route.providerRuntime?.adapter === "openai-account" || route.openAiAccountFingerprint !== undefined,
    resolve: (_route, account) => ({ adapter: "openai-account", credentialIdentity: account!.fingerprint }),
    options: (route) => {
      const { max_output_tokens: _, ...options } = route.options
      return { ...options, store: false }
    },
    register: (route, resolution, account) =>
      provideScoped(
        ModelRegistry.registrations().pipe(Effect.map((items) => withStreamingOnlyModel(items[0]!))),
        OpenAi.layerAccount({
          model: route.model,
          registrationKey: resolution.registrationKey,
          credentials: batonCredentials(account!.auth, account!.fingerprint),
          config: resolution.options as NonNullable<Parameters<typeof OpenAi.layerAccount>[0]["config"]>,
        }).pipe(Layer.provide(sanitizedFetchLayer)),
      ).pipe(Effect.mapError((error) => RuntimeError.make({ message: String(error) }))),
    restore: (route, runtime) =>
      runtime.credentialIdentity === undefined ||
      route.provider !== "openai" ||
      route.providerProtocol !== "openai" ||
      normalizedBaseUrl(route.providerBaseUrl) !==
        normalizedBaseUrl(SettingsDefaults.Defaults.defaults.providers.openai!.baseUrl!)
        ? unavailableRestore(route)
        : provideScoped(
            ModelRegistry.registrations().pipe(Effect.map((items) => withStreamingOnlyModel(items[0]!))),
            OpenAi.layerAccount({
              model: route.model,
              registrationKey: route.registrationKey,
              credentials: batonCredentials(auth, runtime.credentialIdentity),
              config: {
                ...Object.fromEntries(
                  Object.entries(route.providerOptions ?? {}).filter(([name]) => name !== "max_output_tokens"),
                ),
                store: false,
              } as NonNullable<Parameters<typeof OpenAi.layerAccount>[0]["config"]>,
            }).pipe(Layer.provide(sanitizedFetchLayer)),
          ).pipe(Effect.mapError((error) => RuntimeError.make({ message: String(error) }))),
  },
  {
    id: "openai",
    matchesConfigured: (route) => route.providerConnection.protocol === "openai",
    matchesPinned: (route) =>
      route.providerRuntime?.adapter === "openai" ||
      (route.providerRuntime === undefined &&
        route.openAiAccountFingerprint === undefined &&
        route.providerProtocol === "openai"),
    resolve: (route) => ({
      adapter: "openai",
      ...(route.providerConnection.apiKeyEnv === undefined
        ? {}
        : { credentialIdentity: route.providerConnection.apiKeyEnv }),
    }),
    options: (route) => ({
      ...route.options,
      max_output_tokens: route.maxOutputTokens,
      ...(routeAcceptsPromptCacheRetention(route) ? { prompt_cache_retention: "24h" } : {}),
    }),
    register: registerOpenAi,
    restore: (route, runtime) =>
      registerOpenAi(configuredFromPin(route, runtime), {
        runtime,
        registrationKey: route.registrationKey,
        options: route.providerOptions ?? {},
      }),
  },
  {
    id: "anthropic",
    matchesConfigured: (route) => route.providerConnection.protocol === "anthropic",
    matchesPinned: (route) =>
      route.providerRuntime?.adapter === "anthropic" ||
      (route.providerRuntime === undefined && route.providerProtocol === "anthropic"),
    resolve: (route) => ({
      adapter: "anthropic",
      ...(route.providerConnection.apiKeyEnv === undefined
        ? {}
        : { credentialIdentity: route.providerConnection.apiKeyEnv }),
    }),
    options: (route) => ({ ...route.options, max_tokens: route.maxOutputTokens }),
    register: registerAnthropic,
    restore: (route, runtime) =>
      registerAnthropic(configuredFromPin(route, runtime), {
        runtime,
        registrationKey: route.registrationKey,
        options: route.providerOptions ?? {},
      }),
  },
]

export const normalizePinnedRuntime = (route: RuntimeModelRoute): ProviderRuntimePin =>
  route.providerRuntime ??
  (route.openAiAccountFingerprint !== undefined
    ? { adapter: "openai-account", credentialIdentity: route.openAiAccountFingerprint }
    : {
        adapter: route.providerProtocol,
        ...(route.providerApiKeyEnv === undefined ? {} : { credentialIdentity: route.providerApiKeyEnv }),
      })

export const ProviderAdapters = {
  adapters,
  authRefreshFingerprint,
  canonical,
  normalizePinnedRuntime,
  unavailableRestore,
}
