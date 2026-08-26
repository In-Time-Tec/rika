import { describe, expect, it } from "@effect/vitest"
import { Effect, Encoding, Function, Inspectable, Layer, Logger, Redacted, Result, Schema } from "effect"
import type { CredentialKmsEncryptionContext } from "../src/aad"
import { CredentialCipher } from "../src/cipher"
import {
  CredentialAuthTag,
  CredentialBinding,
  CredentialCiphertext,
  CredentialId,
  CredentialOrganizationId,
  CredentialOwner,
  CredentialProvider,
  CredentialRevision,
  CredentialUserId,
  type EncryptedCredential,
} from "../src/model"
import { CredentialVault, layer as credentialVaultLayer } from "../src/vault"
import { KmsDataKey, KmsFailure, type KmsDataKeyContract } from "../src/kms/data-key"
import { nobleAes256GcmLayer } from "../src/crypto/aes-256-gcm"
import { plaintext, scopedDataEncryptionKey, scopedPlaintext } from "../src/secret-bytes"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const userBinding = CredentialBinding.make({
  credentialId: CredentialId.make("credential-1"),
  owner: CredentialOwner.make({ _tag: "User", id: CredentialUserId.make("user-1") }),
  provider: CredentialProvider.make("anthropic"),
  revision: CredentialRevision.make(1),
})

const organizationBinding = CredentialBinding.make({
  credentialId: CredentialId.make("credential-2"),
  owner: CredentialOwner.make({
    _tag: "Organization",
    id: CredentialOrganizationId.make("organization-1"),
  }),
  provider: CredentialProvider.make("openai"),
  revision: CredentialRevision.make(7),
})

const sameContext = (left: CredentialKmsEncryptionContext, right: CredentialKmsEncryptionContext) =>
  left.credentialId === right.credentialId &&
  left.ownerType === right.ownerType &&
  left.ownerId === right.ownerId &&
  left.provider === right.provider &&
  left.revision === right.revision &&
  left.version === right.version

interface FakeKmsControl {
  failGenerate: boolean
  failDecrypt: boolean
  readonly generatedContexts: Array<CredentialKmsEncryptionContext>
  readonly decryptedContexts: Array<CredentialKmsEncryptionContext>
  readonly exposedKeys: Array<Uint8Array>
}

const makeFakeKms = () => {
  const control: FakeKmsControl = {
    failGenerate: false,
    failDecrypt: false,
    generatedContexts: [],
    decryptedContexts: [],
    exposedKeys: [],
  }
  const entries = new Map<string, { readonly key: Uint8Array; readonly context: CredentialKmsEncryptionContext }>()
  let sequence = 0
  const generateDataKey: KmsDataKeyContract["generateDataKey"] = Effect.fn("FakeKms.generateDataKey")(
    function* (context, use) {
      if (control.failGenerate) return yield* KmsFailure.make({ operation: "GenerateDataKey", reason: "RequestFailed" })
      sequence += 1
      const wrapped = Uint8Array.of(82, 75, sequence)
      const stored = new Uint8Array(32).fill(sequence)
      const exposed = stored.slice()
      control.generatedContexts.push({ ...context })
      control.exposedKeys.push(exposed)
      entries.set(Encoding.encodeBase64(wrapped), { key: stored, context: { ...context } })
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const key = yield* scopedDataEncryptionKey(exposed)
          return yield* use({ plaintext: key, wrapped })
        }),
      )
    },
  )
  const decryptDataKey: KmsDataKeyContract["decryptDataKey"] = Effect.fn("FakeKms.decryptDataKey")(
    function* (wrapped, context, use) {
      control.decryptedContexts.push({ ...context })
      const entry = entries.get(Encoding.encodeBase64(wrapped))
      if (control.failDecrypt || entry === undefined || !sameContext(entry.context, context)) {
        return yield* KmsFailure.make({ operation: "Decrypt", reason: "RequestFailed" })
      }
      const exposed = entry.key.slice()
      control.exposedKeys.push(exposed)
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const key = yield* scopedDataEncryptionKey(exposed)
          return yield* use(key)
        }),
      )
    },
  )
  return { control, layer: Layer.succeed(KmsDataKey, KmsDataKey.of({ generateDataKey, decryptDataKey })) }
}

const vaultLayer = (kms: Layer.Layer<KmsDataKey>) =>
  credentialVaultLayer.pipe(Layer.provide(Layer.merge(kms, nobleAes256GcmLayer)))

const provideLayer: {
  <RIn, E2, ROut>(
    layer: Layer.Layer<ROut, E2, RIn>,
  ): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | E2, RIn | Exclude<R, ROut>>
  <A, E, R, RIn, E2, ROut>(
    effect: Effect.Effect<A, E, R>,
    layer: Layer.Layer<ROut, E2, RIn>,
  ): Effect.Effect<A, E | E2, RIn | Exclude<R, ROut>>
} = Function.dual(2, <A, E, R, RIn, E2, ROut>(effect: Effect.Effect<A, E, R>, layer: Layer.Layer<ROut, E2, RIn>) =>
  Effect.scoped(Effect.flatMap(Layer.build(layer), (context) => Effect.provide(effect, context))),
)

const encrypt = (vault: CredentialVault["Service"], binding: CredentialBinding, secret: string) =>
  vault.encrypt({ binding, plaintext: plaintext(encoder.encode(secret)), createdAt: 1_000 })

const tamperBase64 = (encoded: string) => {
  const bytes = Result.getOrThrow(Encoding.decodeBase64(encoded))
  bytes[0] = (bytes[0] ?? 0) ^ 1
  return Encoding.encodeBase64(bytes)
}

describe("credential vault", () => {
  it.effect("round-trips user and organization credentials with bound KMS context", () => {
    const fake = makeFakeKms()
    return Effect.gen(function* () {
      const vault = yield* CredentialVault
      for (const [binding, secret] of [
        [userBinding, "user-provider-secret"],
        [organizationBinding, "organization-provider-secret"],
      ] as const) {
        const sourceBytes = encoder.encode(secret)
        const source = plaintext(sourceBytes)
        const credential = yield* vault.encrypt({ binding, plaintext: source, createdAt: 1_000 })
        expect(credential.metadata).toEqual({ binding, createdAt: 1_000, state: { _tag: "Active" } })
        expect(credential.material.algorithm).toBe("AES-256-GCM")
        expect(credential.material.keyEncryption).toBe("AWS-KMS")
        expect(credential.material.aadVersion).toBe(1)
        expect([...sourceBytes]).toEqual(new Array(sourceBytes.length).fill(0))
        expect(() => Redacted.value(source)).toThrow()
        let decryptedBytes: Uint8Array | undefined
        let decryptedSecret: ReturnType<typeof plaintext> | undefined
        const value = yield* vault.decrypt({ credential, binding }, (decrypted) =>
          Effect.sync(() => {
            decryptedSecret = decrypted
            decryptedBytes = Redacted.value(decrypted)
            return decoder.decode(decryptedBytes)
          }),
        )
        expect(value).toBe(secret)
        expect(decryptedBytes).toBeDefined()
        expect([...(decryptedBytes ?? [])]).toEqual(new Array(secret.length).fill(0))
        expect(() => Redacted.value(decryptedSecret!)).toThrow()
      }
      expect(fake.control.generatedContexts).toEqual([
        {
          credentialId: "credential-1",
          ownerType: "user",
          ownerId: "user-1",
          provider: "anthropic",
          revision: "1",
          version: "1",
        },
        {
          credentialId: "credential-2",
          ownerType: "organization",
          ownerId: "organization-1",
          provider: "openai",
          revision: "7",
          version: "1",
        },
      ])
      expect(fake.control.decryptedContexts).toEqual(fake.control.generatedContexts)
      expect(fake.control.exposedKeys.every((key) => key.every((byte) => byte === 0))).toBe(true)
    }).pipe(provideLayer(vaultLayer(fake.layer)))
  })

  it.effect("rejects the wrong AES additional authenticated data", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cipher = yield* CredentialCipher
        const key = yield* scopedDataEncryptionKey(new Uint8Array(32).fill(19))
        const source = yield* scopedPlaintext(encoder.encode("aad-bound-secret"))
        const encrypted = yield* cipher.encrypt({
          key,
          plaintext: source,
          additionalAuthenticatedData: encoder.encode("credential-aad-1"),
        })
        const error = yield* Effect.flip(
          cipher.decrypt({ key, encrypted, additionalAuthenticatedData: encoder.encode("credential-aad-2") }, () =>
            Effect.succeed("unexpected"),
          ),
        )
        expect(error).toMatchObject({
          _tag: "CredentialCipherFailure",
          operation: "Decrypt",
          reason: "AuthenticationFailed",
        })
      }),
    ).pipe(provideLayer(nobleAes256GcmLayer)),
  )

  it.effect("rejects mismatched expected owner, provider, and revision metadata before decryption", () => {
    const fake = makeFakeKms()
    return Effect.gen(function* () {
      const vault = yield* CredentialVault
      const credential = yield* encrypt(vault, userBinding, "metadata-secret")
      const cases = [
        [
          "owner",
          CredentialBinding.make({
            ...userBinding,
            owner: CredentialOwner.make({
              _tag: "Organization",
              id: CredentialOrganizationId.make("organization-1"),
            }),
          }),
        ],
        ["provider", CredentialBinding.make({ ...userBinding, provider: CredentialProvider.make("openai") })],
        ["revision", CredentialBinding.make({ ...userBinding, revision: CredentialRevision.make(2) })],
      ] as const
      for (const [field, binding] of cases) {
        const error = yield* Effect.flip(vault.decrypt({ credential, binding }, () => Effect.succeed("unexpected")))
        expect(error).toMatchObject({ _tag: "CredentialBindingMismatch", field })
      }
      expect(fake.control.decryptedContexts).toEqual([])
    }).pipe(provideLayer(vaultLayer(fake.layer)))
  })

  it.effect("cryptographically rejects substituted owner, provider, and revision metadata", () => {
    const fake = makeFakeKms()
    return Effect.gen(function* () {
      const vault = yield* CredentialVault
      const original = yield* encrypt(vault, userBinding, "substitution-secret")
      const substitutions = [
        CredentialBinding.make({
          ...userBinding,
          owner: CredentialOwner.make({
            _tag: "Organization",
            id: CredentialOrganizationId.make("organization-1"),
          }),
        }),
        CredentialBinding.make({ ...userBinding, provider: CredentialProvider.make("openai") }),
        CredentialBinding.make({ ...userBinding, revision: CredentialRevision.make(2) }),
      ]
      for (const binding of substitutions) {
        const credential: EncryptedCredential = {
          ...original,
          metadata: { ...original.metadata, binding },
        }
        const error = yield* Effect.flip(vault.decrypt({ credential, binding }, () => Effect.succeed("unexpected")))
        expect(error).toMatchObject({
          _tag: "CredentialKmsFailure",
          operation: "Decrypt",
          reason: "RequestFailed",
        })
      }
    }).pipe(provideLayer(vaultLayer(fake.layer)))
  })

  it.effect("rejects ciphertext and authentication tag tampering", () => {
    const fake = makeFakeKms()
    return Effect.gen(function* () {
      const vault = yield* CredentialVault
      const original = yield* encrypt(vault, userBinding, "tamper-secret")
      const credentials = [
        {
          ...original,
          material: {
            ...original.material,
            ciphertext: CredentialCiphertext.make(tamperBase64(original.material.ciphertext)),
          },
        },
        {
          ...original,
          material: {
            ...original.material,
            authTag: CredentialAuthTag.make(tamperBase64(original.material.authTag)),
          },
        },
      ] satisfies ReadonlyArray<EncryptedCredential>
      for (const credential of credentials) {
        const error = yield* Effect.flip(vault.decrypt({ credential, binding: userBinding }, () => Effect.void))
        expect(error).toMatchObject({
          _tag: "CredentialCipherFailure",
          operation: "Decrypt",
          reason: "AuthenticationFailed",
        })
      }
    }).pipe(provideLayer(vaultLayer(fake.layer)))
  })

  it.effect("returns a typed KMS failure and wipes plaintext when GenerateDataKey fails", () => {
    const fake = makeFakeKms()
    fake.control.failGenerate = true
    const sourceBytes = encoder.encode("generate-failure-secret")
    const source = plaintext(sourceBytes)
    return Effect.gen(function* () {
      const vault = yield* CredentialVault
      const error = yield* Effect.flip(vault.encrypt({ binding: userBinding, plaintext: source, createdAt: 1_000 }))
      expect(error).toMatchObject({
        _tag: "CredentialKmsFailure",
        operation: "GenerateDataKey",
        reason: "RequestFailed",
      })
      expect([...sourceBytes]).toEqual(new Array(sourceBytes.length).fill(0))
      expect(() => Redacted.value(source)).toThrow()
    }).pipe(provideLayer(vaultLayer(fake.layer)))
  })

  it.effect("returns a typed KMS failure when wrapped-key decryption fails", () => {
    const fake = makeFakeKms()
    return Effect.gen(function* () {
      const vault = yield* CredentialVault
      const credential = yield* encrypt(vault, userBinding, "decrypt-failure-secret")
      fake.control.failDecrypt = true
      const error = yield* Effect.flip(
        vault.decrypt({ credential, binding: userBinding }, () => Effect.succeed("unexpected")),
      )
      expect(error).toMatchObject({
        _tag: "CredentialKmsFailure",
        operation: "Decrypt",
        reason: "RequestFailed",
      })
    }).pipe(provideLayer(vaultLayer(fake.layer)))
  })

  it.effect("rotates to a fresh DEK and revision while revoking the predecessor", () => {
    const fake = makeFakeKms()
    return Effect.gen(function* () {
      const vault = yield* CredentialVault
      const credential = yield* encrypt(vault, userBinding, "rotation-secret")
      const rotation = yield* vault.rotate({ credential, binding: userBinding, rotatedAt: 2_000 })
      expect(rotation.previous.metadata.state).toEqual({
        _tag: "Revoked",
        revokedAt: 2_000,
        reason: "Rotated",
        successorRevision: 2,
      })
      expect(rotation.current.metadata.binding.revision).toBe(2)
      expect(rotation.current.metadata.createdAt).toBe(2_000)
      expect(rotation.current.material.wrappedDataEncryptionKey).not.toBe(credential.material.wrappedDataEncryptionKey)
      const value = yield* vault.decrypt(
        { credential: rotation.current, binding: rotation.current.metadata.binding },
        (decrypted) => Effect.succeed(decoder.decode(Redacted.value(decrypted))),
      )
      expect(value).toBe("rotation-secret")
      const predecessorError = yield* Effect.flip(
        vault.decrypt({ credential: rotation.previous, binding: userBinding }, () => Effect.void),
      )
      expect(predecessorError).toMatchObject({
        _tag: "CredentialRevoked",
        credentialId: "credential-1",
        revision: 1,
        revokedAt: 2_000,
      })
      expect(fake.control.generatedContexts.map((context) => context.revision)).toEqual(["1", "2"])
    }).pipe(provideLayer(vaultLayer(fake.layer)))
  })

  it.effect("denies decryption, rotation, and repeated revocation after manual revocation", () => {
    const fake = makeFakeKms()
    return Effect.gen(function* () {
      const vault = yield* CredentialVault
      const credential = yield* encrypt(vault, userBinding, "revoked-secret")
      const revoked = yield* vault.revoke({ credential, binding: userBinding, revokedAt: 3_000 })
      expect(revoked.metadata.state).toEqual({ _tag: "Revoked", revokedAt: 3_000, reason: "Manual" })
      const failures = yield* Effect.all([
        Effect.flip(vault.decrypt({ credential: revoked, binding: userBinding }, () => Effect.void)),
        Effect.flip(vault.rotate({ credential: revoked, binding: userBinding, rotatedAt: 4_000 })),
        Effect.flip(vault.revoke({ credential: revoked, binding: userBinding, revokedAt: 4_000 })),
      ])
      expect(failures.map((failure) => failure._tag)).toEqual([
        "CredentialRevoked",
        "CredentialRevoked",
        "CredentialRevoked",
      ])
      expect(fake.control.decryptedContexts).toEqual([])
    }).pipe(provideLayer(vaultLayer(fake.layer)))
  })

  it.effect("redacts plaintext from inspect, JSON, captured logs, and captured failures", () => {
    const fake = makeFakeKms()
    fake.control.failGenerate = true
    const secret = "never-render-this-provider-key"
    const source = plaintext(encoder.encode(secret))
    const logs: Array<string> = []
    const logger = Logger.make(({ message }) => {
      logs.push(Inspectable.toStringUnknown(message))
    })
    return Effect.gen(function* () {
      const vault = yield* CredentialVault
      const json = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(source)
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          yield* Effect.logError("credential input", source)
          return yield* vault.encrypt({ binding: userBinding, plaintext: source, createdAt: 1_000 })
        }),
      )
      const rendered = [
        String(source),
        json,
        Inspectable.toStringUnknown(source),
        Inspectable.toStringUnknown(exit),
        ...logs,
      ].join("\n")
      expect(rendered).toContain("<redacted:credential-plaintext>")
      expect(rendered).not.toContain(secret)
      expect(Inspectable.toStringUnknown(exit)).toContain("CredentialKmsFailure")
    }).pipe(provideLayer(Layer.merge(vaultLayer(fake.layer), Logger.layer([logger]))))
  })
})
