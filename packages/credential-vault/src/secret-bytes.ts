import { Effect, Redacted, Scope } from "effect"

export type Plaintext = Redacted.Redacted<Uint8Array>
export type DataEncryptionKey = Redacted.Redacted<Uint8Array>

const wipe = (secret: Redacted.Redacted<Uint8Array>, bytes: Uint8Array) =>
  Effect.sync(() => {
    bytes.fill(0)
    Redacted.wipeUnsafe(secret)
  })

const scopedSecretBytes = (bytes: Uint8Array, label: string) =>
  Effect.acquireRelease(
    Effect.sync(() => Redacted.make(bytes, { label })),
    (secret) => wipe(secret, bytes),
  )

export const plaintext = (bytes: Uint8Array): Plaintext => Redacted.make(bytes, { label: "credential-plaintext" })

export const scopedPlaintext = (bytes: Uint8Array): Effect.Effect<Plaintext, never, Scope.Scope> =>
  scopedSecretBytes(bytes, "credential-plaintext")

export const scopedDataEncryptionKey = (bytes: Uint8Array): Effect.Effect<DataEncryptionKey, never, Scope.Scope> =>
  scopedSecretBytes(bytes, "data-encryption-key")

export const registerSecretBytes = (secret: Redacted.Redacted<Uint8Array>): Effect.Effect<void, never, Scope.Scope> => {
  const bytes = Redacted.value(secret)
  return Effect.addFinalizer(() => wipe(secret, bytes))
}
