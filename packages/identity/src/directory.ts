import { Effect, Schema } from "effect"

export class IdentityDirectoryError extends Schema.TaggedError<IdentityDirectoryError>()("IdentityDirectoryError", {
  operation: Schema.String,
}) {}

export const AccountUser = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  email: Schema.String,
  emailVerified: Schema.Boolean,
  image: Schema.NullOr(Schema.String),
})
export type AccountUser = typeof AccountUser.Type

export const OrganizationMembership = Schema.Struct({
  id: Schema.String,
  role: Schema.String,
  createdAt: Schema.String,
  organization: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    slug: Schema.String,
    logo: Schema.NullOr(Schema.String),
  }),
})
export type OrganizationMembership = typeof OrganizationMembership.Type

export const Account = Schema.Struct({
  user: AccountUser,
  memberships: Schema.Array(OrganizationMembership),
})
export type Account = typeof Account.Type

export interface IdentityDirectory {
  readonly ready: Effect.Effect<void, IdentityDirectoryError>
  readonly account: (userId: string) => Effect.Effect<Account | undefined, IdentityDirectoryError>
}
