import { Schema } from "effect"
import * as Grep from "../workspace/grep-files-tool"
import * as Read from "../workspace/read-file-tool"
import * as Write from "../workspace/write-file-tool"
import * as Edit from "../workspace/edit-file-tool"
import * as Bash from "../process/bash-tool"
import * as ShellStatus from "../process/shell-command-status-tool"
import * as WebSearch from "../web-research/web-search-tool"
import * as ReadPage from "../web-research/read-web-page-tool"
import * as Media from "../media/view-media-tool"
import * as CodingToolResult from "./coding-tool-result"

const Shell = Schema.Struct({
  _tag: Schema.tag("Shell"),
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  waitMillis: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
})
export const Request = Schema.Union([
  Grep.Request,
  Read.Request,
  Write.Request,
  Edit.Request,
  Bash.Request,
  Shell,
  ShellStatus.Request,
  WebSearch.Request,
  ReadPage.Request,
  Media.Request,
])
export type Request = typeof Request.Type
export const Result = CodingToolResult.Result
export type Result = typeof Result.Type
export class ToolError extends Schema.TaggedErrorClass<ToolError>()("ToolError", {
  tool: Schema.String,
  message: Schema.String,
  kind: Schema.Literals(["operation", "timeout"]),
  category: CodingToolResult.FailureCategory,
  outcome: Schema.Literals(["known", "unknown"]),
  recovery: CodingToolResult.Recovery,
  nextAction: Schema.String,
}) {}
