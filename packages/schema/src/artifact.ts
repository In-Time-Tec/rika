import { Schema } from "effect"
import { JsonValue, Metadata, TimestampMillis } from "./common"
import { ArtifactId, ThreadId, TurnId, WorkspaceId } from "./ids"

export const Kind = Schema.Literals([
  "patch",
  "image",
  "research",
  "review",
  "verdict",
  "file",
  "orb-final-diff",
  "other",
]).annotate({
  identifier: "Rika.ArtifactKind",
})
export type Kind = typeof Kind.Type

export interface Artifact extends Schema.Schema.Type<typeof Artifact> {}
export const Artifact = Schema.Struct({
  id: ArtifactId,
  thread_id: ThreadId,
  workspace_id: Schema.optional(WorkspaceId),
  turn_id: Schema.optional(TurnId),
  kind: Kind,
  title: Schema.optional(Schema.String),
  content: JsonValue,
  created_at: TimestampMillis,
  metadata: Schema.optional(Metadata),
}).annotate({ identifier: "Rika.Artifact" })
