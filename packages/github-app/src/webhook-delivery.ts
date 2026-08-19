import * as WebhookEvent from "./webhook-event"
import * as WebhookVerification from "./webhook-verifier"
import { Clock, Context, Effect, Layer, Schema } from "effect"

export interface DeliveryClaimInput {
  readonly source: "github"
  readonly deliveryId: string
  readonly receivedAtMillis: number
}

export class DeliveryClaimError extends Schema.TaggedError<DeliveryClaimError>()("GitHubDeliveryClaimError", {
  message: Schema.String,
}) {}

export interface DeliveryClaimsService {
  readonly claim: (input: DeliveryClaimInput) => Effect.Effect<boolean, DeliveryClaimError>
}

export class DeliveryClaims extends Context.Service<DeliveryClaims, DeliveryClaimsService>()(
  "@rika/github-app/webhook-delivery/DeliveryClaims",
) {}

export class DuplicateDeliveryError extends Schema.TaggedError<DuplicateDeliveryError>()(
  "GitHubDuplicateDeliveryError",
  {
    deliveryId: Schema.String,
    message: Schema.String,
  },
) {}

export interface DeliveryReconciliationInput {
  readonly source: "github"
  readonly dedupeKey: string
  readonly deliveryId: string
  readonly receivedAtMillis: number
  readonly command: WebhookEvent.ReconciliationCommand
}

export interface WebhookDeliveryService {
  readonly accept: (
    headers: WebhookVerification.WebhookHeaders,
    rawBody: Uint8Array,
  ) => Effect.Effect<
    DeliveryReconciliationInput,
    WebhookVerification.WebhookVerificationError | DeliveryClaimError | DuplicateDeliveryError
  >
}

export class WebhookDelivery extends Context.Service<WebhookDelivery, WebhookDeliveryService>()(
  "@rika/github-app/webhook-delivery/WebhookDelivery",
) {}

export const webhookDeliveryLayer = Layer.effect(
  WebhookDelivery,
  Effect.gen(function* () {
    const verifier = yield* WebhookVerification.WebhookVerifier
    const claims = yield* DeliveryClaims
    const accept = Effect.fn("GitHubWebhookDelivery.accept")(function* (
      headers: WebhookVerification.WebhookHeaders,
      rawBody: Uint8Array,
    ) {
      const verified = yield* verifier.verify(headers, rawBody)
      const receivedAtMillis = yield* Clock.currentTimeMillis
      const claimed = yield* claims.claim({ source: "github", deliveryId: verified.deliveryId, receivedAtMillis })
      if (!claimed) {
        return yield* DuplicateDeliveryError.make({
          deliveryId: verified.deliveryId,
          message: "GitHub webhook delivery was already accepted",
        })
      }
      return {
        source: "github" as const,
        dedupeKey: `github:${verified.deliveryId}`,
        deliveryId: verified.deliveryId,
        receivedAtMillis,
        command: WebhookEvent.reconciliationCommand(verified.event),
      }
    })
    return WebhookDelivery.of({ accept })
  }),
)

export const deliveryClaimsTestLayer = (claim: DeliveryClaimsService["claim"]) =>
  Layer.succeed(DeliveryClaims, DeliveryClaims.of({ claim }))
