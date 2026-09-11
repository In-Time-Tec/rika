import { gcm } from "@noble/ciphers/aes.js"
import { Effect, Encoding, Redacted, Result, Schema, Scope } from "effect"

const keyLength = 32
const nonceLength = 12
const authenticationTagLength = 16
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

export class ProviderCredentialCipherError extends Schema.TaggedError<ProviderCredentialCipherError>()(
  "ProviderCredentialCipherError",
  {
    reason: Schema.Literals(["invalid-key", "invalid-material", "authentication-failed"]),
    message: Schema.String,
  },
) {}

export interface ProviderEncryptedCredential {
  readonly ownerId: string
  readonly provider: string
  readonly keyVersion: number
  readonly nonce: Uint8Array
  readonly ciphertext: Uint8Array
  readonly authenticationTag: Uint8Array
}

export interface ProviderCredentialCipher {
  readonly decrypt: (
    input: ProviderEncryptedCredential,
  ) => Effect.Effect<Redacted.Redacted<string>, ProviderCredentialCipherError, Scope.Scope>
}

const failure = (reason: ProviderCredentialCipherError["reason"], message: string) =>
  ProviderCredentialCipherError.make({ reason, message })

const invalidKey = () => failure("invalid-key", "Provider credential encryption key is invalid")
const invalidMaterial = () => failure("invalid-material", "Provider credential encryption material is invalid")
const authenticationFailed = () => failure("authentication-failed", "Provider credential could not be decrypted")

const decodeKey = (encodedKey: Redacted.Redacted<string>) =>
  Effect.try({
    try: () => {
      const encoded = Redacted.value(encodedKey)
      const decoded = Encoding.decodeBase64(encoded)
      if (Result.isFailure(decoded)) return undefined
      const bytes = decoded.success
      if (bytes.length !== keyLength || Encoding.encodeBase64(bytes) !== encoded) {
        bytes.fill(0)
        return undefined
      }
      const key = bytes.slice()
      bytes.fill(0)
      return key
    },
    catch: invalidKey,
  }).pipe(Effect.flatMap((key) => (key === undefined ? Effect.fail(invalidKey()) : Effect.succeed(key))))

const makeCipher = (key: Uint8Array, state: { closed: boolean }): ProviderCredentialCipher => ({
  decrypt: (input) =>
    Effect.gen(function* () {
      if (
        input.keyVersion !== 1 ||
        input.nonce.length !== nonceLength ||
        input.ciphertext.length === 0 ||
        input.authenticationTag.length !== authenticationTagLength
      )
        return yield* invalidMaterial()
      const combined = new Uint8Array(input.ciphertext.length + input.authenticationTag.length)
      combined.set(input.ciphertext)
      combined.set(input.authenticationTag, input.ciphertext.length)
      const additionalAuthenticatedData = encoder.encode(
        `rika/provider-credential/v1/${input.ownerId}/${input.provider}`,
      )
      const plaintext = yield* Effect.try({
        try: () => {
          if (state.closed) throw new Error("Provider credential cipher is closed")
          return gcm(key, input.nonce, additionalAuthenticatedData).decrypt(combined)
        },
        catch: authenticationFailed,
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            combined.fill(0)
            additionalAuthenticatedData.fill(0)
          }),
        ),
      )
      const value = yield* Effect.try({
        try: () => decoder.decode(plaintext),
        catch: invalidMaterial,
      }).pipe(Effect.ensuring(Effect.sync(() => plaintext.fill(0))))
      const credential = Redacted.make(value, { label: "provider-credential" })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          Redacted.wipeUnsafe(credential)
        }),
      )
      return credential
    }),
})

export const makeProviderCredentialCipher = (input: {
  readonly encodedKey: Redacted.Redacted<string>
}): Effect.Effect<ProviderCredentialCipher, ProviderCredentialCipherError, Scope.Scope> =>
  Effect.gen(function* () {
    const state = { closed: false }
    const key = yield* Effect.acquireRelease(decodeKey(input.encodedKey), (configuredKey) =>
      Effect.sync(() => {
        state.closed = true
        configuredKey.fill(0)
      }),
    )
    return makeCipher(key, state)
  })
