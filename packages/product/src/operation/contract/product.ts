import { Runtime, Schema } from "effect"
import { ModeId } from "@rika/configuration/behavior-mode"

const Mode = ModeId
const ClientWorkspace = { clientWorkspace: Schema.optionalKey(Schema.String) }

const Interactive = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Interactive"),
  prompt: Schema.Array(Schema.String),
  mode: Schema.optionalKey(Mode),
  workspace: Schema.optionalKey(Schema.String),
  threadId: Schema.optionalKey(Schema.String),
  last: Schema.optionalKey(Schema.Boolean),
  ephemeral: Schema.Boolean,
})

const Run = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Run"),
  prompt: Schema.Array(Schema.String),
  mode: Schema.optionalKey(Mode),
  workspace: Schema.optionalKey(Schema.String),
  threadId: Schema.optionalKey(Schema.String),
  ephemeral: Schema.Boolean,
  streamJson: Schema.Boolean,
  streamJsonInput: Schema.Boolean,
  streamJsonThinking: Schema.Boolean,
})

const Review = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Review"),
  prompt: Schema.Array(Schema.String),
  mode: Schema.optionalKey(Mode),
  workspace: Schema.optionalKey(Schema.String),
  threadId: Schema.optionalKey(Schema.String),
  ephemeral: Schema.Boolean,
})

const ThreadNoInput = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Thread"),
  action: Schema.Literals(["new", "last", "top"]),
})
const ThreadContinueLast = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Thread"),
  action: Schema.tag("continue"),
  last: Schema.tag(true),
})
const ThreadContinueIds = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Thread"),
  action: Schema.tag("continue"),
  threadIds: Schema.NonEmptyArray(Schema.String),
})
const ThreadList = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Thread"),
  action: Schema.tag("list"),
  includeArchived: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(Schema.Int),
})
const ThreadSearch = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Thread"),
  action: Schema.tag("search"),
  query: Schema.NonEmptyArray(Schema.String),
  includeArchived: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(Schema.Int),
})
const ThreadRename = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Thread"),
  action: Schema.tag("rename"),
  threadId: Schema.String,
  title: Schema.String,
})
const ThreadLabel = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Thread"),
  action: Schema.tag("label"),
  threadId: Schema.String,
  labels: Schema.NonEmptyArray(Schema.String),
})
const ThreadById = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Thread"),
  action: Schema.Literals(["pin", "archive", "unarchive", "delete", "usage"]),
  threadId: Schema.String,
})
const ThreadFork = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Thread"),
  action: Schema.tag("fork"),
  threadId: Schema.String,
  atTurn: Schema.optionalKey(Schema.String),
})
const ThreadExport = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Thread"),
  action: Schema.tag("export"),
  threadId: Schema.String,
  format: Schema.Literals(["json", "markdown"]),
})

const ConfigNoInput = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Config"),
  action: Schema.Literals(["list", "keymap"]),
})
const ConfigEdit = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Config"),
  action: Schema.tag("edit"),
  workspace: Schema.Boolean,
})

const McpNoInput = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Mcp"),
  action: Schema.Literals(["list", "doctor"]),
})
const McpAddCommand = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Mcp"),
  action: Schema.tag("add"),
  name: Schema.String,
  command: Schema.NonEmptyArray(Schema.String),
})
const McpAddUrl = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Mcp"),
  action: Schema.tag("add"),
  name: Schema.String,
  url: Schema.String,
})
const McpNamed = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Mcp"),
  action: Schema.Literals(["remove", "enable", "disable", "oauth-login", "oauth-logout"]),
  name: Schema.String,
})
const McpOauthStatus = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Mcp"),
  action: Schema.tag("oauth-status"),
  name: Schema.optionalKey(Schema.String),
})

const SkillList = Schema.Struct({ ...ClientWorkspace, _tag: Schema.tag("Skill"), action: Schema.tag("list") })
const SkillNamed = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Skill"),
  action: Schema.Literals(["inspect", "remove"]),
  name: Schema.String,
})
const SkillAdd = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Skill"),
  action: Schema.tag("add"),
  source: Schema.String,
})

const ToolList = Schema.Struct({
  _tag: Schema.tag("ToolCatalog"),
  action: Schema.tag("list"),
  mode: Schema.optionalKey(Mode),
})
const ToolShow = Schema.Struct({ _tag: Schema.tag("ToolCatalog"), action: Schema.tag("show"), name: Schema.String })

const Extension = Schema.Struct({
  ...ClientWorkspace,
  _tag: Schema.tag("Extension"),
  action: Schema.Literals(["create-skill", "create-plugin", "enable", "disable", "rollback"]),
  name: Schema.String,
})
const ExtensionList = Schema.Struct({ ...ClientWorkspace, _tag: Schema.tag("Extension"), action: Schema.tag("list") })
const Doctor = Schema.Struct({ ...ClientWorkspace, _tag: Schema.tag("Doctor") })

export const Input = Schema.Union([
  Interactive,
  Run,
  Review,
  ThreadNoInput,
  ThreadContinueLast,
  ThreadContinueIds,
  ThreadList,
  ThreadSearch,
  ThreadRename,
  ThreadLabel,
  ThreadById,
  ThreadFork,
  ThreadExport,
  ConfigNoInput,
  ConfigEdit,
  McpNoInput,
  McpAddCommand,
  McpAddUrl,
  McpNamed,
  McpOauthStatus,
  SkillList,
  SkillNamed,
  SkillAdd,
  ToolList,
  ToolShow,
  Extension,
  ExtensionList,
  Doctor,
])
export type Input = typeof Input.Type

export class OperationUnavailable extends Schema.TaggedError<OperationUnavailable>()("OperationUnavailable", {
  operation: Schema.String,
  message: Schema.String,
}) {
  override readonly [Runtime.errorExitCode] = 2
  override readonly [Runtime.errorReported] = false
}

export class InvalidInput extends Schema.TaggedError<InvalidInput>()("InvalidInput", {
  message: Schema.String,
}) {
  override readonly [Runtime.errorExitCode] = 2
  override readonly [Runtime.errorReported] = false
}
