import { Schema } from "effect"

const SourceSequence = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
)
const OrderSequence = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: -1, maximum: Number.MAX_SAFE_INTEGER }),
)
const OrderPart = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
)
const WellFormedString = Schema.String.check(Schema.isPattern(/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/))
const WellFormedNonEmptyString = WellFormedString.check(Schema.isMinLength(1))

export const SourceEvent = Schema.Struct({
  childExecutionId: Schema.optionalKey(Schema.String),
  cursor: Schema.String,
  sequence: SourceSequence,
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
  status: Schema.optionalKey(Schema.Literals(["running", "complete", "failed"])),
})
const Notification = Schema.TaggedStruct("Notification", { title: Schema.String, detail: Schema.String })
const ErrorBlock = Schema.TaggedStruct("Error", {
  title: Schema.String,
  detail: Schema.String,
  turnId: Schema.optionalKey(Schema.String),
  recovery: Schema.optionalKey(Schema.String),
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

export const UnitOrderSegment = Schema.Struct({
  sequence: OrderSequence,
  part: OrderPart,
  key: WellFormedNonEmptyString,
})
export type UnitOrderSegment = typeof UnitOrderSegment.Type

export const UnitOrder = Schema.NonEmptyArray(UnitOrderSegment)
export type UnitOrder = typeof UnitOrder.Type

export const Unit = Schema.Struct({
  key: WellFormedNonEmptyString,
  turnId: WellFormedString,
  parentId: Schema.optionalKey(WellFormedString),
  order: UnitOrder,
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

const ProjectionStateFields = {
  revision: Schema.Finite,
  modelPhase: Schema.Finite,
  usableCompletionSequence: Schema.optionalKey(Schema.Finite),
  oldestCursor: Schema.optionalKey(Schema.String),
  checkpointCursor: Schema.optionalKey(Schema.String),
  costUsd: Schema.optionalKey(Schema.Finite),
  usageCursors: Schema.optionalKey(Schema.Array(Schema.String)),
  pricingVersion: Schema.optionalKey(Schema.String),
} as const

export const ProjectionState = Schema.Struct(ProjectionStateFields)
export type ProjectionState = typeof ProjectionState.Type

export const Projection = Schema.Struct({
  units: Schema.Array(Unit),
  ...ProjectionStateFields,
})
export type Projection = typeof Projection.Type
