import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as OpenAiAuthAdapter from "./openai-auth-adapter"
import * as OpenAiCredentialStore from "./openai-credential-store"
import { FetchHttpClient } from "effect/unstable/http"
import { Function, Layer } from "effect"

const { dirname, join } = process.getBuiltinModule("node:path")

const createLayerImpl = (database: string, profileIdentity: string) =>
  OpenAiAuthAdapter.layer.pipe(
    Layer.provide(
      OpenAiCredentialStore.layer(join(dirname(database), "auth", profileIdentity, "openai.json"), {
        trustedRoot: dirname(database),
        ...(typeof process.getuid === "function" ? { currentUid: process.getuid() } : {}),
      }),
    ),
    Layer.provide(Layer.mergeAll(BunServices.layer, BunCrypto.layer, FetchHttpClient.layer)),
  )

export const createLayer: {
  (profileIdentity: string): (database: string) => ReturnType<typeof createLayerImpl>
  (database: string, profileIdentity: string): ReturnType<typeof createLayerImpl>
} = Function.dual(2, createLayerImpl)

export const layer = createLayer
