import * as Webhook from "./event"
import { Context, Effect, Layer, Redacted, Schema } from "effect"

const Signature = Schema.String.check(Schema.isPattern(/^sha256=[0-9a-f]{64}$/))

export const WebhookHeaders = Schema.Struct({
  signature256: Signature,
  eventName: Webhook.WebhookEventName,
  deliveryId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9-]{1,128}$/)),
})
export type WebhookHeaders = typeof WebhookHeaders.Type

export class WebhookVerificationError extends Schema.TaggedError<WebhookVerificationError>()(
  "GitHubWebhookVerificationError",
  {
    reason: Schema.Literals(["headers", "signature", "crypto", "event"]),
    message: Schema.String,
  },
) {}

export interface WebhookCryptoService {
  readonly hmacSha256: (
    secret: Redacted.Redacted<string>,
    body: Uint8Array,
  ) => Effect.Effect<Uint8Array, WebhookVerificationError>
  readonly constantTimeEqual: (left: Uint8Array, right: Uint8Array) => Effect.Effect<boolean>
}

export class WebhookCrypto extends Context.Service<WebhookCrypto, WebhookCryptoService>()(
  "@rika/github-app/webhook/verifier/WebhookCrypto",
) {}

const cryptoFailure = () =>
  WebhookVerificationError.make({ reason: "crypto", message: "GitHub webhook verification failed" })

export const webCryptoLayer = Layer.succeed(
  WebhookCrypto,
  WebhookCrypto.of({
    hmacSha256: Effect.fn("GitHubWebhookCrypto.hmacSha256")(function* (secret, body) {
      const key = yield* Effect.tryPromise({
        try: () =>
          globalThis.crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(Redacted.value(secret)),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"],
          ),
        catch: cryptoFailure,
      })
      const signature = yield* Effect.tryPromise({
        try: () => globalThis.crypto.subtle.sign("HMAC", key, body),
        catch: cryptoFailure,
      })
      return new Uint8Array(signature)
    }),
    constantTimeEqual: (left, right) =>
      Effect.sync(() => {
        const length = Math.max(left.length, right.length)
        let difference = left.length ^ right.length
        for (let index = 0; index < length; index += 1) {
          difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
        }
        return difference === 0
      }),
  }),
)

export interface VerifiedWebhook {
  readonly deliveryId: string
  readonly event: Webhook.WebhookEvent
}

export interface WebhookVerifierService {
  readonly verify: (
    headers: WebhookHeaders,
    rawBody: Uint8Array,
  ) => Effect.Effect<VerifiedWebhook, WebhookVerificationError>
}

export class WebhookVerifier extends Context.Service<WebhookVerifier, WebhookVerifierService>()(
  "@rika/github-app/webhook/verifier/WebhookVerifier",
) {}

export interface WebhookVerifierOptions {
  readonly secret: Redacted.Redacted<string>
}

export const webhookVerifierLayer = (options: WebhookVerifierOptions) =>
  Layer.effect(
    WebhookVerifier,
    Effect.gen(function* () {
      const crypto = yield* WebhookCrypto
      const verify = Effect.fn("GitHubWebhookVerifier.verify")(function* (
        untrustedHeaders: WebhookHeaders,
        untrustedRawBody: Uint8Array,
      ) {
        const headers = yield* Schema.decodeUnknownEffect(WebhookHeaders)(untrustedHeaders).pipe(
          Effect.mapError(() =>
            WebhookVerificationError.make({ reason: "headers", message: "GitHub webhook headers are invalid" }),
          ),
        )
        const rawBody = yield* Schema.decodeUnknownEffect(Schema.Uint8Array)(untrustedRawBody).pipe(
          Effect.mapError(() =>
            WebhookVerificationError.make({ reason: "event", message: "GitHub webhook body is invalid" }),
          ),
        )
        const expected = yield* crypto.hmacSha256(options.secret, rawBody)
        const supplied = yield* Schema.decodeUnknownEffect(Schema.Uint8ArrayFromHex)(
          headers.signature256.slice(7),
        ).pipe(
          Effect.mapError(() =>
            WebhookVerificationError.make({ reason: "headers", message: "GitHub webhook signature is invalid" }),
          ),
        )
        if (!(yield* crypto.constantTimeEqual(expected, supplied))) {
          return yield* WebhookVerificationError.make({
            reason: "signature",
            message: "GitHub webhook signature did not match",
          })
        }
        const event = yield* Webhook.decodeWebhookEvent(headers.eventName, new TextDecoder().decode(rawBody)).pipe(
          Effect.mapError(() =>
            WebhookVerificationError.make({ reason: "event", message: "GitHub webhook payload is invalid" }),
          ),
        )
        return { deliveryId: headers.deliveryId, event }
      })
      return WebhookVerifier.of({ verify })
    }),
  )

export const webhookVerifierWebCryptoLayer = (options: WebhookVerifierOptions) =>
  webhookVerifierLayer(options).pipe(Layer.provide(webCryptoLayer))

export const webhookVerifierTestLayer = (verify: WebhookVerifierService["verify"]) =>
  Layer.succeed(WebhookVerifier, WebhookVerifier.of({ verify }))
