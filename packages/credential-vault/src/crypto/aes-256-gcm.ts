import { gcm } from "@noble/ciphers/aes.js"
import { randomBytes } from "@noble/ciphers/utils.js"
import { Effect, Layer, Redacted } from "effect"
import { CredentialCipher, CredentialCipherFailure, type EncryptedCredentialBytes } from "../cipher"
import { scopedPlaintext } from "../secret-bytes"

const authenticationTagLength = 16
const nonceLength = 12

const failure = (
  operation: "Encrypt" | "Decrypt",
  reason: "InvalidKey" | "RandomGenerationFailed" | "EncryptionFailed" | "AuthenticationFailed",
) => CredentialCipherFailure.make({ operation, reason })

const encrypt = Effect.fn("NobleAes256Gcm.encrypt")(function* (input: {
  readonly key: Parameters<CredentialCipher["Service"]["encrypt"]>[0]["key"]
  readonly plaintext: Parameters<CredentialCipher["Service"]["encrypt"]>[0]["plaintext"]
  readonly additionalAuthenticatedData: Uint8Array
}) {
  const key = Redacted.value(input.key)
  if (key.length !== 32) return yield* failure("Encrypt", "InvalidKey")
  const nonce = yield* Effect.try({
    try: () => randomBytes(nonceLength),
    catch: () => failure("Encrypt", "RandomGenerationFailed"),
  })
  const encrypted = yield* Effect.try({
    try: () => gcm(key, nonce, input.additionalAuthenticatedData).encrypt(Redacted.value(input.plaintext)),
    catch: () => failure("Encrypt", "EncryptionFailed"),
  })
  const ciphertext = encrypted.slice(0, -authenticationTagLength)
  const authTag = encrypted.slice(-authenticationTagLength)
  encrypted.fill(0)
  return { ciphertext, nonce, authTag } satisfies EncryptedCredentialBytes
})

const decrypt: CredentialCipher["Service"]["decrypt"] = Effect.fn("NobleAes256Gcm.decrypt")(function* (input, use) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const key = Redacted.value(input.key)
      if (key.length !== 32) return yield* failure("Decrypt", "InvalidKey")
      const combined = new Uint8Array(input.encrypted.ciphertext.length + input.encrypted.authTag.length)
      combined.set(input.encrypted.ciphertext)
      combined.set(input.encrypted.authTag, input.encrypted.ciphertext.length)
      const decrypted = yield* Effect.try({
        try: () => gcm(key, input.encrypted.nonce, input.additionalAuthenticatedData).decrypt(combined),
        catch: () => failure("Decrypt", "AuthenticationFailed"),
      }).pipe(Effect.ensuring(Effect.sync(() => combined.fill(0))))
      const plaintext = yield* scopedPlaintext(decrypted)
      return yield* use(plaintext)
    }),
  )
})

export const nobleAes256GcmLayer = Layer.succeed(CredentialCipher, CredentialCipher.of({ encrypt, decrypt }))
