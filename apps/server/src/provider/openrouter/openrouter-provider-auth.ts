import * as BunServices from "@effect/platform-bun/BunServices"
import * as OpenRouterAuthService from "@rika/product/openrouter-auth-service"
import * as OpenRouterCredentialStore from "./openrouter-credential-store"
import { ProviderCredentialStore } from "@rika/product/provider-credential-store"
import { FetchHttpClient } from "effect/unstable/http"
import { Function, Layer } from "effect"

const { dirname, join } = process.getBuiltinModule("node:path")

const createLayerImpl = (database: string, profileIdentity: string) =>
  OpenRouterAuthService.layer.pipe(
    Layer.provide(
      OpenRouterCredentialStore.layer(join(dirname(database), "auth", profileIdentity, "openrouter.json"), {
        trustedRoot: dirname(database),
        ...(typeof process.getuid === "function" ? { currentUid: process.getuid() } : {}),
      }),
    ),
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
  OpenRouterCredentialStore.layer(join(dirname(database), "auth", profileIdentity, "openrouter.json"), {
    trustedRoot: dirname(database),
    ...(typeof process.getuid === "function" ? { currentUid: process.getuid() } : {}),
  }),
)
