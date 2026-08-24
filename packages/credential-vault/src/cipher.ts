import { Context, Effect, Schema } from "effect"
import type { DataEncryptionKey, Plaintext } from "./secret-bytes"

export class CredentialCipherFailure extends Schema.TaggedError<CredentialCipherFailure>()("CredentialCipherFailure", {
  operation: Schema.Literals(["Encrypt", "Decrypt"]),
  reason: Schema.Literals(["InvalidKey", "RandomGenerationFailed", "EncryptionFailed", "AuthenticationFailed"]),
}) {}

export interface EncryptedCredentialBytes {
  readonly ciphertext: Uint8Array
  readonly nonce: Uint8Array
  readonly authTag: Uint8Array
}

export interface CredentialCipherContract {
  readonly encrypt: (input: {
    readonly key: DataEncryptionKey
    readonly plaintext: Plaintext
    readonly additionalAuthenticatedData: Uint8Array
  }) => Effect.Effect<EncryptedCredentialBytes, CredentialCipherFailure>
  readonly decrypt: <A, E, R>(
    input: {
      readonly key: DataEncryptionKey
      readonly encrypted: EncryptedCredentialBytes
      readonly additionalAuthenticatedData: Uint8Array
    },
    use: (plaintext: Plaintext) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, CredentialCipherFailure | E, R>
}

export class CredentialCipher extends Context.Service<CredentialCipher, CredentialCipherContract>()(
  "@rika/credential-vault/cipher/CredentialCipher",
) {}
