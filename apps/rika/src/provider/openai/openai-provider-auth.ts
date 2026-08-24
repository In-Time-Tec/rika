import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as OpenAiAuthAdapter from "./openai-auth-adapter"
import * as OpenAiCredentialStore from "./openai-credential-store"
import { FetchHttpClient } from "effect/unstable/http"
import { Effect, Function, Layer, Path } from "effect"

const createLayerImpl = (database: string, profileIdentity: string) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const path = yield* Path.Path
      const trustedRoot = path.dirname(database)
      return yield* Layer.build(
        OpenAiAuthAdapter.layer.pipe(
          Layer.provide(
            OpenAiCredentialStore.layer(path.join(trustedRoot, "auth", profileIdentity, "openai.json"), {
              trustedRoot,
              ...(typeof process.getuid === "function" ? { currentUid: process.getuid() } : {}),
            }),
          ),
        ),
      )
    }),
  ).pipe(
    Layer.provide(Layer.mergeAll(BunServices.layer, BunCrypto.layer, FetchHttpClient.layer)),
  )

export const createLayer: {
  (profileIdentity: string): (database: string) => ReturnType<typeof createLayerImpl>
  (database: string, profileIdentity: string): ReturnType<typeof createLayerImpl>
} = Function.dual(2, createLayerImpl)

export const layer = createLayer
