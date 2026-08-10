import { Artifact } from "../media/media-view-contract"
import { Schema } from "effect"

export interface WorkspaceListFile {
  readonly name: string
  readonly kind: "file"
}

export interface WorkspaceListDirectory {
  readonly name: string
  readonly kind: "directory"
  readonly entries: ReadonlyArray<WorkspaceListEntry>
}

export type WorkspaceListEntry = WorkspaceListFile | WorkspaceListDirectory

export interface WorkspaceSearchMatch {
  readonly path: string
  readonly line: number
  readonly text: string
}

export const WorkspaceSearchMatch = Schema.Struct({
  path: Schema.String,
  line: Schema.Int.check(Schema.isGreaterThan(0)),
  text: Schema.String,
})

export const WorkspaceSearchMatchesTruncation = Schema.Struct({
  kept: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})

export const WorkspaceListEntry: Schema.Codec<WorkspaceListEntry> = Schema.Union([
  Schema.Struct({ name: Schema.String, kind: Schema.Literal("file") }),
  Schema.Struct({
    name: Schema.String,
    kind: Schema.Literal("directory"),
    entries: Schema.Array(Schema.suspend((): Schema.Codec<WorkspaceListEntry> => WorkspaceListEntry)),
  }),
])

export const maxOutputBytes = 16_384

export const Result = Schema.Struct({
  text: Schema.String,
  truncated: Schema.Boolean,
  entries: Schema.optionalKey(Schema.Array(WorkspaceListEntry)),
  matches: Schema.optionalKey(Schema.Array(WorkspaceSearchMatch)),
  matchesTruncation: Schema.optionalKey(WorkspaceSearchMatchesTruncation),
  running: Schema.optionalKey(Schema.Boolean),
  processId: Schema.optionalKey(Schema.String),
  exitCode: Schema.optionalKey(Schema.Finite),
  elapsedMillis: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  stdout: Schema.optionalKey(Schema.String),
  stderr: Schema.optionalKey(Schema.String),
  diff: Schema.optionalKey(Schema.String),
  artifact: Schema.optionalKey(Artifact),
})
export type Result = typeof Result.Type

export const FailureCategory = Schema.Literals([
  "invalid_input",
  "not_found",
  "conflict",
  "access_denied",
  "dependency_unavailable",
  "rate_limited",
  "timeout",
  "operation",
])
export type FailureCategory = typeof FailureCategory.Type

export const Recovery = Schema.Literals(["never", "after_change", "later"])
export type Recovery = typeof Recovery.Type

export const ToolFailure = Schema.Struct({
  _tag: Schema.tag("ToolError"),
  tool: Schema.String,
  message: Schema.String,
  kind: Schema.Literals(["operation", "timeout"]),
  category: FailureCategory,
  outcome: Schema.Literals(["known", "unknown"]),
  recovery: Recovery,
  nextAction: Schema.String,
})
