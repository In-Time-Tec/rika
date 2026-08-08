import { Context, Effect } from "effect"

/**
 * SHA-256 wire digest for the Rika Server handshake.
 *
 * The server proofs are HMAC-SHA256(key = connection token, message = canonical
 * JSON of the signed fields), hex-encoded. Every implementation MUST produce
 * byte-identical hex for the same (key, input) so Bun, Node, and Web clients
 * authenticate against the same server without a shared runtime.
 */
export interface Sha256Shape {
  readonly hmac: (key: string, input: string) => Effect.Effect<string>
}

export class Sha256 extends Context.Service<Sha256, Sha256Shape>()(
  "@rika/product/server/server-service-sha256/Sha256",
) {}
