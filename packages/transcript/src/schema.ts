import { Schema } from "effect"

export const SourceEvent = Schema.Struct({
  cursor: Schema.String,
  sequence: Schema.Finite,
  type: Schema.String,
  createdAt: Schema.Finite,
  text: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  data: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
})
export type SourceEvent = typeof SourceEvent.Type

export const Presentation = Schema.Struct({
  family: Schema.Literals(["explore", "shell", "edit", "agent", "direct", "generic"]),
  action: Schema.String,
  activeLabel: Schema.String,
  completeLabel: Schema.String,
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
      "review",
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
export type ToolFile = typeof ToolFile.Type

export const ToolProcess = Schema.Struct({
  running: Schema.optionalKey(Schema.Boolean),
  processId: Schema.optionalKey(Schema.String),
  exitCode: Schema.optionalKey(Schema.Finite),
  stdout: Schema.optionalKey(Schema.String),
  stderr: Schema.optionalKey(Schema.String),
  truncated: Schema.optionalKey(Schema.Boolean),
})
export type ToolProcess = typeof ToolProcess.Type

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
  childId: Schema.optionalKey(Schema.String),
})
const ToolResult = Schema.TaggedStruct("ToolResult", {
  id: Schema.String,
  output: Schema.String,
  failed: Schema.Boolean,
})
const Diff = Schema.TaggedStruct("Diff", {
  path: Schema.String,
  patch: Schema.String,
})
const ContextUsage = Schema.TaggedStruct("ContextUsage", {
  text: Schema.String,
  cost: Schema.optionalKey(Schema.String),
})
const Compaction = Schema.TaggedStruct("Compaction", {
  summary: Schema.String,
  checkpoint: Schema.optionalKey(Schema.String),
})
const Notification = Schema.TaggedStruct("Notification", { title: Schema.String, detail: Schema.String })
const ErrorBlock = Schema.TaggedStruct("Error", {
  title: Schema.String,
  detail: Schema.String,
  turnId: Schema.optionalKey(Schema.String),
  recovery: Schema.optionalKey(Schema.String),
})
const Permission = Schema.TaggedStruct("Permission", {
  id: Schema.String,
  kind: Schema.Literals(["permission", "tool-approval"]),
  title: Schema.String,
  detail: Schema.String,
  status: Schema.Literals(["pending", "approved", "denied"]),
})
const ChildAgent = Schema.TaggedStruct("ChildAgent", {
  id: Schema.String,
  name: Schema.String,
  summary: Schema.String,
  status: Schema.Literals(["running", "complete", "failed", "cancelled"]),
  activity: Schema.Array(Schema.String),
})
const Workflow = Schema.TaggedStruct("Workflow", {
  name: Schema.String,
  step: Schema.String,
  status: Schema.Literals(["running", "waiting", "complete", "failed"]),
})
const ImageAttachment = Schema.TaggedStruct("ImageAttachment", {
  name: Schema.String,
  mediaType: Schema.String,
  width: Schema.optionalKey(Schema.Finite),
  height: Schema.optionalKey(Schema.Finite),
  bytes: Schema.optionalKey(Schema.Finite),
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
  Permission,
  ChildAgent,
  Workflow,
  ImageAttachment,
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

export const Unit = Schema.Struct({
  key: Schema.String,
  turnId: Schema.String,
  parentId: Schema.optionalKey(Schema.String),
  order: Schema.Struct({ sequence: Schema.Finite, part: Schema.Finite }),
  revision: Schema.Finite,
  executionOutcome: Schema.optionalKey(
    Schema.Struct({
      status: Schema.Literals(["complete", "failed", "cancelled"]),
      reason: Schema.optionalKey(Schema.String),
    }),
  ),
  content: Content,
})
export type Unit = typeof Unit.Type

export const Projection = Schema.Struct({
  units: Schema.Array(Unit),
  revision: Schema.Finite,
  modelPhase: Schema.Finite,
  oldestCursor: Schema.optionalKey(Schema.String),
  checkpointCursor: Schema.optionalKey(Schema.String),
  costUsd: Schema.optionalKey(Schema.Finite),
})
export type Projection = typeof Projection.Type
