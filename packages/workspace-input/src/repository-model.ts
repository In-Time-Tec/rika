import { Schema } from "effect"
import { Archive } from "./contract"

const strict = <S extends Schema.Top>(schema: S) => schema.annotate({ parseOptions: { onExcessProperty: "error" } })

export const RepositoryInputFormat = "git-bare-shallow-v1" as const

export const RepositoryCommitSha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))
export type RepositoryCommitSha = typeof RepositoryCommitSha.Type

export const GitHubRepositorySource = strict(
  Schema.Struct({
    owner: Schema.String.check(Schema.isPattern(/^(?!-)(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/)),
    name: Schema.String.check(Schema.isPattern(/^(?!\.{1,2}$)(?!.*\.git$)[A-Za-z0-9_.-]{1,100}$/i)),
  }),
)
export type GitHubRepositorySource = typeof GitHubRepositorySource.Type

export const RepositoryGitIdentity = strict(
  Schema.Struct({
    name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256), Schema.isPattern(/^[^\0\r\n]+$/)),
    email: Schema.String.check(Schema.isMaxLength(320), Schema.isPattern(/^[^\s@\0\r\n]+@[^\s@\0\r\n]+$/)),
  }),
)
export type RepositoryGitIdentity = typeof RepositoryGitIdentity.Type

export const RepositoryInputMetadata = strict(
  Schema.Struct({
    version: Schema.Literal(1),
    source: GitHubRepositorySource,
    commitSha: RepositoryCommitSha,
    gitIdentity: RepositoryGitIdentity,
  }),
)
export type RepositoryInputMetadata = typeof RepositoryInputMetadata.Type

export const RepositoryInput = strict(
  Schema.Struct({
    format: Schema.Literal(RepositoryInputFormat),
    metadata: RepositoryInputMetadata,
    archive: strict(Archive),
  }),
)
export type RepositoryInput = typeof RepositoryInput.Type

export class RepositoryInputError extends Schema.TaggedError<RepositoryInputError>()("RepositoryInputError", {
  kind: Schema.Literals(["archive", "git", "input", "size", "workspace"]),
  message: Schema.String,
}) {}
