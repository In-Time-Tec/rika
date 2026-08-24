import { DecryptCommand, GenerateDataKeyCommand, KMSClient, type KMSClientConfig } from "@aws-sdk/client-kms"
import { Effect, Layer } from "effect"
import type { CredentialKmsEncryptionContext } from "../aad"
import { KmsDataKey, KmsFailure, type KmsDataKeyShape } from "./data-key"
import { scopedDataEncryptionKey } from "../secret-bytes"

export interface AwsKmsOptions {
  readonly keyId: string
  readonly clientConfig?: KMSClientConfig
}

const failure = (operation: "GenerateDataKey" | "Decrypt", reason: "RequestFailed" | "InvalidResponse") =>
  KmsFailure.make({ operation, reason })

export const awsKmsLayer = (options: AwsKmsOptions) =>
  Layer.effect(
    KmsDataKey,
    Effect.gen(function* () {
      const client = yield* Effect.acquireRelease(
        Effect.sync(() => new KMSClient(options.clientConfig ?? {})),
        (kms) => Effect.sync(() => kms.destroy()),
      )
      const generateDataKey: KmsDataKeyShape["generateDataKey"] = Effect.fn("AwsKms.generateDataKey")(function* (
        context: CredentialKmsEncryptionContext,
        use,
      ) {
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const response = yield* Effect.tryPromise({
              try: (signal) =>
                client.send(
                  new GenerateDataKeyCommand({
                    KeyId: options.keyId,
                    KeySpec: "AES_256",
                    EncryptionContext: { ...context },
                  }),
                  { abortSignal: signal },
                ),
              catch: () => failure("GenerateDataKey", "RequestFailed"),
            })
            const plaintext = response.Plaintext
            const wrapped = response.CiphertextBlob
            if (plaintext === undefined || plaintext.length !== 32 || wrapped === undefined || wrapped.length === 0) {
              plaintext?.fill(0)
              return yield* failure("GenerateDataKey", "InvalidResponse")
            }
            const key = yield* scopedDataEncryptionKey(plaintext)
            return yield* use({ plaintext: key, wrapped: wrapped.slice() })
          }),
        )
      })
      const decryptDataKey: KmsDataKeyShape["decryptDataKey"] = Effect.fn("AwsKms.decryptDataKey")(function* (
        wrapped: Uint8Array,
        context: CredentialKmsEncryptionContext,
        use,
      ) {
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const response = yield* Effect.tryPromise({
              try: (signal) =>
                client.send(
                  new DecryptCommand({
                    KeyId: options.keyId,
                    CiphertextBlob: wrapped.slice(),
                    EncryptionContext: { ...context },
                    EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
                  }),
                  { abortSignal: signal },
                ),
              catch: () => failure("Decrypt", "RequestFailed"),
            })
            const plaintext = response.Plaintext
            if (plaintext === undefined || plaintext.length !== 32) {
              plaintext?.fill(0)
              return yield* failure("Decrypt", "InvalidResponse")
            }
            const key = yield* scopedDataEncryptionKey(plaintext)
            return yield* use(key)
          }),
        )
      })
      return KmsDataKey.of({ generateDataKey, decryptDataKey })
    }),
  )
