import { Context, Effect, Encoding, Layer, Result, Schema } from "effect"
import { credentialAdditionalAuthenticatedData, credentialKmsEncryptionContext } from "./aad"
import { CredentialCipher, type CredentialCipherFailure, type EncryptedCredentialBytes } from "./cipher"
import {
  CredentialAuthTag,
  CredentialCiphertext,
  type CredentialBinding,
  type CredentialRotation,
  type EncryptedCredential,
  CredentialNonce,
  CredentialRevision,
  WrappedDataEncryptionKey,
} from "./model"
import { KmsDataKey, type KmsFailure } from "./kms/data-key"
import { registerSecretBytes, type Plaintext } from "./secret-bytes"

export class CredentialBindingMismatch extends Schema.TaggedError<CredentialBindingMismatch>()(
  "CredentialBindingMismatch",
  {
    field: Schema.Literals(["credentialId", "owner", "provider", "revision"]),
  },
) {}

export class CredentialRevoked extends Schema.TaggedError<CredentialRevoked>()("CredentialRevoked", {
  credentialId: Schema.String,
  revision: Schema.Finite,
  revokedAt: Schema.Finite,
}) {}

export class CredentialMaterialInvalid extends Schema.TaggedError<CredentialMaterialInvalid>()(
  "CredentialMaterialInvalid",
  {
    component: Schema.Literals(["ciphertext", "nonce", "authTag", "wrappedDataEncryptionKey"]),
  },
) {}

export interface EncryptCredentialInput {
  readonly binding: CredentialBinding
  readonly plaintext: Plaintext
  readonly createdAt: number
}

export interface DecryptCredentialInput {
  readonly credential: EncryptedCredential
  readonly binding: CredentialBinding
}

export interface RotateCredentialInput extends DecryptCredentialInput {
  readonly rotatedAt: number
}

export interface RevokeCredentialInput extends DecryptCredentialInput {
  readonly revokedAt: number
}

export type CredentialVaultFailure =
  | KmsFailure
  | CredentialCipherFailure
  | CredentialBindingMismatch
  | CredentialRevoked
  | CredentialMaterialInvalid

export interface CredentialVaultShape {
  readonly encrypt: (input: EncryptCredentialInput) => Effect.Effect<EncryptedCredential, CredentialVaultFailure>
  readonly decrypt: <A, E, R>(
    input: DecryptCredentialInput,
    use: (plaintext: Plaintext) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, CredentialVaultFailure | E, R>
  readonly rotate: (input: RotateCredentialInput) => Effect.Effect<CredentialRotation, CredentialVaultFailure>
  readonly revoke: (input: RevokeCredentialInput) => Effect.Effect<EncryptedCredential, CredentialVaultFailure>
}

export class CredentialVault extends Context.Service<CredentialVault, CredentialVaultShape>()(
  "@rika/credential-vault/vault/CredentialVault",
) {}

export type CredentialBindingField = CredentialBindingMismatch["field"]

const credentialBindingMismatch = (
  expected: CredentialBinding,
  actual: CredentialBinding,
): CredentialBindingField | undefined => {
  if (expected.credentialId !== actual.credentialId) return "credentialId"
  if (expected.owner._tag !== actual.owner._tag || expected.owner.id !== actual.owner.id) return "owner"
  if (expected.provider !== actual.provider) return "provider"
  if (expected.revision !== actual.revision) return "revision"
  return undefined
}

const requireBinding = Effect.fn("CredentialVault.requireBinding")(function* (
  expected: CredentialBinding,
  credential: EncryptedCredential,
) {
  const field = credentialBindingMismatch(expected, credential.metadata.binding)
  if (field !== undefined) return yield* CredentialBindingMismatch.make({ field })
})

const requireActive = Effect.fn("CredentialVault.requireActive")(function* (credential: EncryptedCredential) {
  if (credential.metadata.state._tag === "Revoked") {
    return yield* CredentialRevoked.make({
      credentialId: credential.metadata.binding.credentialId,
      revision: credential.metadata.binding.revision,
      revokedAt: credential.metadata.state.revokedAt,
    })
  }
})

const decodeMaterialPart = Effect.fn("CredentialVault.decodeMaterialPart")(function* (
  component: CredentialMaterialInvalid["component"],
  encoded: string,
) {
  const decoded = Encoding.decodeBase64(encoded)
  if (Result.isFailure(decoded)) return yield* CredentialMaterialInvalid.make({ component })
  return decoded.success
})

const decodeMaterial = Effect.fn("CredentialVault.decodeMaterial")(function* (
  credential: EncryptedCredential,
): Effect.fn.Return<EncryptedCredentialBytes & { readonly wrapped: Uint8Array }, CredentialMaterialInvalid> {
  return {
    ciphertext: yield* decodeMaterialPart("ciphertext", credential.material.ciphertext),
    nonce: yield* decodeMaterialPart("nonce", credential.material.nonce),
    authTag: yield* decodeMaterialPart("authTag", credential.material.authTag),
    wrapped: yield* decodeMaterialPart("wrappedDataEncryptionKey", credential.material.wrappedDataEncryptionKey),
  }
})

export const layer = Layer.effect(
  CredentialVault,
  Effect.gen(function* () {
    const kms = yield* KmsDataKey
    const cipher = yield* CredentialCipher

    const encryptScoped = Effect.fn("CredentialVault.encryptScoped")(function* (input: EncryptCredentialInput) {
      yield* registerSecretBytes(input.plaintext)
      const context = credentialKmsEncryptionContext(input.binding)
      const encryptWithKey = Effect.fn("CredentialVault.encryptWithKey")(function* (
        generated: Parameters<Parameters<KmsDataKey["Service"]["generateDataKey"]>[1]>[0],
      ) {
        const encrypted = yield* cipher.encrypt({
          key: generated.plaintext,
          plaintext: input.plaintext,
          additionalAuthenticatedData: credentialAdditionalAuthenticatedData(input.binding),
        })
        return {
          metadata: {
            binding: input.binding,
            createdAt: input.createdAt,
            state: { _tag: "Active" },
          },
          material: {
            algorithm: "AES-256-GCM",
            keyEncryption: "AWS-KMS",
            aadVersion: 1,
            ciphertext: CredentialCiphertext.make(Encoding.encodeBase64(encrypted.ciphertext)),
            nonce: CredentialNonce.make(Encoding.encodeBase64(encrypted.nonce)),
            authTag: CredentialAuthTag.make(Encoding.encodeBase64(encrypted.authTag)),
            wrappedDataEncryptionKey: WrappedDataEncryptionKey.make(Encoding.encodeBase64(generated.wrapped)),
          },
        } satisfies EncryptedCredential
      })
      return yield* kms.generateDataKey(context, encryptWithKey)
    })

    const encrypt = Effect.fn("CredentialVault.encrypt")(function* (input: EncryptCredentialInput) {
      return yield* Effect.scoped(encryptScoped(input))
    })

    const decrypt: CredentialVaultShape["decrypt"] = Effect.fn("CredentialVault.decrypt")(function* (input, use) {
      yield* requireBinding(input.binding, input.credential)
      yield* requireActive(input.credential)
      const material = yield* decodeMaterial(input.credential)
      const decryptWithKey = Effect.fn("CredentialVault.decryptWithKey")(function* (
        key: Parameters<Parameters<KmsDataKey["Service"]["decryptDataKey"]>[2]>[0],
      ) {
        return yield* cipher.decrypt(
          {
            key,
            encrypted: material,
            additionalAuthenticatedData: credentialAdditionalAuthenticatedData(input.binding),
          },
          use,
        )
      })
      return yield* kms.decryptDataKey(material.wrapped, credentialKmsEncryptionContext(input.binding), decryptWithKey)
    })

    const revoke = Effect.fn("CredentialVault.revoke")(function* (input: RevokeCredentialInput) {
      yield* requireBinding(input.binding, input.credential)
      yield* requireActive(input.credential)
      return {
        ...input.credential,
        metadata: {
          ...input.credential.metadata,
          state: { _tag: "Revoked", revokedAt: input.revokedAt, reason: "Manual" },
        },
      } satisfies EncryptedCredential
    })

    const rotateScoped = Effect.fn("CredentialVault.rotateScoped")(function* (input: RotateCredentialInput) {
      const rotatePlaintext = Effect.fn("CredentialVault.rotatePlaintext")(function* (plaintext: Plaintext) {
        const successorRevision = CredentialRevision.make(input.binding.revision + 1)
        const current = yield* encrypt({
          binding: { ...input.binding, revision: successorRevision },
          plaintext,
          createdAt: input.rotatedAt,
        })
        const previous: EncryptedCredential = {
          ...input.credential,
          metadata: {
            ...input.credential.metadata,
            state: {
              _tag: "Revoked",
              revokedAt: input.rotatedAt,
              reason: "Rotated",
              successorRevision,
            },
          },
        }
        return { previous, current, rotatedAt: input.rotatedAt } satisfies CredentialRotation
      })
      return yield* decrypt(input, rotatePlaintext)
    })

    const rotate = Effect.fn("CredentialVault.rotate")(function* (input: RotateCredentialInput) {
      return yield* Effect.scoped(rotateScoped(input))
    })

    return CredentialVault.of({ encrypt, decrypt, rotate, revoke })
  }),
)
