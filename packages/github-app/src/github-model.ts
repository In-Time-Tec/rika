import { Function, Schema } from "effect"

export const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
export type PositiveInt = typeof PositiveInt.Type

export const GitHubAccountType = Schema.Literals(["User", "Organization", "Enterprise"])
export type GitHubAccountType = typeof GitHubAccountType.Type

export const GitHubAccount = Schema.Struct({
  id: PositiveInt,
  login: Schema.NonEmptyString,
  type: GitHubAccountType,
})
export type GitHubAccount = typeof GitHubAccount.Type

export const Repository = Schema.Struct({
  id: PositiveInt,
  name: Schema.NonEmptyString,
  full_name: Schema.NonEmptyString,
  private: Schema.Boolean,
  archived: Schema.Boolean,
  html_url: Schema.NonEmptyString,
  owner: GitHubAccount,
})
export type Repository = typeof Repository.Type

export const PermissionLevel = Schema.Literals(["read", "write"])
export type PermissionLevel = typeof PermissionLevel.Type

export const Permissions = Schema.Record(Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]*$/)), PermissionLevel)
export type Permissions = typeof Permissions.Type

export const Installation = Schema.Struct({
  id: PositiveInt,
  app_id: PositiveInt,
  account: GitHubAccount,
  repository_selection: Schema.Literals(["all", "selected"]),
  permissions: Permissions,
  suspended_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
export type Installation = typeof Installation.Type

export const RepositoryIds = Schema.Array(PositiveInt).check(Schema.isMinLength(1), Schema.isMaxLength(500))
export type RepositoryIds = typeof RepositoryIds.Type

export const sameAccount: {
  (right: GitHubAccount): (left: GitHubAccount) => boolean
  (left: GitHubAccount, right: GitHubAccount): boolean
} = Function.dual(
  2,
  (left: GitHubAccount, right: GitHubAccount) =>
    left.id === right.id && left.login.toLowerCase() === right.login.toLowerCase() && left.type === right.type,
)
