import { Schema } from "effect"

export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("WorkspaceError", {
  phase: Schema.Literals(["checkout", "setup", "resume", "capabilities"]),
  message: Schema.String,
  retryable: Schema.Boolean,
}) {}
