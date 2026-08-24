import * as BunServices from "@effect/platform-bun/BunServices"
import * as OpenRouterAuthService from "@rika/product/openrouter-auth-service"
import * as OpenRouterCredentialStore from "./credential-store"
import { ProviderCredentialStore } from "@rika/product/provider-credential-store"
import { FetchHttpClient } from "effect/unstable/http"
import { Effect, Function, Layer, Path } from "effect"

const credentialLayer = (database: string, profileIdentity: string) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const path = yield* Path.Path
      const trustedRoot = path.dirname(database)
      return yield* Layer.build(
        OpenRouterCredentialStore.layer(path.join(trustedRoot, "auth", profileIdentity, "openrouter.json"), {
          trustedRoot,
          ...(typeof process.getuid === "function" ? { currentUid: process.getuid() } : {}),
        }),
      )
    }),
  )

const createLayerImpl = (database: string, profileIdentity: string) =>
  OpenRouterAuthService.layer.pipe(
    Layer.provide(credentialLayer(database, profileIdentity)),
    Layer.provide(BunServices.layer),
    Layer.provide(FetchHttpClient.layer),
  )

export const createLayer: {
  (profileIdentity: string): (database: string) => ReturnType<typeof createLayerImpl>
  (database: string, profileIdentity: string): ReturnType<typeof createLayerImpl>
} = Function.dual(2, createLayerImpl)

export const layer = createLayer

export const credentialStoreLayer: {
  (profileIdentity: string): (database: string) => Layer.Layer<ProviderCredentialStore, never, never>
  (database: string, profileIdentity: string): Layer.Layer<ProviderCredentialStore, never, never>
} = Function.dual(2, (database: string, profileIdentity: string) =>
  credentialLayer(database, profileIdentity).pipe(Layer.provide(BunServices.layer)),
)
