import { Schema } from "effect"

export class RunnerWorkspaceError extends Schema.TaggedError<RunnerWorkspaceError>()("RikaRunnerV2WorkspaceError", {
  kind: Schema.Literals(["binding", "path", "not_found", "output", "operation"]),
  message: Schema.String,
}) {}

export class RunnerGrepError extends Schema.TaggedError<RunnerGrepError>()("RikaRunnerV2GrepError", {
  kind: Schema.Literals(["path", "not_found", "operation"]),
  message: Schema.String,
}) {}
