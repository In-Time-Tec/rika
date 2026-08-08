import { createHmac } from "node:crypto"
import { Effect, Layer } from "effect"
import { Sha256, type Sha256Shape } from "./server-service-sha256"

/** Node implementation: node:crypto createHmac. Also runs under Bun. */
export const Sha256Node: Sha256Shape = {
  hmac: (key, input) => Effect.sync(() => createHmac("sha256", key).update(input).digest("hex")),
}

export const Sha256NodeLayer: Layer.Layer<Sha256> = Layer.succeed(Sha256, Sha256Node)
