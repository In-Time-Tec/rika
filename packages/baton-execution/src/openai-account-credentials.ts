import { OpenAi } from "tenetkit/ai"
import type * as OpenAiAuthContract from "@rika/product/openai-auth-contract"
import type * as OpenAiAuth from "@rika/product/openai-auth-service"
import { Effect, Function, Redacted } from "effect"

const adapt = (
  operation: "acquire" | "refreshRejected",
  expectedFingerprint: string,
  effect: Effect.Effect<OpenAiAuthContract.Credential, OpenAiAuthContract.AuthError | OpenAiAuthContract.StoreError>,
) =>
  effect.pipe(
    Effect.filterOrFail(
      (credential) => credential.fingerprint === expectedFingerprint,
      () => OpenAi.OpenAiAccountCredentialError.make({ operation }),
    ),
    Effect.map((credential) => ({
      accessToken: credential.accessToken,
      accountId: Redacted.value(credential.accountId),
      generation: credential.generation,
    })),
    Effect.mapError(() => OpenAi.OpenAiAccountCredentialError.make({ operation })),
  )

const fromRikaAuthImpl = (
  auth: OpenAiAuth.ServiceInterface,
  expectedFingerprint: string,
): OpenAi.OpenAiAccountCredentials => ({
  acquire: adapt("acquire", expectedFingerprint, auth.acquire),
  refreshRejected: (generation) => adapt("refreshRejected", expectedFingerprint, auth.refreshRejected(generation)),
})

export const fromRikaAuth: {
  (expectedFingerprint: string): (auth: OpenAiAuth.ServiceInterface) => OpenAi.OpenAiAccountCredentials
  (auth: OpenAiAuth.ServiceInterface, expectedFingerprint: string): OpenAi.OpenAiAccountCredentials
} = Function.dual(2, fromRikaAuthImpl)
