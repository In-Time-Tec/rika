import { Config } from "@rika/core"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import * as Modes from "./modes"
import * as Provider from "./provider"

export interface Request extends Schema.Schema.Type<typeof Request>, Provider.RuntimeOptions {}
export const Request = Schema.Struct({
  mode: Schema.optional(Modes.ModeName),
  profile: Schema.optional(Modes.ProfileName),
  provider: Schema.optional(Provider.ProviderName),
  model: Schema.optional(Provider.ModelId),
  messages: Schema.Array(Provider.Message),
  reasoning_effort: Schema.optional(Provider.ReasoningEffort),
  temperature: Schema.optional(Schema.Number),
  metadata: Schema.optional(Provider.Metadata),
  fast_mode: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "Rika.LLM.Router.Request" })

export interface RoutedRequest extends Schema.Schema.Type<typeof RoutedRequest>, Provider.RuntimeOptions {}
export const RoutedRequest = Schema.Struct({
  mode: Modes.ModeName,
  profile: Schema.optional(Modes.ProfileName),
  provider: Provider.ProviderName,
  model: Provider.ModelId,
  messages: Schema.Array(Provider.Message),
  reasoning_effort: Provider.ReasoningEffort,
  temperature: Schema.optional(Schema.Number),
  metadata: Schema.optional(Provider.Metadata),
  service_tier: Schema.optional(Provider.ServiceTier),
}).annotate({ identifier: "Rika.LLM.Router.RoutedRequest" })

export class RouterError extends Schema.TaggedErrorClass<RouterError>()("RouterError", {
  message: Schema.String,
  mode: Schema.optional(Modes.ModeName),
  profile: Schema.optional(Modes.ProfileName),
  provider: Schema.optional(Provider.ProviderName),
}) {}

export interface Interface {
  readonly route: (request: Request) => Effect.Effect<RoutedRequest, RouterError>
  readonly complete: (
    request: Request,
  ) => Effect.Effect<Provider.GenerateResponse, Provider.ProviderError | RouterError>
  readonly stream: (request: Request) => Stream.Stream<Provider.StreamEvent, Provider.ProviderError | RouterError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/llm/Router") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const registry = yield* Provider.Registry
    const route = makeRoute(config)

    return Service.of({
      route,
      complete: Effect.fn("LLM.Router.complete")(function* (request: Request) {
        const routed = yield* route(request)
        const provider = yield* providerFor(registry, routed)
        return yield* provider.complete(routed)
      }),
      stream: (request: Request) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const routed = yield* route(request)
            const provider = yield* providerFor(registry, routed)
            return provider.stream(routed)
          }),
        ),
    })
  }),
)

export const route = Effect.fn("LLM.Router.route.call")(function* (request: Request) {
  const router = yield* Service
  return yield* router.route(request)
})

export const complete = Effect.fn("LLM.Router.complete.call")(function* (request: Request) {
  const router = yield* Service
  return yield* router.complete(request)
})

export const stream = (request: Request) => Stream.unwrap(Effect.map(Service, (router) => router.stream(request)))

const makeRoute = (config: Config.Interface) =>
  Effect.fn("LLM.Router.route")(function* (request: Request) {
    const values = yield* config.get
    const modeName = request.mode ?? values.default_mode
    const routing = request.profile === undefined ? Modes.get(modeName) : Modes.getProfile(request.profile)
    const provider = request.provider ?? routing.provider
    const model = request.model ?? Modes.primaryModel(routing)
    const temperature = request.temperature ?? routing.temperature
    const metadata = request.metadata
    const serviceTier: Provider.ServiceTier | undefined =
      request.fast_mode === true && provider === "openai" ? "priority" : undefined

    return {
      mode: modeName,
      ...(request.profile === undefined ? {} : { profile: request.profile }),
      provider,
      model,
      messages: request.messages,
      reasoning_effort: request.reasoning_effort ?? routing.reasoning_effort,
      ...(temperature === undefined ? {} : { temperature }),
      ...(metadata === undefined ? {} : { metadata }),
      ...(serviceTier === undefined ? {} : { service_tier: serviceTier }),
      ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
      ...(request.toolkit === undefined ? {} : { toolkit: request.toolkit }),
    }
  })

const providerFor = (registry: Provider.RegistryInterface, request: RoutedRequest) => {
  const provider = registry.get(request.provider)
  if (provider !== undefined) return Effect.succeed(provider)
  return new RouterError({
    message: `Mode ${request.mode} routed to provider ${request.provider}, but no provider layer is registered`,
    mode: request.mode,
    ...(request.profile === undefined ? {} : { profile: request.profile }),
    provider: request.provider,
  })
}
