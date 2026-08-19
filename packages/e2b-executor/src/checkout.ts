import { Clock, Context, Effect, Layer, Redacted, Schema } from "effect"
import type { RepositoryCheckout } from "@rika/product/executor-assignment"

export interface Token {
  readonly token: Redacted.Redacted<string>
  readonly expiresAt: number
}

export interface Credential {
  readonly repositoryUrl: string
  readonly username: "x-access-token"
  readonly token: Redacted.Redacted<string>
  readonly expiresAt: number
}

export class CredentialError extends Schema.TaggedError<CredentialError>()("CredentialError", {
  message: Schema.String,
}) {}

export interface InstallationTokensInterface {
  readonly issue: (input: {
    readonly installationId: string
    readonly owner: string
    readonly repository: string
  }) => Effect.Effect<Token, CredentialError>
}

export class InstallationTokens extends Context.Service<InstallationTokens, InstallationTokensInterface>()(
  "@rika/e2b-executor/checkout/InstallationTokens",
) {}

export interface Interface {
  readonly issue: (repository: RepositoryCheckout) => Effect.Effect<Credential, CredentialError>
}

export class Credentials extends Context.Service<Credentials, Interface>()("@rika/e2b-executor/checkout/Credentials") {}

const maximumTokenLifetimeMillis = 60 * 60 * 1_000

export const layer: Layer.Layer<Credentials, never, InstallationTokens> = Layer.effect(
  Credentials,
  Effect.gen(function* () {
    const source = yield* InstallationTokens
    return Credentials.of({
      issue: Effect.fn("Credentials.issue")(function* (repository) {
        const now = yield* Clock.currentTimeMillis
        const credential = yield* source.issue({
          installationId: repository.installationId,
          owner: repository.owner,
          repository: repository.name,
        })
        if (credential.expiresAt <= now || credential.expiresAt > now + maximumTokenLifetimeMillis)
          return yield* CredentialError.make({ message: "GitHub App installation token lifetime is invalid" })
        return {
          repositoryUrl: `https://github.com/${repository.owner}/${repository.name}.git`,
          username: "x-access-token",
          token: credential.token,
          expiresAt: credential.expiresAt,
        }
      }),
    })
  }),
)
