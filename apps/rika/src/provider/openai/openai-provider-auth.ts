import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as OpenAiAuth from "@rika/product/openai-auth-service"
import * as OpenAiAuthAdapter from "./openai-auth-adapter"
import { FetchHttpClient } from "effect/unstable/http"
import { Layer } from "effect"

export const layer = OpenAiAuthAdapter.layer.pipe(
  Layer.provide(OpenAiAuth.memoryStoreLayer),
  Layer.provide(Layer.mergeAll(BunServices.layer, BunCrypto.layer, FetchHttpClient.layer)),
)
