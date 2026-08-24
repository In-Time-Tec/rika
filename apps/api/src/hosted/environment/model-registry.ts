import type { ModeId } from "@rika/configuration/behavior-mode"
import type { ModelRoute } from "@rika/configuration/model-route"
import { Defaults, type ConfigurationSettings } from "@rika/configuration/configuration-settings"
import * as ExecutionRouteResolution from "@rika/product/execution-route-resolution"
import type { ExecutionRouteModelSnapshot, ExecutionRouteSnapshot } from "@rika/product/execution-route-snapshot"
import { Context, Effect, Layer, Schema } from "effect"
import {
  HostedModelProvider,
  HostedProviderCredentialError,
  HostedProviderCredentials,
} from "./provider-credentials"

export class HostedModelRegistryError extends Schema.TaggedError<HostedModelRegistryError>()(
  "HostedModelRegistryError",
  {
    kind: Schema.Literals(["invalid", "missing", "revoked", "unavailable"]),
    message: Schema.String,
  },
) {}

export interface HostedModelRegistryService {
  readonly modes: ReadonlyArray<string>
  readonly resolve: (ownerId: string, mode?: string) => Effect.Effect<ExecutionRouteSnapshot, HostedModelRegistryError>
}

export class HostedModelRegistry extends Context.Service<HostedModelRegistry, HostedModelRegistryService>()(
  "@rika/api/hosted/environment/model-registry/HostedModelRegistry",
) {}

const invalid = () => HostedModelRegistryError.make({ kind: "invalid", message: "Model route is unavailable" })
const credentialFailure = (error: HostedProviderCredentialError) => {
  if (error.kind === "missing") {
    return HostedModelRegistryError.make({
      kind: "missing",
      message: "Required model provider credential is not configured",
    })
  }
  if (error.kind === "revoked") {
    return HostedModelRegistryError.make({
      kind: "revoked",
      message: "Required model provider credential is revoked",
    })
  }
  return HostedModelRegistryError.make({ kind: "unavailable", message: "Model registry is unavailable" })
}

const modelSnapshots = (route: ExecutionRouteSnapshot): ReadonlyArray<ExecutionRouteModelSnapshot> => [
  route.main,
  route.oracle,
  route.title,
  route.compactionSummary,
  ...Object.values(route.agents ?? {}),
]

const providers = (route: ExecutionRouteSnapshot): ReadonlyArray<HostedModelProvider> => [
  ...new Set(
    modelSnapshots(route).flatMap((model) =>
      model.candidates.map((candidate) => candidate.providerConnection.provider).filter(Schema.is(HostedModelProvider)),
    ),
  ),
]

const hostedSettings: ConfigurationSettings = {
  ...Defaults.settingsDefaults,
  models: Object.fromEntries(
    Object.entries(Defaults.settingsDefaults.models).map(([alias, model]) => [
      alias,
      {
        ...model,
        provider: "openrouter",
        candidates: model.candidates.map((candidate) => `${model.provider}/${candidate}`),
      },
    ]),
  ),
}

const settingsWithCredentials = (credentials: ReadonlyMap<HostedModelProvider, string>): ConfigurationSettings => ({
  ...hostedSettings,
  providers: Object.fromEntries(
    Object.entries(hostedSettings.providers).map(([provider, connection]) => {
      const credentialIdentity = credentials.get(provider as HostedModelProvider)
      return [
        provider,
        connection.protocol === "amazon-bedrock" || credentialIdentity === undefined
          ? connection
          : { ...connection, credentialIdentity },
      ]
    }),
  ) as Readonly<Record<ModelRoute.ProviderId, ModelRoute.ProviderConnection>>,
})

export const layer = Layer.effect(
  HostedModelRegistry,
  Effect.gen(function* () {
    const credentials = yield* HostedProviderCredentials
    const resolve = Effect.fn("HostedModelRegistry.resolve")(function* (ownerId: string, requestedMode?: string) {
      const mode = (requestedMode ?? hostedSettings.defaultMode) as ModeId
      const preliminary = yield* Effect.try({
        try: () => ExecutionRouteResolution.resolve(hostedSettings, mode),
        catch: invalid,
      })
      const requiredProviders = providers(preliminary)
      if (
        modelSnapshots(preliminary).some((model) =>
          model.candidates.some((candidate) => !Schema.is(HostedModelProvider)(candidate.providerConnection.provider)),
        )
      ) {
        return yield* invalid()
      }
      const identities = new Map<HostedModelProvider, string>()
      yield* Effect.forEach(requiredProviders, (provider) =>
        credentials.require(ownerId, provider).pipe(
          Effect.tap((status) => Effect.sync(() => identities.set(provider, status.credentialIdentity))),
          Effect.mapError(credentialFailure),
        ),
      )
      return yield* Effect.try({
        try: () => ExecutionRouteResolution.resolve(settingsWithCredentials(identities), mode),
        catch: invalid,
      })
    })
    return HostedModelRegistry.of({ modes: Object.keys(hostedSettings.modes), resolve })
  }),
)

export const testLayer = Layer.succeed(
  HostedModelRegistry,
  HostedModelRegistry.of({
    modes: Object.keys(hostedSettings.modes),
    resolve: (_ownerId, mode) =>
      Effect.try({
        try: () => ExecutionRouteResolution.resolve(hostedSettings, mode ?? hostedSettings.defaultMode),
        catch: invalid,
      }),
  }),
)
