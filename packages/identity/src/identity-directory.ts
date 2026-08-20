import { Effect, Schema } from "effect"

export class IdentityDirectoryError extends Schema.TaggedError<IdentityDirectoryError>()("IdentityDirectoryError", {
  operation: Schema.String,
}) {}

export interface AccountUser {
  readonly id: string
  readonly name: string
  readonly email: string
  readonly emailVerified: boolean
  readonly image: string | null
}

export interface OrganizationMembership {
  readonly id: string
  readonly role: string
  readonly createdAt: string
  readonly organization: {
    readonly id: string
    readonly name: string
    readonly slug: string
    readonly logo: string | null
  }
}

export interface Account {
  readonly user: AccountUser
  readonly memberships: ReadonlyArray<OrganizationMembership>
}

export interface IdentityDirectory {
  readonly ready: Effect.Effect<void, IdentityDirectoryError>
  readonly account: (userId: string) => Effect.Effect<Account | undefined, IdentityDirectoryError>
}
