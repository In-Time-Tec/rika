import { Schema } from "effect"

const Identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const Base64 = Schema.String.check(Schema.isBase64())
const Timestamp = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))

export const CredentialId = Identity.pipe(Schema.brand("RikaCredentialId"))
export type CredentialId = typeof CredentialId.Type

export const CredentialProvider = Identity.pipe(Schema.brand("RikaCredentialProvider"))
export type CredentialProvider = typeof CredentialProvider.Type

export const CredentialRevision = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
).pipe(Schema.brand("RikaCredentialRevision"))
export type CredentialRevision = typeof CredentialRevision.Type

export const CredentialUserId = Identity.pipe(Schema.brand("RikaCredentialUserId"))
export type CredentialUserId = typeof CredentialUserId.Type

export const CredentialOrganizationId = Identity.pipe(Schema.brand("RikaCredentialOrganizationId"))
export type CredentialOrganizationId = typeof CredentialOrganizationId.Type

export const CredentialOwner = Schema.Union([
  Schema.TaggedStruct("User", { id: CredentialUserId }),
  Schema.TaggedStruct("Organization", { id: CredentialOrganizationId }),
])
export type CredentialOwner = typeof CredentialOwner.Type

export const CredentialBinding = Schema.Struct({
  credentialId: CredentialId,
  owner: CredentialOwner,
  provider: CredentialProvider,
  revision: CredentialRevision,
})
export type CredentialBinding = typeof CredentialBinding.Type

export const ActiveCredentialState = Schema.TaggedStruct("Active", {})
export type ActiveCredentialState = typeof ActiveCredentialState.Type

export const RevokedCredentialState = Schema.TaggedStruct("Revoked", {
  revokedAt: Timestamp,
  reason: Schema.Literals(["Manual", "Rotated"]),
  successorRevision: Schema.optionalKey(CredentialRevision),
})
export type RevokedCredentialState = typeof RevokedCredentialState.Type

export const CredentialState = Schema.Union([ActiveCredentialState, RevokedCredentialState])
export type CredentialState = typeof CredentialState.Type

export const CredentialMetadata = Schema.Struct({
  binding: CredentialBinding,
  createdAt: Timestamp,
  state: CredentialState,
})
export type CredentialMetadata = typeof CredentialMetadata.Type

export const CredentialCiphertext = Base64.pipe(Schema.brand("RikaCredentialCiphertext"))
export type CredentialCiphertext = typeof CredentialCiphertext.Type

export const CredentialNonce = Base64.check(Schema.isLengthBetween(16, 16)).pipe(Schema.brand("RikaCredentialNonce"))
export type CredentialNonce = typeof CredentialNonce.Type

export const CredentialAuthTag = Base64.check(Schema.isLengthBetween(24, 24)).pipe(
  Schema.brand("RikaCredentialAuthTag"),
)
export type CredentialAuthTag = typeof CredentialAuthTag.Type

export const WrappedDataEncryptionKey = Base64.check(Schema.isMinLength(4)).pipe(
  Schema.brand("RikaWrappedDataEncryptionKey"),
)
export type WrappedDataEncryptionKey = typeof WrappedDataEncryptionKey.Type

export const EncryptedCredentialMaterial = Schema.Struct({
  algorithm: Schema.Literal("AES-256-GCM"),
  keyEncryption: Schema.Literal("AWS-KMS"),
  aadVersion: Schema.Literal(1),
  ciphertext: CredentialCiphertext,
  nonce: CredentialNonce,
  authTag: CredentialAuthTag,
  wrappedDataEncryptionKey: WrappedDataEncryptionKey,
})
export type EncryptedCredentialMaterial = typeof EncryptedCredentialMaterial.Type

export const EncryptedCredential = Schema.Struct({
  metadata: CredentialMetadata,
  material: EncryptedCredentialMaterial,
})
export type EncryptedCredential = typeof EncryptedCredential.Type

export const CredentialRotation = Schema.Struct({
  previous: EncryptedCredential,
  current: EncryptedCredential,
  rotatedAt: Timestamp,
})
export type CredentialRotation = typeof CredentialRotation.Type
