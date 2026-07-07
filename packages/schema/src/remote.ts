import { Schema } from "effect"
import { Kind as ArtifactKind } from "./artifact"
import { JsonValue, TimestampMillis } from "./common"
import {
  Event,
  ThreadVisibility as EventThreadVisibility,
  ThreadVisibilityDefaulted as EventThreadVisibilityDefaulted,
  type ThreadVisibility as EventThreadVisibilityType,
} from "./event"
import { ContextSnapshot as IdeContextSnapshot } from "./ide"
import { ArtifactId, OrbId, ProjectId, ThreadId, TurnId, UserId, WorkspaceId } from "./ids"
import { ContentPart } from "./message"
import { OrbStatus } from "./orb"
import { TurnToolAccess } from "./tool"

export const BackendStatus = Schema.Literals(["healthy", "starting", "stale", "disconnected", "remote"]).annotate({
  identifier: "Rika.Remote.BackendStatus",
})
export type BackendStatus = typeof BackendStatus.Type

export interface BackendHealth extends Schema.Schema.Type<typeof BackendHealth> {}
export const BackendHealth = Schema.Struct({
  status: BackendStatus,
  url: Schema.String,
  workspace_root: Schema.String,
  data_dir: Schema.String,
  backend_id: Schema.String,
  pid: Schema.optional(Schema.Int),
  version: Schema.String,
}).annotate({ identifier: "Rika.Remote.BackendHealth" })

export interface PublicBackendHealth extends Schema.Schema.Type<typeof PublicBackendHealth> {}
export const PublicBackendHealth = Schema.Struct({
  status: Schema.Literal("ok"),
}).annotate({ identifier: "Rika.Remote.PublicBackendHealth" })

export const AgentMode = Schema.Literals(["rush", "smart", "deep1", "deep2", "deep3"]).annotate({
  identifier: "Rika.Remote.AgentMode",
})
export type AgentMode = typeof AgentMode.Type

export const TurnStatus = Schema.Literals(["active", "completed", "failed"]).annotate({
  identifier: "Rika.Remote.TurnStatus",
})
export type TurnStatus = typeof TurnStatus.Type

export const PresenceState = Schema.Literals(["active", "typing"]).annotate({
  identifier: "Rika.Remote.PresenceState",
})
export type PresenceState = typeof PresenceState.Type

export const ThreadVisibility = EventThreadVisibility.annotate({ identifier: "Rika.Remote.ThreadVisibility" })
export type ThreadVisibility = EventThreadVisibilityType

export interface ThreadDiffStats extends Schema.Schema.Type<typeof ThreadDiffStats> {}
export const ThreadDiffStats = Schema.Struct({
  additions: Schema.Int,
  modifications: Schema.Int,
  deletions: Schema.Int,
}).annotate({ identifier: "Rika.Remote.ThreadDiffStats" })

export interface ThreadSummary extends Schema.Schema.Type<typeof ThreadSummary> {}
export const ThreadSummary = Schema.Struct({
  thread_id: ThreadId,
  workspace_id: WorkspaceId,
  user_id: Schema.optional(UserId),
  last_user_id: Schema.optional(UserId),
  title_text: Schema.optional(Schema.String),
  latest_message_text: Schema.optional(Schema.String),
  diff: ThreadDiffStats,
  active_turn_id: Schema.optional(TurnId),
  active_turn_status: Schema.optional(TurnStatus),
  context_tokens: Schema.optional(Schema.Int),
  context_window: Schema.optional(Schema.Int),
  orb_status: Schema.optional(OrbStatus),
  archived: Schema.Boolean,
  visibility: EventThreadVisibilityDefaulted,
  created_at: TimestampMillis,
  updated_at: TimestampMillis,
}).annotate({ identifier: "Rika.Remote.ThreadSummary" })

export interface ThreadRecord extends Schema.Schema.Type<typeof ThreadRecord> {}
export const ThreadRecord = Schema.Struct({
  summary: ThreadSummary,
  events: Schema.Array(Event),
}).annotate({ identifier: "Rika.Remote.ThreadRecord" })

export interface CreateThreadRequest extends Schema.Schema.Type<typeof CreateThreadRequest> {}
export const CreateThreadRequest = Schema.Struct({
  thread_id: Schema.optional(ThreadId),
  workspace_id: Schema.optional(WorkspaceId),
  project_id: Schema.optional(ProjectId),
  user_id: Schema.optional(UserId),
}).annotate({ identifier: "Rika.Remote.CreateThreadRequest" })

export interface CreateOrbThreadRequest extends Schema.Schema.Type<typeof CreateOrbThreadRequest> {}
export const CreateOrbThreadRequest = Schema.Struct({
  project_id: ProjectId,
  thread_id: Schema.optional(ThreadId),
  mode: Schema.optional(AgentMode),
}).annotate({ identifier: "Rika.Remote.CreateOrbThreadRequest" })

export interface CreateProjectRequest extends Schema.Schema.Type<typeof CreateProjectRequest> {}
export const CreateProjectRequest = Schema.Struct({
  name: Schema.String,
  repo_origin: Schema.String,
  default_branch: Schema.optional(Schema.String),
  template_id: Schema.optional(Schema.NullOr(Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}).annotate({ identifier: "Rika.Remote.CreateProjectRequest" })

export interface ProjectSummary extends Schema.Schema.Type<typeof ProjectSummary> {}
export const ProjectSummary = Schema.Struct({
  project_id: ProjectId,
  name: Schema.String,
  repo_origin: Schema.String,
  default_branch: Schema.String,
  template_id: Schema.NullOr(Schema.String),
  env_keys: Schema.Array(Schema.String),
  secret_names: Schema.Array(Schema.String),
  created_at: TimestampMillis,
  updated_at: TimestampMillis,
}).annotate({ identifier: "Rika.Remote.ProjectSummary" })

export interface ProjectDetail extends Schema.Schema.Type<typeof ProjectDetail> {}
export const ProjectDetail = Schema.Struct({
  project_id: ProjectId,
  name: Schema.String,
  repo_origin: Schema.String,
  default_branch: Schema.String,
  template_id: Schema.NullOr(Schema.String),
  env: Schema.Record(Schema.String, Schema.String),
  secret_names: Schema.Array(Schema.String),
  created_at: TimestampMillis,
  updated_at: TimestampMillis,
}).annotate({ identifier: "Rika.Remote.ProjectDetail" })

export interface UpdateProjectRequest extends Schema.Schema.Type<typeof UpdateProjectRequest> {}
export const UpdateProjectRequest = Schema.Struct({
  name: Schema.optional(Schema.String),
  repo_origin: Schema.optional(Schema.String),
  default_branch: Schema.optional(Schema.String),
  template_id: Schema.optional(Schema.NullOr(Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}).annotate({ identifier: "Rika.Remote.UpdateProjectRequest" })

export interface SetProjectSecretRequest extends Schema.Schema.Type<typeof SetProjectSecretRequest> {}
export const SetProjectSecretRequest = Schema.Struct({
  value: Schema.String,
}).annotate({ identifier: "Rika.Remote.SetProjectSecretRequest" })

export interface ListThreadsRequest extends Schema.Schema.Type<typeof ListThreadsRequest> {}
export const ListThreadsRequest = Schema.Struct({
  include_archived: Schema.optional(Schema.Boolean),
  workspace_id: Schema.optional(WorkspaceId),
  user_id: Schema.optional(UserId),
  limit: Schema.optional(Schema.Int),
}).annotate({ identifier: "Rika.Remote.ListThreadsRequest" })

export interface OpenThreadRequest extends Schema.Schema.Type<typeof OpenThreadRequest> {}
export const OpenThreadRequest = Schema.Struct({
  thread_id: ThreadId,
  user_id: Schema.optional(UserId),
}).annotate({ identifier: "Rika.Remote.OpenThreadRequest" })

export interface PreviewThreadRequest extends Schema.Schema.Type<typeof PreviewThreadRequest> {}
export const PreviewThreadRequest = Schema.Struct({
  thread_id: ThreadId,
  user_id: Schema.optional(UserId),
  limit: Schema.optional(Schema.Int),
}).annotate({ identifier: "Rika.Remote.PreviewThreadRequest" })

export interface ArchiveThreadRequest extends Schema.Schema.Type<typeof ArchiveThreadRequest> {}
export const ArchiveThreadRequest = Schema.Struct({
  thread_id: ThreadId,
  user_id: Schema.optional(UserId),
}).annotate({ identifier: "Rika.Remote.ArchiveThreadRequest" })

export interface SetThreadVisibilityBody extends Schema.Schema.Type<typeof SetThreadVisibilityBody> {}
export const SetThreadVisibilityBody = Schema.Struct({
  visibility: ThreadVisibility,
}).annotate({ identifier: "Rika.Remote.SetThreadVisibilityBody" })

export interface SetThreadVisibilityRequest extends Schema.Schema.Type<typeof SetThreadVisibilityRequest> {}
export const SetThreadVisibilityRequest = Schema.Struct({
  thread_id: ThreadId,
  user_id: Schema.optional(UserId),
  visibility: ThreadVisibility,
}).annotate({ identifier: "Rika.Remote.SetThreadVisibilityRequest" })

export interface CompactThreadRequest extends Schema.Schema.Type<typeof CompactThreadRequest> {}
export const CompactThreadRequest = Schema.Struct({
  thread_id: ThreadId,
  user_id: Schema.optional(UserId),
}).annotate({ identifier: "Rika.Remote.CompactThreadRequest" })

export interface ForkThreadRequest extends Schema.Schema.Type<typeof ForkThreadRequest> {}
export const ForkThreadRequest = Schema.Struct({
  thread_id: ThreadId,
  at_turn: Schema.optional(TurnId),
  user_id: Schema.optional(UserId),
  title_text: Schema.optional(Schema.String),
}).annotate({ identifier: "Rika.Remote.ForkThreadRequest" })

export interface SearchThreadsRequest extends Schema.Schema.Type<typeof SearchThreadsRequest> {}
export const SearchThreadsRequest = Schema.Struct({
  query: Schema.optional(Schema.String),
  include_archived: Schema.optional(Schema.Boolean),
  workspace_id: Schema.optional(WorkspaceId),
  user_id: Schema.optional(UserId),
  after: Schema.optional(TimestampMillis),
  before: Schema.optional(TimestampMillis),
  limit: Schema.optional(Schema.Int),
}).annotate({ identifier: "Rika.Remote.SearchThreadsRequest" })

export interface ThreadSearchResult extends Schema.Schema.Type<typeof ThreadSearchResult> {}
export const ThreadSearchResult = Schema.Struct({
  summary: ThreadSummary,
  score: Schema.Int,
  matched: Schema.Array(Schema.String),
}).annotate({ identifier: "Rika.Remote.ThreadSearchResult" })

export interface ShareThreadRequest extends Schema.Schema.Type<typeof ShareThreadRequest> {}
export const ShareThreadRequest = Schema.Struct({
  thread_id: ThreadId,
  user_id: Schema.optional(UserId),
}).annotate({ identifier: "Rika.Remote.ShareThreadRequest" })

export interface ThreadExport extends Schema.Schema.Type<typeof ThreadExport> {}
export const ThreadExport = Schema.Struct({
  schema_version: Schema.Literal(1),
  exported_at: TimestampMillis,
  thread_id: ThreadId,
  summary: ThreadSummary,
  events: Schema.Array(Event),
}).annotate({ identifier: "Rika.Remote.ThreadExport" })

export interface ReferenceThreadRequest extends Schema.Schema.Type<typeof ReferenceThreadRequest> {}
export const ReferenceThreadRequest = Schema.Struct({
  thread_id: ThreadId,
  user_id: Schema.optional(UserId),
  query: Schema.optional(Schema.String),
  max_chars: Schema.optional(Schema.Int),
}).annotate({ identifier: "Rika.Remote.ReferenceThreadRequest" })

export interface ThreadReference extends Schema.Schema.Type<typeof ThreadReference> {}
export const ThreadReference = Schema.Struct({
  thread_id: ThreadId,
  rendered: Schema.String,
  entries: Schema.Array(Schema.String),
  total_chars: Schema.Int,
  truncated: Schema.Boolean,
}).annotate({ identifier: "Rika.Remote.ThreadReference" })

export interface SubscribeThreadEventsRequest extends Schema.Schema.Type<typeof SubscribeThreadEventsRequest> {}
export const SubscribeThreadEventsRequest = Schema.Struct({
  thread_id: ThreadId,
  user_id: Schema.optional(UserId),
  after_sequence: Schema.optional(Schema.Int),
}).annotate({ identifier: "Rika.Remote.SubscribeThreadEventsRequest" })

export interface PresenceUser extends Schema.Schema.Type<typeof PresenceUser> {}
export const PresenceUser = Schema.Struct({
  user_id: UserId,
  state: PresenceState,
  last_seen: TimestampMillis,
}).annotate({ identifier: "Rika.Remote.PresenceUser" })

export interface PresencePayload extends Schema.Schema.Type<typeof PresencePayload> {}
export const PresencePayload = Schema.Struct({
  thread_id: ThreadId,
  users: Schema.Array(PresenceUser),
}).annotate({ identifier: "Rika.Remote.PresencePayload" })

export interface PresenceFrame extends Schema.Schema.Type<typeof PresenceFrame> {}
export const PresenceFrame = Schema.Struct({
  presence: PresencePayload,
}).annotate({ identifier: "Rika.Remote.PresenceFrame" })

export interface PresenceRequest extends Schema.Schema.Type<typeof PresenceRequest> {}
export const PresenceRequest = Schema.Struct({
  user_id: UserId,
  state: PresenceState,
}).annotate({ identifier: "Rika.Remote.PresenceRequest" })

export interface SetThreadPresenceRequest extends Schema.Schema.Type<typeof SetThreadPresenceRequest> {}
export const SetThreadPresenceRequest = Schema.Struct({
  thread_id: ThreadId,
  user_id: UserId,
  state: PresenceState,
}).annotate({ identifier: "Rika.Remote.SetThreadPresenceRequest" })

export interface StartTurnRequest extends Schema.Schema.Type<typeof StartTurnRequest> {}
export const StartTurnRequest = Schema.Struct({
  thread_id: ThreadId,
  workspace_id: Schema.optional(WorkspaceId),
  project_id: Schema.optional(ProjectId),
  user_id: Schema.optional(UserId),
  content: Schema.String,
  content_parts: Schema.optional(Schema.Array(ContentPart)),
  mode: Schema.optional(AgentMode),
  fast_mode: Schema.optional(Schema.Boolean),
  cancelled: Schema.optional(Schema.Boolean),
  ide_context: Schema.optional(IdeContextSnapshot),
  tool_access: Schema.optional(TurnToolAccess),
}).annotate({ identifier: "Rika.Remote.StartTurnRequest" })

export interface StartTurnResponse extends Schema.Schema.Type<typeof StartTurnResponse> {}
export const StartTurnResponse = Schema.Struct({
  thread_id: ThreadId,
  accepted: Schema.Literal(true),
}).annotate({ identifier: "Rika.Remote.StartTurnResponse" })

export interface InterruptTurnRequest extends Schema.Schema.Type<typeof InterruptTurnRequest> {}
export const InterruptTurnRequest = Schema.Struct({
  thread_id: ThreadId,
  turn_id: TurnId,
  user_id: Schema.optional(UserId),
  reason: Schema.optional(Schema.String),
}).annotate({ identifier: "Rika.Remote.InterruptTurnRequest" })

export interface OrbChangesResponse extends Schema.Schema.Type<typeof OrbChangesResponse> {}
export const OrbChangesResponse = Schema.Struct({
  base_commit: Schema.String,
  head_commit: Schema.String,
  diff: Schema.String,
  dirty: Schema.Boolean,
}).annotate({ identifier: "Rika.Remote.OrbChangesResponse" })

export const OrbFileKind = Schema.Literals(["file", "dir"])
export type OrbFileKind = typeof OrbFileKind.Type

export interface OrbFileEntry extends Schema.Schema.Type<typeof OrbFileEntry> {}
export const OrbFileEntry = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  kind: OrbFileKind,
  size: Schema.optional(Schema.Int),
}).annotate({ identifier: "Rika.Remote.OrbFileEntry" })

export interface OrbFilesResponse extends Schema.Schema.Type<typeof OrbFilesResponse> {}
export const OrbFilesResponse = Schema.Struct({
  path: Schema.String,
  entries: Schema.Array(OrbFileEntry),
}).annotate({ identifier: "Rika.Remote.OrbFilesResponse" })

export interface OrbTextFileResponse extends Schema.Schema.Type<typeof OrbTextFileResponse> {}
export const OrbTextFileResponse = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literal("text"),
  content: Schema.String,
  truncated: Schema.Boolean,
}).annotate({ identifier: "Rika.Remote.OrbTextFileResponse" })

export interface OrbBinaryFileResponse extends Schema.Schema.Type<typeof OrbBinaryFileResponse> {}
export const OrbBinaryFileResponse = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literal("binary"),
  binary: Schema.Literal(true),
}).annotate({ identifier: "Rika.Remote.OrbBinaryFileResponse" })

export const OrbFileResponse = Schema.Union([OrbTextFileResponse, OrbBinaryFileResponse]).annotate({
  identifier: "Rika.Remote.OrbFileResponse",
})
export type OrbFileResponse = typeof OrbFileResponse.Type

export interface OrbSummary extends Schema.Schema.Type<typeof OrbSummary> {}
export const OrbSummary = Schema.Struct({
  orb_id: OrbId,
  thread_id: ThreadId,
  project_id: ProjectId,
  status: OrbStatus,
  base_commit: Schema.NullOr(Schema.String),
  created_at: TimestampMillis,
  last_active_at: TimestampMillis,
  running_minutes: Schema.Number,
}).annotate({ identifier: "Rika.Remote.OrbSummary" })

export interface ListArtifactsRequest extends Schema.Schema.Type<typeof ListArtifactsRequest> {}
export const ListArtifactsRequest = Schema.Struct({
  thread_id: ThreadId,
  user_id: Schema.optional(UserId),
  kind: Schema.optional(ArtifactKind),
  limit: Schema.optional(Schema.Int),
}).annotate({ identifier: "Rika.Remote.ListArtifactsRequest" })

export interface GetArtifactRequest extends Schema.Schema.Type<typeof GetArtifactRequest> {}
export const GetArtifactRequest = Schema.Struct({
  artifact_id: ArtifactId,
  user_id: Schema.optional(UserId),
}).annotate({ identifier: "Rika.Remote.GetArtifactRequest" })

export interface ApiError extends Schema.Schema.Type<typeof ApiError> {}
export const ApiError = Schema.Struct({
  error: Schema.Struct({
    message: Schema.String,
    code: Schema.String,
    details: Schema.optional(JsonValue),
  }),
}).annotate({ identifier: "Rika.Remote.ApiError" })

export const StreamFrame = Schema.Union([Event, PresenceFrame, ApiError]).annotate({
  identifier: "Rika.Remote.StreamFrame",
})
export type StreamFrame = typeof StreamFrame.Type
