import type { CredentialBinding } from "./model"

export interface CredentialKmsEncryptionContext {
  readonly credentialId: string
  readonly ownerType: "user" | "organization"
  readonly ownerId: string
  readonly provider: string
  readonly revision: string
  readonly version: "1"
}

const textEncoder = new TextEncoder()

const ownerType = (binding: CredentialBinding): CredentialKmsEncryptionContext["ownerType"] =>
  binding.owner._tag === "User" ? "user" : "organization"

export const credentialKmsEncryptionContext = (binding: CredentialBinding): CredentialKmsEncryptionContext => ({
  credentialId: binding.credentialId,
  ownerType: ownerType(binding),
  ownerId: binding.owner.id,
  provider: binding.provider,
  revision: String(binding.revision),
  version: "1",
})

export const credentialAdditionalAuthenticatedData = (binding: CredentialBinding): Uint8Array => {
  const context = credentialKmsEncryptionContext(binding)
  const values = [
    context.version,
    context.credentialId,
    context.ownerType,
    context.ownerId,
    context.provider,
    context.revision,
  ]
  return textEncoder.encode(values.map((value) => `${textEncoder.encode(value).length}:${value}`).join(""))
}
