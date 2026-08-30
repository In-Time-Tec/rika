import { Clock, Crypto, DateTime, Effect, Encoding } from "effect"
import { BetterAuthUserId, ClientId, DeviceId } from "@rika/product/hosted-model"
import type { ThreadProtocolStore } from "@rika/product/thread-protocol-store"
import type { AuthenticatedPrincipal, HostedProduct } from "../product"
import {
  type HostedThreadProtocolService,
  productFailure,
  storeFailure,
  threadWebSocketAudience,
  unavailable,
} from "./protocol-contract"

const ticketLifetimeMillis = 60_000

export const ticketOperations = (dependencies: {
  readonly product: HostedProduct["Service"]
  readonly store: ThreadProtocolStore["Service"]
  readonly crypto: Crypto.Crypto
}) => {
  const digest = Effect.fn("HostedThreadProtocol.digest")(function* (ticket: string) {
    const bytes = yield* dependencies.crypto
      .digest("SHA-256", new TextEncoder().encode(ticket))
      .pipe(Effect.mapError(() => unavailable()))
    return Encoding.encodeHex(bytes)
  })

  const issueTicket: HostedThreadProtocolService["issueTicket"] = Effect.fn("HostedThreadProtocol.issueTicket")(
    function* (principal) {
      yield* dependencies.product.activatePrincipal(principal).pipe(Effect.mapError(productFailure))
      const issuedAtMillis = yield* Clock.currentTimeMillis
      const issuedAt = DateTime.formatIso(DateTime.makeUnsafe(issuedAtMillis))
      const expiresAt = DateTime.formatIso(DateTime.makeUnsafe(issuedAtMillis + ticketLifetimeMillis))
      const secret = Encoding.encodeBase64Url(
        yield* dependencies.crypto.randomBytes(32).pipe(Effect.mapError(() => unavailable("Ticket issuance failed"))),
      )
      const ticketId = yield* dependencies.crypto.randomUUIDv4.pipe(
        Effect.mapError(() => unavailable("Ticket issuance failed")),
      )
      yield* dependencies.store
        .issueTicket({
          ticketId,
          ticketDigest: yield* digest(secret),
          userId: BetterAuthUserId.make(principal.userId),
          clientId: ClientId.make(principal.clientId),
          deviceId: DeviceId.make(principal.deviceId),
          audience: threadWebSocketAudience,
          issuedAt,
          expiresAt,
        })
        .pipe(Effect.mapError(storeFailure))
      return { ticket: secret, expiresAt }
    },
  )

  const redeemTicket = Effect.fn("HostedThreadProtocol.redeemTicket")(function* (ticket: string, audience: string) {
    const redeemedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))
    const binding = yield* dependencies.store
      .redeemTicket({ ticketDigest: yield* digest(ticket), audience, redeemedAt })
      .pipe(Effect.mapError(storeFailure))
    const principal: AuthenticatedPrincipal = {
      userId: binding.userId,
      clientId: binding.clientId,
      deviceId: binding.deviceId,
    }
    return { binding, principal }
  })

  return { issueTicket, redeemTicket }
}
