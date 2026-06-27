import { Config } from "@rika/core"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import * as Modes from "./modes"
import * as Provider from "./provider"

export interface Request extends Schema.Schema.Type<typeof Request> {}
export const Request = Schema.Struct({
  mode: Schema.optional(Modes.ModeName),
  provider: Schema.optional(Provider.ProviderName),
  model: Schema.optional(Provider.ModelId),
  messages: Schema.Array(Provider.Message),
  reasoning_effort: Schema.optional(Provider.ReasoningEffort),
  max_output_tokens: Schema.optional(Schema.Int),
  temperature: Schema.optional(Schema.Number),
  metadata: Schema.optional(Provider.Metadata),
}).annotate({ identifier: "Rika.LLM.Router.Request" })

export interface RoutedRequest extends Schema.Schema.Type<typeof RoutedRequest> {}
export const RoutedRequest = Schema.Struct({
  mode: Modes.ModeName,
  provider: Provider.ProviderName,
  model: Provider.ModelId,
  messages: Schema.Array(Provider.Message),
  reasoning_effort: Provider.ReasoningEffort,
  max_output_tokens: Schema.Int,
  temperature: Schema.optional(Schema.Number),
  metadata: Schema.optional(Provider.Metadata),
}).annotate({ identifier: "Rika.LLM.Router.RoutedRequest" })

export class RouterError extends Schema.TaggedErrorClass<RouterError>()("RouterError", {
  message: Schema.String,
  mode: Schema.optional(Modes.ModeName),
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
    const provider = yield* Provider.Service
    const route = makeRoute(config)

    return Service.of({
      route,
      complete: Effect.fn("LLM.Router.complete")(function* (request: Request) {
        const routed = yield* route(request)
        yield* ensureProvider(provider, routed)
        return yield* provider.complete(routed)
      }),
      stream: (request: Request) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const routed = yield* route(request)
            yield* ensureProvider(provider, routed)
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
    const mode = Modes.get(modeName)
    const provider = request.provider ?? mode.provider
    const model = request.model ?? Modes.primaryModel(mode)
    const temperature = request.temperature ?? mode.temperature
    const metadata = request.metadata

    return {
      mode: modeName,
      provider,
      model,
      messages: request.messages,
      reasoning_effort: request.reasoning_effort ?? mode.reasoning_effort,
      max_output_tokens: request.max_output_tokens ?? mode.max_output_tokens,
      ...(temperature === undefined ? {} : { temperature }),
      ...(metadata === undefined ? {} : { metadata }),
    }
  })

const ensureProvider = (provider: Provider.Interface, request: RoutedRequest) => {
  if (provider.name === request.provider) return Effect.void
  return new RouterError({
    message: `Mode ${request.mode} routed to provider ${request.provider}, but layer provides ${provider.name}`,
    mode: request.mode,
    provider: request.provider,
  })
}
