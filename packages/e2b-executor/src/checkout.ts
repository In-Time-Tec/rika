import type { RepositoryCheckout } from "@rika/product/executor-assignment"
import type { Access } from "@rika/product/executor-assignments"
import { Context, Effect, Redacted, Schema } from "effect"

export const CredentialPurpose = Schema.Literals(["git-read", "github-read", "branch-push"])
export type CredentialPurpose = typeof CredentialPurpose.Type

export interface Credential {
  readonly repositoryUrl: string
  readonly username: "x-access-token"
  readonly token: Redacted.Redacted<string>
  readonly expiresAt: number
}

interface CredentialRequestBase {
  readonly access: Access
  readonly checkout: RepositoryCheckout
  readonly ownerId: string
  readonly workspaceId: string
  readonly repositoryId: string
}

export type CredentialRequest = CredentialRequestBase &
  (
    | { readonly purpose: "git-read" | "github-read" }
    | {
        readonly purpose: "branch-push"
        readonly publicationId: string
        readonly branch: string
        readonly ref: string
        readonly commitSha: string
      }
  )

export class CredentialError extends Schema.TaggedError<CredentialError>()("CredentialError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly issue: (request: CredentialRequest) => Effect.Effect<Credential, CredentialError>
  readonly revoke: (
    access: Access,
    purpose: CredentialPurpose,
    publicationId?: string,
  ) => Effect.Effect<void, CredentialError>
}

export class Credentials extends Context.Service<Credentials, Interface>()("@rika/e2b-executor/checkout/Credentials") {}
