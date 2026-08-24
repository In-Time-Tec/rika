import { Function } from "effect"
import { Crypto, Effect, Encoding, Layer } from "effect"
import { createHash } from "node:crypto"
import * as Flow from "../../src/authentication/openai-service"
import * as Contract from "../../src/authentication/openai-contract"

const digestImpl = (_algorithm: string, data: Uint8Array) =>
  Effect.sync(() => new Uint8Array(createHash("sha256").update(data).digest()))

export const digest: {
  (arg1: Uint8Array): (arg0: string) => ReturnType<typeof digestImpl>
  (arg0: string, arg1: Uint8Array): ReturnType<typeof digestImpl>
} = Function.dual((args) => args.length <= 2, digestImpl)

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

const jwtImpl = (account = "account-secret", user = "user-secret", exp = 2_000_000_000) => {
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

export const jwt: {
  (arg1: unknown, arg2: unknown): (arg0: unknown) => ReturnType<typeof jwtImpl>
  (arg0: unknown, arg1: unknown, arg2: unknown): ReturnType<typeof jwtImpl>
} = Function.dual((args) => args.length <= 3, jwtImpl)

export const expiryJwt = (exp: number) => {
  const payload = Encoding.encodeBase64Url(new TextEncoder().encode(JSON.stringify({ exp })))
  return `header.${payload}.signature`
}

const tokensImpl = (account?: string, user?: string) => ({
  access_token: jwt(account, user),
  id_token: jwt(account, user),
  refresh_token: "refresh-secret",
  expires_in: 3600,
})

export const tokens: {
  (arg1?: string): (arg0?: string) => ReturnType<typeof tokensImpl>
  (arg0?: string, arg1?: string): ReturnType<typeof tokensImpl>
} = Function.dual((args) => args.length <= 2, tokensImpl)

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
