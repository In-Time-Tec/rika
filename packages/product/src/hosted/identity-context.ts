import { Schema } from "effect"

export const Account = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.String,
})
export type Account = typeof Account.Type

export const Organization = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  name: Schema.String,
  logo: Schema.NullOr(Schema.String),
})
export type Organization = typeof Organization.Type

const strict = <S extends Schema.Top>(schema: S) => schema.annotate({ parseOptions: { onExcessProperty: "error" } })

export const ProjectOwner = Schema.Union([
  strict(Schema.Struct({ kind: Schema.Literal("personal"), userId: Schema.String })),
  strict(Schema.Struct({ kind: Schema.Literal("organization"), organizationId: Schema.String })),
])
export type ProjectOwner = typeof ProjectOwner.Type

export const Project = Schema.Struct({
  id: Schema.String,
  ownerId: Schema.String,
  owner: ProjectOwner,
  slug: Schema.String,
  name: Schema.String,
})
export type Project = typeof Project.Type

export const IdentityContext = Schema.Struct({
  account: Account,
  organizations: Schema.Array(Organization),
  projects: Schema.Array(Project),
})
export type IdentityContext = typeof IdentityContext.Type
