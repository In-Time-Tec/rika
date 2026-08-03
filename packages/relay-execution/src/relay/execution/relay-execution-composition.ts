import { Registry, makeRegistry } from "./relay-thread-host-registry"
import { hostRegistration } from "./relay-thread-host"
import { defaultRecoveryChildSettlementGrace } from "./relay-recovery-policy"
import { error } from "./relay-event-payload"
import { eventHistoryOption } from "../../model/routing/relay-model-registry"
import { Client, ArtifactStore, Ids, PromptAssembler, Runtime } from "@relayfx/sdk"
import { Context, Crypto, Deferred, Duration, Effect, Layer, PlatformError } from "effect"
import { Tool } from "effect/unstable/ai"
import { BackendError } from "@rika/product/execution-service"
import * as DataBlobStore from "../../data-blob-store"
import { Service as ExecutionService } from "@rika/product/execution-service"
import type { Service as ExecutionServiceType } from "@rika/product/execution-service"
import type { ToolRuntimeRequirements, ExternalToolRuntimeRequirements, LayerOptions } from "./relay-execution-layer"
import { makeDelegationLayer } from "./relay-execution-delegation-layer"
import { makePromptAssemblerLayer } from "./relay-execution-prompt-layer"
import { registerModel, registrationsFor, zeroPriceFromMetadata } from "./relay-execution-routing"
import * as ClientLayer from "./relay-execution-client-layer"
import { makeToolComposition } from "./relay-tool-composition"
import { buildModelContext, makeModelRuntimeComposition, providerToolRegistration } from "./relay-runtime-composition"
import { makeHostRuntime } from "./relay-host-composition"
const addressId = Ids.AddressId.make("address:rika")
type Service = ExecutionServiceType
const Service = ExecutionService
export const makeRelayLayer = <
  AdditionalTools extends Record<string, Tool.Any> = {},
  RuntimeRequirements extends ToolRuntimeRequirements = never,
>(
  options: LayerOptions<AdditionalTools, RuntimeRequirements>,
): Layer.Layer<
  Service,
  BackendError | PlatformError.PlatformError | Runtime.AcquisitionError,
  Crypto.Crypto | ExternalToolRuntimeRequirements<RuntimeRequirements>
> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const sqliteModule = yield* Effect.tryPromise({
        try: () => import("@relayfx/sdk/sqlite"),
        catch: error,
      })
      const promoterRegistry = yield* makeRegistry
      const promoterRegistryLayer = Layer.succeed(Registry, promoterRegistry)
      const relayClient = yield* Deferred.make<Client.Interface>()
      const recoveryScope = yield* Effect.scope
      const recoveryChildSettlementGrace = Duration.fromInputUnsafe(
        options.recoveryChildSettlementGrace ?? defaultRecoveryChildSettlementGrace,
      )
      if (!Duration.isFinite(recoveryChildSettlementGrace) || Duration.toMillis(recoveryChildSettlementGrace) < 0)
        return yield* BackendError.make({ message: "Recovery child settlement grace must be finite and non-negative" })
      {
        const { SQLite } = sqliteModule
        {
          const defaultPromptAssembler = Context.get(
            yield* Layer.build(
              PromptAssembler.defaultLayerWithStores.pipe(
                Layer.provide(Layer.merge(DataBlobStore.layer, ArtifactStore.passthroughLayer)),
              ),
            ),
            PromptAssembler.Service,
          )
          const promptAssemblerLayer = makePromptAssemblerLayer({
            relayClient,
            recoveryScope,
            childSettlementGrace: recoveryChildSettlementGrace,
            defaultPromptAssembler,
          })
          const delegationLayers = makeDelegationLayer({
            relayClient,
            options,
            promoterRegistry,
            addressId,
          })
          const { toolkit, runnerToolkit, handlerLayer } = delegationLayers
          const providerRegistration = (registration: import("@batonfx/core").ModelRegistry.Registration) =>
            providerToolRegistration(registration, toolkit)
          const initialRegistrations = [...registrationsFor(options), yield* hostRegistration].map(providerRegistration)
          const relayModelContext = yield* buildModelContext(initialRegistrations)
          const { languageModelLayer, sharedModelRegistryLayer, rikaToolRuntimeLayer, modelRegistry } =
            makeModelRuntimeComposition({
              options,
              relayModelContext,
            })
          const toolRuntimeLayer = makeToolComposition({
            relayClient,
            options,
            runnerToolkit,
            handlerLayer,
            rikaToolRuntimeLayer,
            sharedModelRegistryLayer,
          })
          const runtimeLayer = makeHostRuntime({
            options,
            relayClient,
            addressId,
            toolkit,
            languageModelLayer,
            toolRuntimeLayer,
            promptAssemblerLayer,
            database: SQLite.database({ filename: options.filename, ...eventHistoryOption(options.filename) }),
          })
          return ClientLayer.layerFromClient({
            ...options,
            onClientReady: (client) => Deferred.complete(relayClient, Effect.succeed(client)).pipe(Effect.asVoid),
            attemptCost: zeroPriceFromMetadata(options.registration.metadata),
            registerModels: (registrations) =>
              Effect.forEach(
                registrations,
                (registration) =>
                  registerModel(modelRegistry, providerRegistration(registration), options.modelResilience),
                { discard: true },
              ),
          }).pipe(Layer.provide(runtimeLayer), Layer.provide(promoterRegistryLayer))
        }
      }
    }),
  )
