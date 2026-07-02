import { Schema } from "effect"
import { TimestampMillis } from "./common"
import { OrbId, ProjectId, ThreadId } from "./ids"

export const OrbStatus = Schema.Literals(["provisioning", "running", "paused", "archived", "killed"]).annotate({
  identifier: "Rika.OrbStatus",
})
export type OrbStatus = typeof OrbStatus.Type

export interface OrbRecord extends Schema.Schema.Type<typeof OrbRecord> {}
export const OrbRecord = Schema.Struct({
  orb_id: OrbId,
  thread_id: ThreadId,
  project_id: ProjectId,
  sandbox_id: Schema.String,
  status: OrbStatus,
  base_commit: Schema.String,
  endpoint_url: Schema.String,
  created_at: TimestampMillis,
  last_active_at: TimestampMillis,
}).annotate({ identifier: "Rika.OrbRecord" })

export interface ProjectRecord extends Schema.Schema.Type<typeof ProjectRecord> {}
export const ProjectRecord = Schema.Struct({
  project_id: ProjectId,
  name: Schema.String,
  repo_origin: Schema.String,
  default_branch: Schema.String,
  template_id: Schema.NullOr(Schema.String),
  env: Schema.Record(Schema.String, Schema.String),
  secret_names: Schema.Array(Schema.String),
  created_at: TimestampMillis,
  updated_at: TimestampMillis,
}).annotate({ identifier: "Rika.ProjectRecord" })
