import { Schema } from "effect"

export const Presentation = Schema.Struct({
  family: Schema.Literals(["explore", "shell", "edit", "agent", "direct", "generic"]),
  action: Schema.String,
  activeLabel: Schema.String,
  completeLabel: Schema.String,
  failedLabel: Schema.optionalKey(Schema.String),
  rowDisplay: Schema.optionalKey(Schema.Literal("continuation")),
  outputDisplay: Schema.optionalKey(Schema.Literals(["hidden", "expandable", "inline"])),
  counter: Schema.optionalKey(
    Schema.Literals([
      "file",
      "media file",
      "web page",
      "thread",
      "skill",
      "guidance file",
      "search",
      "web search",
      "GitHub check",
      "list",
    ]),
  ),
})
export type Presentation = typeof Presentation.Type

export const ToolFile = Schema.Struct({
  key: Schema.String,
  path: Schema.String,
  kind: Schema.Literals(["add", "update", "delete", "move"]),
  patch: Schema.String,
  additions: Schema.Finite,
  deletions: Schema.Finite,
  preview: Schema.Boolean,
  status: Schema.Literals(["running", "complete", "failed"]),
  previousPath: Schema.optionalKey(Schema.String),
})

export const ToolProcess = Schema.Struct({
  running: Schema.optionalKey(Schema.Boolean),
  processId: Schema.optionalKey(Schema.String),
  exitCode: Schema.optionalKey(Schema.Finite),
  stdout: Schema.optionalKey(Schema.String),
  stderr: Schema.optionalKey(Schema.String),
  truncated: Schema.optionalKey(Schema.Boolean),
})

const Reasoning = Schema.TaggedStruct("Reasoning", { text: Schema.String })
const ToolCall = Schema.TaggedStruct("ToolCall", {
  id: Schema.String,
  name: Schema.String,
  input: Schema.String,
  status: Schema.Literals(["running", "complete", "failed", "cancelled", "rejected"]),
  presentation: Presentation,
  detail: Schema.String,
  output: Schema.optionalKey(Schema.String),
  process: Schema.optionalKey(ToolProcess),
  files: Schema.Array(ToolFile),
  parentId: Schema.optionalKey(Schema.String),
})
const ToolResult = Schema.TaggedStruct("ToolResult", {
  id: Schema.String,
  output: Schema.String,
  failed: Schema.Boolean,
})
const Diff = Schema.TaggedStruct("Diff", { path: Schema.String, patch: Schema.String })
const ContextUsage = Schema.TaggedStruct("ContextUsage", {
  text: Schema.String,
  cost: Schema.optionalKey(Schema.String),
})
const Compaction = Schema.TaggedStruct("Compaction", {
  summary: Schema.String,
  checkpoint: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Literals(["running", "complete", "failed", "cancelled"])),
})
const Notification = Schema.TaggedStruct("Notification", { title: Schema.String, detail: Schema.String })
const ErrorBlock = Schema.TaggedStruct("Error", {
  title: Schema.String,
  detail: Schema.String,
  turnId: Schema.optionalKey(Schema.String),
  category: Schema.optionalKey(Schema.String),
  retryable: Schema.optionalKey(Schema.Boolean),
})
const SubagentCard = Schema.TaggedStruct("SubagentCard", {
  id: Schema.String,
  name: Schema.String,
  prompt: Schema.String,
  promptTruncated: Schema.Boolean,
  summary: Schema.String,
  status: Schema.Literals(["queued", "running", "waiting", "cancelling", "complete", "failed", "cancelled"]),
  activity: Schema.Array(Schema.String),
})
const AuthorizationCard = Schema.TaggedStruct("AuthorizationCard", {
  id: Schema.String,
  operation: Schema.String,
  capability: Schema.String,
  input: Schema.String.check(Schema.isMaxLength(16_384)),
  inputTruncated: Schema.Boolean,
  status: Schema.Literals(["pending", "approved", "denied", "cancelled", "expired"]),
})
const ImageAttachment = Schema.TaggedStruct("ImageAttachment", {
  name: Schema.String,
  mediaType: Schema.String,
  width: Schema.optionalKey(Schema.Finite),
  height: Schema.optionalKey(Schema.Finite),
  bytes: Schema.optionalKey(Schema.Finite),
})
const CellSource = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(65_536)),
  lines: Schema.Finite,
  truncated: Schema.Boolean,
})
const CellOutput = Schema.Struct({
  stdout: Schema.String,
  stderr: Schema.String,
  droppedBytes: Schema.Finite,
  droppedEvents: Schema.Finite,
})
const CellNotice = Schema.Struct({
  kind: Schema.Literals(["restored", "lost", "restarted", "starting", "ready"]),
  detail: Schema.String,
})
const Cell = Schema.TaggedStruct("Cell", {
  id: Schema.String,
  status: Schema.Literals(["running", "complete", "failed", "cancelled", "unknown"]),
  visual: Schema.Literals(["ts", "shell"]),
  summary: Schema.String,
  source: CellSource,
  output: CellOutput,
  result: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(
    Schema.Struct({
      name: Schema.String,
      message: Schema.String,
      stack: Schema.optionalKey(Schema.String),
    }),
  ),
  durationMillis: Schema.optionalKey(Schema.Finite),
  epoch: Schema.Finite,
  notices: Schema.Array(CellNotice),
  files: Schema.Array(ToolFile),
  process: Schema.optionalKey(ToolProcess),
  parentId: Schema.optionalKey(Schema.String),
})

export const Block = Schema.Union([
  Reasoning,
  ToolCall,
  ToolResult,
  Diff,
  ContextUsage,
  Compaction,
  Notification,
  ErrorBlock,
  SubagentCard,
  AuthorizationCard,
  ImageAttachment,
  Cell,
])
export type Block = typeof Block.Type

export const Content = Schema.Union([
  Schema.TaggedStruct("Entry", {
    role: Schema.Literals(["user", "assistant", "notice"]),
    text: Schema.String,
  }),
  Schema.TaggedStruct("Block", { block: Block }),
])
export type Content = typeof Content.Type
