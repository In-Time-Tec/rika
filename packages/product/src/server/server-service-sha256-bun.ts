import { Effect, Layer } from "effect"
import { Sha256, type Sha256Shape } from "./server-service-sha256"

/** Bun implementation: Bun.CryptoHasher with a secret key is HMAC-SHA256. */
export const Sha256Bun: Sha256Shape = {
  hmac: (key, input) => Effect.sync(() => new Bun.CryptoHasher("sha256", key).update(input).digest("hex")),
}

export const Sha256BunLayer: Layer.Layer<Sha256> = Layer.succeed(Sha256, Sha256Bun)
