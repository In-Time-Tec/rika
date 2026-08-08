import { Effect, Layer } from "effect"
import { Sha256, type Sha256Shape } from "./server-service-sha256"

const encoder = new TextEncoder()

const toHex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")

/** Web implementation: WebCrypto crypto.subtle HMAC-SHA256. */
export const Sha256Web: Sha256Shape = {
  hmac: (key, input) =>
    Effect.tryPromise(() => {
      const crypto = globalThis.crypto
      return crypto.subtle
        .importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
        .then((imported) => crypto.subtle.sign("HMAC", imported, encoder.encode(input)))
        .then((signature) => toHex(new Uint8Array(signature)))
    }).pipe(Effect.orDie),
}

export const Sha256WebLayer: Layer.Layer<Sha256> = Layer.succeed(Sha256, Sha256Web)
