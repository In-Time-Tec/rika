import { Artifact } from "../media/media-view-contract"
import { Schema } from "effect"
import { WorkspaceListEntry } from "./workspace-list-result"
import { WorkspaceSearchMatch, WorkspaceSearchMatchesTruncation } from "./workspace-search-result"

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
