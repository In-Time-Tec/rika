import { Crypto, Effect, Encoding, Layer } from "effect"
import { createHash } from "node:crypto"
import * as Flow from "../src/authentication/openai-auth-service"
import * as Contract from "../src/authentication/openai-auth-contract"

export const digest = (_algorithm: string, data: Uint8Array) =>
  Effect.promise(() => globalThis.crypto.subtle.digest("SHA-256", data).then((value) => new Uint8Array(value)))

export const deterministicCrypto = (start = 0) => {
  let next = start
  return Layer.succeed(
    Crypto.Crypto,
    Crypto.make({
      randomBytes: (size) => Uint8Array.from({ length: size }, () => next++ & 255),
      digest,
    }),
  )
}

export const jwt = (account = "account-secret", user = "user-secret", exp = 2_000_000_000) => {
  const payload = Encoding.encodeBase64Url(
    new TextEncoder().encode(
      JSON.stringify({
        exp,
        "https://api.openai.com/auth": { chatgpt_account_id: account, chatgpt_user_id: user },
      }),
    ),
  )
  return `header.${payload}.signature`
}

export const expiryJwt = (exp: number) => {
  const payload = Encoding.encodeBase64Url(new TextEncoder().encode(JSON.stringify({ exp })))
  return `header.${payload}.signature`
}

export const tokens = (account?: string, user?: string) => ({
  access_token: jwt(account, user),
  id_token: jwt(account, user),
  refresh_token: "refresh-secret",
  expires_in: 3600,
})

type Disk = typeof Contract.CredentialDisk.Type
export const disk = (overrides: Partial<Disk> = {}): Disk => ({
  formatVersion: Flow.configuration.credentialFormatVersion,
  accessToken: jwt(),
  idToken: jwt(),
  refreshToken: "refresh-secret",
  accountId: "account-secret",
  fingerprint: createHash("sha256").update("account-secret\0user-secret").digest("base64url"),
  generation: "generation-1",
  expiresAt: 2_000_000_000_000,
  refreshedAt: 1,
  ...overrides,
})
