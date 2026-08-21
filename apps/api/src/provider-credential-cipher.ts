import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { Redacted } from "effect"

export interface EncryptedProviderCredential {
  readonly keyVersion: 1
  readonly nonce: Uint8Array
  readonly ciphertext: Uint8Array
  readonly authenticationTag: Uint8Array
}

export interface ProviderCredentialCipher {
  readonly encrypt: (identity: string, value: Redacted.Redacted<string>) => EncryptedProviderCredential
  readonly decrypt: (identity: string, value: EncryptedProviderCredential) => Redacted.Redacted<string>
}

const additionalData = (identity: string) => Buffer.from(`rika/provider-credential/v1/${identity}`, "utf8")

export const makeProviderCredentialCipher = (encodedKey: Redacted.Redacted<string>): ProviderCredentialCipher => {
  const key = Buffer.from(Redacted.value(encodedKey), "base64")
  if (key.byteLength !== 32) throw new Error("Provider credential encryption key must contain 32 bytes")
  return {
    encrypt: (identity, value) => {
      const nonce = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", key, nonce)
      cipher.setAAD(additionalData(identity))
      const ciphertext = Buffer.concat([cipher.update(Redacted.value(value), "utf8"), cipher.final()])
      return {
        keyVersion: 1,
        nonce,
        ciphertext,
        authenticationTag: cipher.getAuthTag(),
      }
    },
    decrypt: (identity, value) => {
      const decipher = createDecipheriv("aes-256-gcm", key, value.nonce)
      decipher.setAAD(additionalData(identity))
      decipher.setAuthTag(value.authenticationTag)
      return Redacted.make(Buffer.concat([decipher.update(value.ciphertext), decipher.final()]).toString("utf8"))
    },
  }
}
