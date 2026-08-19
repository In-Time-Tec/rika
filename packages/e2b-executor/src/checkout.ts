import { Clock, Context, Effect, Layer, Redacted, Schema } from "effect"
import type { AssignmentRequest, CheckoutCredential } from "./contract"

export interface InstallationToken {
  readonly token: Redacted.Redacted<string>
  readonly expiresAt: number
}

export class CheckoutError extends Schema.TaggedError<CheckoutError>()("CheckoutError", {
  message: Schema.String,
}) {}

export interface GitHubAppTokenSourceInterface {
  readonly issue: (input: {
    readonly installationId: string
    readonly owner: string
    readonly repository: string
  }) => Effect.Effect<InstallationToken, CheckoutError>
}

export class GitHubAppTokenSource extends Context.Service<GitHubAppTokenSource, GitHubAppTokenSourceInterface>()(
  "@rika/e2b-executor/checkout/GitHubAppTokenSource",
) {}

export interface Interface {
  readonly issue: (repository: AssignmentRequest["repository"]) => Effect.Effect<CheckoutCredential, CheckoutError>
}

export class CheckoutCredentialBroker extends Context.Service<CheckoutCredentialBroker, Interface>()(
  "@rika/e2b-executor/checkout/CheckoutCredentialBroker",
) {}

const maximumTokenLifetimeMillis = 60 * 60 * 1_000

export const layer: Layer.Layer<CheckoutCredentialBroker, never, GitHubAppTokenSource> = Layer.effect(
  CheckoutCredentialBroker,
  Effect.gen(function* () {
    const source = yield* GitHubAppTokenSource
    return CheckoutCredentialBroker.of({
      issue: Effect.fn("CheckoutCredentialBroker.issue")(function* (repository) {
        const now = yield* Clock.currentTimeMillis
        const credential = yield* source.issue({
          installationId: repository.installationId,
          owner: repository.owner,
          repository: repository.name,
        })
        if (credential.expiresAt <= now || credential.expiresAt > now + maximumTokenLifetimeMillis)
          return yield* CheckoutError.make({ message: "GitHub App installation token lifetime is invalid" })
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
