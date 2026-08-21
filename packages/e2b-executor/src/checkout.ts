import type { RepositoryCheckout } from "@rika/product/executor-assignment"
import type { Access } from "@rika/product/executor-assignments"
import { Context, Effect, Redacted, Schema } from "effect"

export const CredentialPurpose = Schema.Literals(["git-read", "github-read"])
export type CredentialPurpose = typeof CredentialPurpose.Type

export interface Credential {
  readonly repositoryUrl: string
  readonly username: "x-access-token"
  readonly token: Redacted.Redacted<string>
  readonly expiresAt: number
}

export interface CredentialRequest {
  readonly access: Access
  readonly checkout: RepositoryCheckout
  readonly ownerId: string
  readonly workspaceId: string
  readonly repositoryId: string
  readonly purpose: CredentialPurpose
}

export class CredentialError extends Schema.TaggedError<CredentialError>()("CredentialError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly issue: (request: CredentialRequest) => Effect.Effect<Credential, CredentialError>
  readonly revoke: (access: Access, purpose: CredentialPurpose) => Effect.Effect<void, CredentialError>
}

export class Credentials extends Context.Service<Credentials, Interface>()("@rika/e2b-executor/checkout/Credentials") {}
