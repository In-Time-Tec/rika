import * as Bash from "@rika/product/bash-tool"
import * as Edit from "@rika/product/edit-file-tool"
import * as NativeResult from "@rika/product/native-tool-result"
import * as Read from "@rika/product/read-file-tool"
import { Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import { ToolIdentity } from "generalist/host"

import { SearchResult } from "./search"

const identity = (tool: string) => ({
  implementation: `rika-runner-v2/${tool}`,
  policy: "rika-runner-v2-native-v1",
})

/** Existing Rika native tools with a stable application-owned ToolIdentity. */
export const bash = Bash.tool.annotate(ToolIdentity, identity("bash"))
export const read = Read.tool.annotate(ToolIdentity, identity("read"))
export const edit = Edit.tool.annotate(ToolIdentity, identity("edit"))

export const GrepParameters = Schema.Struct({
  pattern: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
  path: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096))),
  glob: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))),
  max_results: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(1_000)),
  ),
})
export type GrepParameters = typeof GrepParameters.Type

export const grep = Tool.make("grep", {
  description: "Search workspace files with bounded ripgrep-style results",
  parameters: GrepParameters,
  success: NativeResult.Result,
  failure: NativeResult.ToolFailure,
  failureMode: "return",
}).annotate(ToolIdentity, identity("grep"))

export const WebSearchParameters = Schema.Struct({
  query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384)),
  max_results: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(20)),
  ),
})
export type WebSearchParameters = typeof WebSearchParameters.Type

export const webSearch = Tool.make("web_search", {
  description: "Search the configured web provider and return typed results with source URLs",
  parameters: WebSearchParameters,
  success: SearchResult,
  failure: NativeResult.ToolFailure,
  failureMode: "return",
}).annotate(ToolIdentity, identity("web-search"))

export const toolkit = Toolkit.make(bash, read, edit, grep, webSearch)
export const tools = [bash, read, edit, grep, webSearch] as const

export const NativeTools = {
  bash,
  edit,
  grep,
  read,
  toolkit,
  tools,
  webSearch,
}
