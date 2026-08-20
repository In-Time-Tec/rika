import * as Delivery from "../src/webhook-delivery"
import * as WebhookEvent from "../src/webhook-event"
import * as WebhookVerifier from "../src/webhook-verifier"
import { installation, repository } from "./github-fixtures"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import { provide } from "./test-layer"

const encoder = new TextEncoder()
const validSignature = `sha256=${"00".repeat(32)}`

const cryptoLayer = (comparisons: Array<ReadonlyArray<Uint8Array>> = []) =>
  Layer.succeed(
    WebhookVerifier.WebhookCrypto,
    WebhookVerifier.WebhookCrypto.of({
      hmacSha256: () => Effect.succeed(new Uint8Array(32)),
      constantTimeEqual: (left, right) => {
        comparisons.push([left, right])
        return Effect.succeed(left.length === right.length && left.every((value, index) => value === right[index]))
      },
    }),
  )

const verifierLayer = (comparisons: Array<ReadonlyArray<Uint8Array>> = []) =>
  WebhookVerifier.webhookVerifierLayer({ secret: Redacted.make("webhook-secret") }).pipe(
    Layer.provide(cryptoLayer(comparisons)),
  )

const headers = (deliveryId: string, eventName: WebhookEvent.WebhookEventName) => ({
  signature256: validSignature,
  eventName,
  deliveryId,
})

const installationPayload = (action: WebhookEvent.InstallationEvent["action"]) =>
  JSON.stringify({ action, installation, repositories: [repository(1)] })

const repositoriesPayload = (action: WebhookEvent.InstallationRepositoriesEvent["action"]) =>
  JSON.stringify({
    action,
    installation,
    repository_selection: "selected",
    repositories_added: action === "added" ? [repository(2)] : [],
    repositories_removed: action === "removed" ? [repository(2)] : [],
  })

const repositoryPayload = (action: WebhookEvent.RepositoryEvent["action"]) =>
  JSON.stringify({ action, installation: { id: 42 }, repository: repository(2) })

describe("GitHub webhook verification and reconciliation", () => {
  it.effect("implements the published HMAC SHA-256 test vector with Web Crypto", () =>
    Effect.gen(function* () {
      const crypto = yield* WebhookVerifier.WebhookCrypto
      const digest = yield* crypto.hmacSha256(
        Redacted.make("It's a Secret to Everybody"),
        encoder.encode("Hello, World!"),
      )
      expect(yield* Schema.encodeUnknownEffect(Schema.Uint8ArrayFromHex)(digest)).toBe(
        "757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
      )
    }).pipe(provide(WebhookVerifier.webCryptoLayer)),
  )

  it.effect("compares the raw-body HMAC in constant time and rejects a mismatch before decoding JSON", () => {
    const comparisons: Array<ReadonlyArray<Uint8Array>> = []
    return Effect.gen(function* () {
      const verifier = yield* WebhookVerifier.WebhookVerifier
      const mismatch = yield* Effect.flip(
        verifier.verify(
          { ...headers("delivery-1", "installation"), signature256: `sha256=${"01".repeat(32)}` },
          encoder.encode("not-json"),
        ),
      )
      expect(mismatch.reason).toBe("signature")
      expect(comparisons).toHaveLength(1)
      expect(comparisons[0]?.[0]).toHaveLength(32)
      expect(comparisons[0]?.[1]).toHaveLength(32)
      const malformed = yield* Effect.flip(
        verifier.verify(headers("delivery-2", "installation"), encoder.encode("not-json")),
      )
      expect(malformed.reason).toBe("event")
      expect(comparisons).toHaveLength(2)
    }).pipe(provide(verifierLayer(comparisons)))
  })

  it.effect("schema-validates every owned installation and repository lifecycle action", () =>
    Effect.gen(function* () {
      const installationActions = ["created", "deleted", "new_permissions_accepted", "suspend", "unsuspend"] as const
      const installationReasons = []
      for (const action of installationActions) {
        const event = yield* WebhookEvent.decodeWebhookEvent("installation", installationPayload(action))
        installationReasons.push(WebhookEvent.reconciliationCommand(event).reason)
      }
      expect(installationReasons).toEqual([
        "installation_created",
        "installation_deleted",
        "installation_new_permissions",
        "installation_suspended",
        "installation_unsuspended",
      ])
      for (const action of ["added", "removed"] as const) {
        const event = yield* WebhookEvent.decodeWebhookEvent("installation_repositories", repositoriesPayload(action))
        const command = WebhookEvent.reconciliationCommand(event)
        expect(command._tag).toBe("ReconcileInstallationRepositories")
        if (command._tag === "ReconcileInstallationRepositories") expect(command.hintedRepositoryIds).toEqual([2])
      }
      for (const action of ["renamed", "archived", "deleted", "transferred"] as const) {
        const event = yield* WebhookEvent.decodeWebhookEvent("repository", repositoryPayload(action))
        expect(WebhookEvent.reconciliationCommand(event)).toMatchObject({
          _tag: "ReconcileRepository",
          installationId: 42,
          repositoryId: 2,
          reason: `repository_${action}`,
        })
      }
      yield* Effect.flip(
        WebhookEvent.decodeWebhookEvent(
          "repository",
          '{"action":"created","repository":{"id":1,"name":"repository-1"}}',
        ),
      )
    }),
  )

  it.effect(
    "deduplicates replayed deliveries while accepting out-of-order events as current-state reconciliation",
    () => {
      const claimed = new Set<string>()
      const claimsLayer = Delivery.deliveryClaimsTestLayer((input) => {
        const fresh = !claimed.has(input.deliveryId)
        claimed.add(input.deliveryId)
        return Effect.succeed(fresh)
      })
      const layer = Delivery.webhookDeliveryLayer.pipe(Layer.provide(Layer.merge(verifierLayer(), claimsLayer)))
      return Effect.gen(function* () {
        yield* TestClock.setTime(10_000)
        const delivery = yield* Delivery.WebhookDelivery
        const newer = yield* delivery.accept(
          headers("delivery-new", "repository"),
          encoder.encode(repositoryPayload("deleted")),
        )
        const older = yield* delivery.accept(
          headers("delivery-old", "repository"),
          encoder.encode(repositoryPayload("renamed")),
        )
        expect([newer.command, older.command]).toEqual([
          {
            _tag: "ReconcileRepository",
            installationId: 42,
            repositoryId: 2,
            reason: "repository_deleted",
          },
          {
            _tag: "ReconcileRepository",
            installationId: 42,
            repositoryId: 2,
            reason: "repository_renamed",
          },
        ])
        expect(newer.dedupeKey).toBe("github:delivery-new")
        const replay = yield* Effect.flip(
          delivery.accept(headers("delivery-new", "repository"), encoder.encode(repositoryPayload("deleted"))),
        )
        expect(replay._tag).toBe("GitHubDuplicateDeliveryError")
      }).pipe(provide(layer))
    },
  )
})
