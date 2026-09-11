import type { ProviderCredentialCipher } from "@rika/credential-vault/provider"
import type { ProviderCredentialOperations, CredentialRecord } from "@rika/product-store/provider-credentials"
import { Effect } from "effect"
import type { ModelRegistry } from "generalist"
import { ModelCredentialResolutionError, type ModelCredentialAccess } from "./models"

export interface ModelCredentialAccessOptions {
  readonly credentials: Pick<ProviderCredentialOperations, "credentialByIdentity">
  readonly cipher: ProviderCredentialCipher
  readonly authorize: (
    selection: ModelRegistry.ModelSelection,
  ) => Effect.Effect<boolean, ModelCredentialResolutionError>
}

const failure = (reason: ModelCredentialResolutionError["reason"], message: string) =>
  ModelCredentialResolutionError.make({ reason, message })

const missing = () => failure("missing", "Model credential is unavailable")
const revoked = () => failure("revoked", "Model credential is revoked")
const corrupt = () => failure("corrupt", "Model credential is corrupt")
const unavailable = () => failure("unavailable", "Model credential service is unavailable")

const referencePrefix = "credential://"
const credentialIdentity = (reference: string) => {
  if (!reference.startsWith(referencePrefix)) return undefined
  const identity = reference.slice(referencePrefix.length)
  return identity.length !== 0 && /^[A-Za-z0-9._:/-]+$/.test(identity) ? identity : undefined
}

const validMaterial = (
  record: CredentialRecord,
): record is CredentialRecord & {
  readonly keyVersion: number
  readonly nonce: Uint8Array
  readonly ciphertext: Uint8Array
  readonly authenticationTag: Uint8Array
} =>
  record.keyVersion === 1 &&
  record.nonce !== null &&
  record.nonce.length === 12 &&
  record.ciphertext !== null &&
  record.ciphertext.length > 0 &&
  record.authenticationTag !== null &&
  record.authenticationTag.length === 16

export const makeModelCredentialAccess = (options: ModelCredentialAccessOptions): ModelCredentialAccess => ({
  resolve: (input) =>
    Effect.gen(function* () {
      if (!(yield* options.authorize(input.selection))) return yield* revoked()
      if (input.ownerId.length === 0 || input.reference.provider !== input.selection.provider) return yield* missing()
      const identity = credentialIdentity(input.reference.reference)
      if (identity === undefined) return yield* missing()
      const record = yield* options.credentials.credentialByIdentity(identity).pipe(Effect.mapError(unavailable))
      if (
        record === undefined ||
        record.credentialIdentity !== identity ||
        record.ownerId !== input.ownerId ||
        record.provider !== input.selection.provider
      )
        return yield* missing()
      if (record.status === "revoked") return yield* revoked()
      if (!validMaterial(record)) return yield* corrupt()
      return yield* options.cipher
        .decrypt({
          ownerId: record.ownerId,
          provider: record.provider,
          keyVersion: record.keyVersion,
          nonce: record.nonce,
          ciphertext: record.ciphertext,
          authenticationTag: record.authenticationTag,
        })
        .pipe(Effect.mapError(corrupt))
    }),
})
