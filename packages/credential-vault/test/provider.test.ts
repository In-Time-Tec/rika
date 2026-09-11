import { gcm } from "@noble/ciphers/aes.js"
import { Effect, Encoding, Inspectable, Redacted, Schema } from "effect"
import { expect, it } from "@effect/vitest"
import {
  makeProviderCredentialCipher,
  type ProviderCredentialCipher,
  type ProviderEncryptedCredential,
} from "../src/provider"

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const key = new Uint8Array(32).fill(17)
const encodedKey = Redacted.make(Encoding.encodeBase64(key))

const encrypted = (
  secret: string,
  ownerId = "owner-1",
  provider = "openai",
  encryptionKey = key,
): ProviderEncryptedCredential => {
  const nonce = new Uint8Array(12).fill(23)
  const plaintext = encoder.encode(secret)
  const sealed = gcm(
    encryptionKey,
    nonce,
    encoder.encode(`rika/provider-credential/v1/${ownerId}/${provider}`),
  ).encrypt(plaintext)
  plaintext.fill(0)
  return {
    ownerId,
    provider,
    keyVersion: 1,
    nonce,
    ciphertext: sealed.slice(0, -16),
    authenticationTag: sealed.slice(-16),
  }
}

const withCipher = <A, E, R>(
  use: (cipher: ProviderCredentialCipher) => Effect.Effect<A, E, R>,
  configuredKey = encodedKey,
) => Effect.scoped(Effect.flatMap(makeProviderCredentialCipher({ encodedKey: configuredKey }), use))

it.effect("decrypts the legacy provider credential contract and scopes the plaintext", () =>
  Effect.gen(function* () {
    const secret = "provider-secret-value"
    let credential: Redacted.Redacted<string> | undefined
    let rendered = ""
    const value = yield* withCipher((cipher) =>
      Effect.gen(function* () {
        credential = yield* cipher.decrypt(encrypted(secret))
        rendered = [
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(credential),
          Inspectable.toStringUnknown(credential),
        ].join("\n")
        return Redacted.value(credential)
      }),
    )
    expect(value).toBe(secret)
    expect(rendered).toContain("<redacted:provider-credential>")
    expect(rendered).not.toContain(secret)
    expect(credential).toBeDefined()
    expect(() => Redacted.value(credential!)).toThrow()
  }),
)

it.effect("rejects the wrong key, AAD substitutions, and tampering without exposing plaintext", () =>
  Effect.gen(function* () {
    const secret = "never-expose-provider-secret"
    const source = encrypted(secret)
    const tampered = { ...source, ciphertext: source.ciphertext.slice() }
    tampered.ciphertext[0] = (tampered.ciphertext[0] ?? 0) ^ 1
    const cases = [
      withCipher(
        (cipher) => Effect.flip(cipher.decrypt(source)),
        Redacted.make(Encoding.encodeBase64(new Uint8Array(32).fill(18))),
      ),
      withCipher((cipher) => Effect.flip(cipher.decrypt({ ...source, ownerId: "owner-2" }))),
      withCipher((cipher) => Effect.flip(cipher.decrypt({ ...source, provider: "anthropic" }))),
      withCipher((cipher) => Effect.flip(cipher.decrypt(tampered))),
    ]
    const failures = yield* Effect.all(cases)
    expect(failures).toHaveLength(4)
    for (const error of failures) {
      expect(error).toMatchObject({
        _tag: "ProviderCredentialCipherError",
        reason: "authentication-failed",
      })
      const rendered = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(error)
      expect(`${rendered}\n${Inspectable.toStringUnknown(error)}`).not.toContain(secret)
    }
  }),
)

it.effect("rejects invalid keys and encryption material with typed secret-free errors", () =>
  Effect.gen(function* () {
    const secret = "invalid-material-secret"
    const invalidKeys = [Redacted.make("not-base64"), Redacted.make(Encoding.encodeBase64(new Uint8Array(31)))]
    for (const configuredKey of invalidKeys) {
      const result = yield* Effect.result(Effect.scoped(makeProviderCredentialCipher({ encodedKey: configuredKey })))
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ProviderCredentialCipherError", reason: "invalid-key" },
      })
      expect(Inspectable.toStringUnknown(result)).not.toContain(Redacted.value(configuredKey))
    }
    const source = encrypted(secret)
    for (const material of [
      { ...source, keyVersion: 2 },
      { ...source, nonce: new Uint8Array(11) },
      { ...source, ciphertext: new Uint8Array() },
      { ...source, authenticationTag: new Uint8Array(15) },
    ]) {
      const error = yield* withCipher((cipher) => Effect.flip(cipher.decrypt(material)))
      expect(error).toMatchObject({ _tag: "ProviderCredentialCipherError", reason: "invalid-material" })
      expect(Inspectable.toStringUnknown(error)).not.toContain(secret)
    }
  }),
)

it.effect("wipes the scoped key and returned credential handles", () =>
  Effect.gen(function* () {
    const source = encrypted("scope-secret")
    const zeroKeySource = encrypted("zero-key-secret", "owner-1", "openai", new Uint8Array(32))
    let escapedCipher: ProviderCredentialCipher | undefined
    let escapedCredential: Redacted.Redacted<string> | undefined
    yield* Effect.scoped(
      Effect.gen(function* () {
        escapedCipher = yield* makeProviderCredentialCipher({ encodedKey })
        escapedCredential = yield* escapedCipher.decrypt(source)
        expect(decoder.decode(encoder.encode(Redacted.value(escapedCredential)))).toBe("scope-secret")
      }),
    )
    expect(() => Redacted.value(escapedCredential!)).toThrow()
    const afterRelease = yield* Effect.result(Effect.scoped(escapedCipher!.decrypt(zeroKeySource)))
    expect(afterRelease).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ProviderCredentialCipherError", reason: "authentication-failed" },
    })
  }),
)
