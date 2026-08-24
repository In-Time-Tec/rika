import { Context, Effect, Schema } from "effect"
import type { CredentialKmsEncryptionContext } from "../aad"
import type { DataEncryptionKey } from "../secret-bytes"

export class KmsFailure extends Schema.TaggedError<KmsFailure>()("CredentialKmsFailure", {
  operation: Schema.Literals(["GenerateDataKey", "Decrypt"]),
  reason: Schema.Literals(["RequestFailed", "InvalidResponse"]),
}) {}

export interface GeneratedDataEncryptionKey {
  readonly plaintext: DataEncryptionKey
  readonly wrapped: Uint8Array
}

export interface KmsDataKeyContract {
  readonly generateDataKey: <A, E, R>(
    context: CredentialKmsEncryptionContext,
    use: (key: GeneratedDataEncryptionKey) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, KmsFailure | E, R>
  readonly decryptDataKey: <A, E, R>(
    wrapped: Uint8Array,
    context: CredentialKmsEncryptionContext,
    use: (key: DataEncryptionKey) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, KmsFailure | E, R>
}

export class KmsDataKey extends Context.Service<KmsDataKey, KmsDataKeyContract>()(
  "@rika/credential-vault/kms/data-key/KmsDataKey",
) {}
