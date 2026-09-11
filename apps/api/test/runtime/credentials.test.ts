import type { ProviderCredentialCipher, ProviderEncryptedCredential } from "@rika/credential-vault/provider"
import { ProviderCredentialCipherError } from "@rika/credential-vault/provider"
import type { CredentialRecord, ProviderCredentialOperations } from "@rika/product-store/provider-credentials"
import { ProviderCredentialsError } from "@rika/product-store/provider-credentials"
import { Effect, Inspectable, Redacted, Ref } from "effect"
import { expect, it } from "@effect/vitest"
import type { ModelRegistry } from "generalist"
import { makeModelCredentialAccess } from "../../src/runtime/credentials"

const selection = { provider: "openai", model: "gpt-6-astra", registrationKey: "owner-route" }
const reference = { provider: "openai", reference: "credential://provider-credential-1" }

const record = (overrides: Partial<CredentialRecord> = {}): CredentialRecord => ({
  credentialIdentity: "provider-credential-1",
  ownerId: "owner-1",
  provider: "openai",
  status: "active",
  revision: "1",
  keyVersion: 1,
  nonce: new Uint8Array(12).fill(1),
  ciphertext: Uint8Array.of(1),
  authenticationTag: new Uint8Array(16).fill(2),
  ...overrides,
})

const makeCipher = (decrypted: Array<ProviderEncryptedCredential>): ProviderCredentialCipher => ({
  decrypt: (input) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        decrypted.push(input)
        return Redacted.make(`secret-${input.ciphertext[0]}`)
      }),
      (credential) =>
        Effect.sync(() => {
          Redacted.wipeUnsafe(credential)
        }),
    ),
})

const makeStore = (
  load: (identity: string) => Effect.Effect<CredentialRecord | undefined, never>,
): Pick<ProviderCredentialOperations, "credentialByIdentity"> => ({ credentialByIdentity: load })

const allow = (_selection: ModelRegistry.ModelSelection) => Effect.succeed(true)
const noRecord = (): CredentialRecord | undefined => undefined

it.effect("authorizes before resolving a credential reference", () =>
  Effect.gen(function* () {
    const lookups = yield* Ref.make(0)
    const decrypted: Array<ProviderEncryptedCredential> = []
    const access = makeModelCredentialAccess({
      credentials: makeStore(() => Ref.update(lookups, (count) => count + 1).pipe(Effect.as(record()))),
      cipher: makeCipher(decrypted),
      authorize: () => Effect.succeed(false),
    })
    const result = yield* Effect.result(Effect.scoped(access.resolve({ ownerId: "owner-1", selection, reference })))
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "RikaApiV2ModelCredentialResolutionError", reason: "revoked" },
    })
    expect(yield* Ref.get(lookups)).toBe(0)
    expect(decrypted).toEqual([])
  }),
)

it.effect("rejects owner, provider, and reference substitutions before decryption", () =>
  Effect.gen(function* () {
    const cases = [
      {
        input: { ownerId: "owner-2", selection, reference },
        stored: record(),
      },
      {
        input: { ownerId: "owner-1", selection, reference: { ...reference, provider: "anthropic" } },
        stored: record(),
      },
      {
        input: { ownerId: "owner-1", selection, reference },
        stored: record({ credentialIdentity: "provider-credential-other" }),
      },
      {
        input: { ownerId: "owner-1", selection, reference: { ...reference, reference: "https://credentials/1" } },
        stored: record(),
      },
    ]
    for (const testCase of cases) {
      const decrypted: Array<ProviderEncryptedCredential> = []
      const access = makeModelCredentialAccess({
        credentials: makeStore(() => Effect.succeed(testCase.stored)),
        cipher: makeCipher(decrypted),
        authorize: allow,
      })
      const result = yield* Effect.result(Effect.scoped(access.resolve(testCase.input)))
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "RikaApiV2ModelCredentialResolutionError", reason: "missing" },
      })
      expect(decrypted).toEqual([])
    }
  }),
)

it.effect("reloads rotated and revoked credentials on every resolution", () =>
  Effect.gen(function* () {
    let current = record()
    let lookups = 0
    const decrypted: Array<ProviderEncryptedCredential> = []
    const access = makeModelCredentialAccess({
      credentials: makeStore(() =>
        Effect.sync(() => {
          lookups += 1
          return current
        }),
      ),
      cipher: makeCipher(decrypted),
      authorize: allow,
    })
    const first = yield* Effect.scoped(
      access.resolve({ ownerId: "owner-1", selection, reference }).pipe(Effect.map(Redacted.value)),
    )
    current = record({ revision: "2", ciphertext: Uint8Array.of(2) })
    const second = yield* Effect.scoped(
      access.resolve({ ownerId: "owner-1", selection, reference }).pipe(Effect.map(Redacted.value)),
    )
    current = record({
      status: "revoked",
      revision: "3",
      keyVersion: null,
      nonce: null,
      ciphertext: null,
      authenticationTag: null,
    })
    const revoked = yield* Effect.result(Effect.scoped(access.resolve({ ownerId: "owner-1", selection, reference })))
    expect([first, second]).toEqual(["secret-1", "secret-2"])
    expect(decrypted.map((input) => input.ciphertext[0])).toEqual([1, 2])
    expect(revoked).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "RikaApiV2ModelCredentialResolutionError", reason: "revoked" },
    })
    expect(lookups).toBe(3)
  }),
)

it.effect("reports corrupt material and cipher failures without exposing secrets", () =>
  Effect.gen(function* () {
    const decrypted: Array<ProviderEncryptedCredential> = []
    const malformed = makeModelCredentialAccess({
      credentials: makeStore(() => Effect.succeed(record({ nonce: new Uint8Array(11) }))),
      cipher: makeCipher(decrypted),
      authorize: allow,
    })
    const malformedResult = yield* Effect.result(
      Effect.scoped(malformed.resolve({ ownerId: "owner-1", selection, reference })),
    )
    expect(malformedResult).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "RikaApiV2ModelCredentialResolutionError", reason: "corrupt" },
    })
    expect(decrypted).toEqual([])

    const secret = "cipher-private-provider-secret"
    const failingCipher: ProviderCredentialCipher = {
      decrypt: () =>
        Effect.fail(
          ProviderCredentialCipherError.make({
            reason: "authentication-failed",
            message: "Provider credential could not be decrypted",
          }),
        ),
    }
    const access = makeModelCredentialAccess({
      credentials: makeStore(() => Effect.succeed(record())),
      cipher: failingCipher,
      authorize: allow,
    })
    const result = yield* Effect.result(Effect.scoped(access.resolve({ ownerId: "owner-1", selection, reference })))
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "RikaApiV2ModelCredentialResolutionError", reason: "corrupt" },
    })
    expect(Inspectable.toStringUnknown(result)).not.toContain(secret)
  }),
)

it.effect("maps missing records and repository failures to safe typed errors", () =>
  Effect.gen(function* () {
    const decrypted: Array<ProviderEncryptedCredential> = []
    const missing = makeModelCredentialAccess({
      credentials: makeStore(() => Effect.succeed(noRecord())),
      cipher: makeCipher(decrypted),
      authorize: allow,
    })
    const unavailable = makeModelCredentialAccess({
      credentials: {
        credentialByIdentity: () => Effect.fail(ProviderCredentialsError.make({ kind: "database", message: "failed" })),
      },
      cipher: makeCipher(decrypted),
      authorize: allow,
    })
    const results = yield* Effect.all([
      Effect.result(Effect.scoped(missing.resolve({ ownerId: "owner-1", selection, reference }))),
      Effect.result(Effect.scoped(unavailable.resolve({ ownerId: "owner-1", selection, reference }))),
    ])
    expect(results).toMatchObject([
      { _tag: "Failure", failure: { reason: "missing" } },
      { _tag: "Failure", failure: { reason: "unavailable" } },
    ])
    expect(decrypted).toEqual([])
  }),
)
