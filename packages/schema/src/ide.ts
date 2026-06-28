import { Schema } from "effect"
import { LineRange } from "./common"
import { IdeClientId, ThreadId } from "./ids"

export const Capability = Schema.Literals(["active-context", "diagnostics", "navigation"]).annotate({
  identifier: "Rika.Ide.Capability",
})
export type Capability = typeof Capability.Type

export const DiagnosticSeverity = Schema.Literals(["error", "warning", "information", "hint"]).annotate({
  identifier: "Rika.Ide.DiagnosticSeverity",
})
export type DiagnosticSeverity = typeof DiagnosticSeverity.Type

export interface Selection extends Schema.Schema.Type<typeof Selection> {}
export const Selection = Schema.Struct({
  range: LineRange,
  selected_text: Schema.optional(Schema.String),
}).annotate({ identifier: "Rika.Ide.Selection" })

export interface ActiveFile extends Schema.Schema.Type<typeof ActiveFile> {}
export const ActiveFile = Schema.Struct({
  path: Schema.String,
  language_id: Schema.optional(Schema.String),
  selection: Schema.optional(Selection),
}).annotate({ identifier: "Rika.Ide.ActiveFile" })

export interface Diagnostic extends Schema.Schema.Type<typeof Diagnostic> {}
export const Diagnostic = Schema.Struct({
  path: Schema.String,
  severity: DiagnosticSeverity,
  message: Schema.String,
  range: Schema.optional(LineRange),
  source: Schema.optional(Schema.String),
}).annotate({ identifier: "Rika.Ide.Diagnostic" })

export interface ContextSnapshot extends Schema.Schema.Type<typeof ContextSnapshot> {}
export const ContextSnapshot = Schema.Struct({
  workspace_roots: Schema.Array(Schema.String),
  active_file: Schema.optional(ActiveFile),
  diagnostics: Schema.optional(Schema.Array(Diagnostic)),
}).annotate({ identifier: "Rika.Ide.ContextSnapshot" })

export interface ConnectRequest extends Schema.Schema.Type<typeof ConnectRequest> {}
export const ConnectRequest = Schema.Struct({
  client_id: IdeClientId,
  name: Schema.optional(Schema.String),
  workspace_roots: Schema.Array(Schema.String),
  capabilities: Schema.Array(Capability),
  initial_context: Schema.optional(ContextSnapshot),
}).annotate({ identifier: "Rika.Ide.ConnectRequest" })

export interface ConnectResponse extends Schema.Schema.Type<typeof ConnectResponse> {}
export const ConnectResponse = Schema.Struct({
  client_id: IdeClientId,
  connected: Schema.Boolean,
  capabilities: Schema.Array(Capability),
}).annotate({ identifier: "Rika.Ide.ConnectResponse" })

export interface DisconnectRequest extends Schema.Schema.Type<typeof DisconnectRequest> {}
export const DisconnectRequest = Schema.Struct({
  client_id: IdeClientId,
}).annotate({ identifier: "Rika.Ide.DisconnectRequest" })

export interface UpdateContextRequest extends Schema.Schema.Type<typeof UpdateContextRequest> {}
export const UpdateContextRequest = Schema.Struct({
  client_id: IdeClientId,
  context: ContextSnapshot,
}).annotate({ identifier: "Rika.Ide.UpdateContextRequest" })

export interface Status extends Schema.Schema.Type<typeof Status> {}
export const Status = Schema.Struct({
  connected: Schema.Boolean,
  client_id: Schema.optional(IdeClientId),
  name: Schema.optional(Schema.String),
  capabilities: Schema.Array(Capability),
  workspace_roots: Schema.Array(Schema.String),
  context: Schema.optional(ContextSnapshot),
}).annotate({ identifier: "Rika.Ide.Status" })

export interface OpenFileRequest extends Schema.Schema.Type<typeof OpenFileRequest> {}
export const OpenFileRequest = Schema.Struct({
  path: Schema.String,
  range: Schema.optional(LineRange),
  preview: Schema.optional(Schema.Boolean),
  reason: Schema.optional(Schema.String),
  thread_id: Schema.optional(ThreadId),
}).annotate({ identifier: "Rika.Ide.OpenFileRequest" })

export interface OpenFileResult extends Schema.Schema.Type<typeof OpenFileResult> {}
export const OpenFileResult = Schema.Struct({
  accepted: Schema.Boolean,
  message: Schema.optional(Schema.String),
}).annotate({ identifier: "Rika.Ide.OpenFileResult" })
