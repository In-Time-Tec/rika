import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { Context, Layer, Redacted } from "effect"

export interface EncryptedSecret {
  readonly keyVersion: 1
  readonly nonce: Uint8Array
  readonly ciphertext: Uint8Array
  readonly authenticationTag: Uint8Array
}

export interface SecretCipher {
  readonly encrypt: (identity: string, value: Redacted.Redacted<string>) => EncryptedSecret
  readonly decrypt: (identity: string, value: EncryptedSecret) => Redacted.Redacted<string>
}

export class SecretCipherService extends Context.Service<SecretCipherService, SecretCipher>()(
  "@rika/api/security/secret-cipher/SecretCipherService",
) {}

const additionalData = (domain: string, identity: string) => Buffer.from(`rika/${domain}/v1/${identity}`, "utf8")

export const makeSecretCipher = (input: {
  readonly encodedKey: Redacted.Redacted<string>
  readonly domain: "environment" | "provider-credential"
}): SecretCipher => {
  const { encodedKey, domain } = input
  const key = Buffer.from(Redacted.value(encodedKey), "base64")
  if (key.byteLength !== 32) throw new Error("Secret encryption key must contain 32 bytes")
  return {
    encrypt: (identity, value) => {
      const nonce = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", key, nonce)
      cipher.setAAD(additionalData(domain, identity))
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
      decipher.setAAD(additionalData(domain, identity))
      decipher.setAuthTag(value.authenticationTag)
      return Redacted.make(Buffer.concat([decipher.update(value.ciphertext), decipher.final()]).toString("utf8"))
    },
  }
}

export const layer = (input: Parameters<typeof makeSecretCipher>[0]) =>
  Layer.succeed(SecretCipherService, makeSecretCipher(input))
