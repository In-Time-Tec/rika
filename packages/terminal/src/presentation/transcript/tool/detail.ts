import { partialInputRecord } from "@rika/transcript/partial-tool-input"
import * as TranscriptPresentationModel from "@rika/transcript/transcript-presentation-model"
import { Function, Option, Schema } from "effect"
import { escapeControlCharacters } from "../../terminal/format"
import type { Model } from "../../../state/model"
import type { TranscriptBlock } from "../../../state/transcript/model"
import type { TranscriptUnit } from "./types"
import type { ToolKind } from "./kinds"
import type { ToolDetail, ToolSummary } from "./detail-types"

const readToolNames = new Set(["read", "view_file", "get_diagnostics"])
const searchToolNames = new Set(["grep", "glob", "list_dir", "codebase_search"])
const editToolNames = new Set(["edit", "write"])
const shellToolNames = new Set(["bash", "run_command"])
const ToolInput = Schema.Struct({
  cmd: Schema.optionalKey(Schema.String),
  command: Schema.optionalKey(Schema.String),
  file: Schema.optionalKey(Schema.String),
  file_path: Schema.optionalKey(Schema.String),
  glob: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  offset: Schema.optionalKey(Schema.Finite),
  path: Schema.optionalKey(Schema.String),
  pattern: Schema.optionalKey(Schema.String),
  query: Schema.optionalKey(Schema.String),
  script: Schema.optionalKey(Schema.String),
})
type ToolInput = typeof ToolInput.Type
const ToolInputJson = Schema.fromJsonString(ToolInput)
const decodeToolInput = Schema.decodeUnknownOption(ToolInput)
const decodeTranscriptBlock = Schema.decodeUnknownSync(TranscriptPresentationModel.Block)

const summary = (primary: string, secondary?: string): ToolSummary => {
  if (secondary === undefined || secondary.length === 0) return { primary }
  return { primary, secondary: ` ${secondary}` }
}

const withLabel = (block: number, value: ToolSummary): Pick<ToolDetail, "block" | "label" | "summary"> => ({
  block,
  label: value.primary + (value.secondary ?? ""),
  summary: value,
})

export const agentToolSummary = (label: string): ToolSummary => {
  const suffixes = [
    " has spoken",
    " is researching",
    " researching",
    " researched",
    " exploring",
    " working",
    " finished",
    " failed",
    " cancelled",
    " codebase",
    " code",
  ]
  const suffix = suffixes.find((candidate) => label.endsWith(candidate))
  return suffix === undefined ? summary(label) : { primary: label.slice(0, -suffix.length), secondary: suffix }
}

export const escapePathTarget = escapeControlCharacters

export const inputValue = (input: string): ToolInput =>
  Option.getOrElse(Schema.decodeOption(ToolInputJson)(input), () =>
    Option.getOrElse(decodeToolInput(partialInputRecord(input)), () => ({})),
  )

const stringValue = (values: ReadonlyArray<string | undefined>): string | undefined => {
  for (const value of values) if (value !== undefined && value.length > 0) return value
  return undefined
}

const withTarget = (detail: ToolDetail, target: ToolDetail["target"]): ToolDetail => {
  if (target === undefined) return detail
  return { ...detail, target }
}

type ToolCall = Extract<TranscriptBlock, { _tag: "ToolCall" }>

const detailKind = (call: ToolCall): ToolKind =>
  call.presentation.family === "explore" &&
  (call.presentation.action === "read" || call.presentation.action === "media")
    ? "read"
    : toolKind(call.name, call.presentation.family)

const detailTarget = (path: string | undefined, offset: number | undefined): ToolDetail["target"] => {
  if (path === undefined) return undefined
  return offset === undefined ? { path } : { path, line: offset + 1, column: 1 }
}

const readDetail = (
  block: number,
  call: ToolCall,
  path: string | undefined,
  target: ToolDetail["target"],
): ToolDetail => {
  const displayPath = path === undefined ? undefined : escapePathTarget(path)
  const verb = call.presentation.action === "media" ? "Viewed" : "Read"
  const location = path === undefined ? undefined : call.detail.match(/\s+L\d+(?:-\d+)?$/)?.[0]
  const detail = path === undefined ? call.detail : `${displayPath}${location ?? ""}`
  return withTarget(withLabel(block, summary(verb, detail || displayPath || call.name)), target)
}

const searchDetail = (block: number, call: ToolCall, input: ToolInput, target: ToolDetail["target"]): ToolDetail => {
  const query = stringValue([input.pattern, input.query, input.glob, input.path])
  return withTarget(
    withLabel(
      block,
      summary(call.presentation.action === "grep" ? "Grep" : "Searched", call.detail || query || "workspace"),
    ),
    target,
  )
}

const shellDetail = (block: number, call: ToolCall, input: ToolInput): ToolDetail => {
  const command = call.detail || stringValue([input.command, input.cmd, input.script]) || ""
  return withLabel(block, summary("$", command || (call.input.trimStart().startsWith("{") ? "" : call.input)))
}

const otherDetail = (block: number, call: ToolCall): ToolDetail => {
  let label = call.presentation.completeLabel
  if (call.status === "running") label = call.presentation.activeLabel
  else if (call.status === "failed") label = call.presentation.failedLabel ?? call.presentation.completeLabel
  const value = call.presentation.family === "agent" ? agentToolSummary(label) : summary(label, call.detail)
  return { ...withLabel(block, value) }
}

export const toolDetail: {
  (call: Extract<TranscriptBlock, { _tag: "ToolCall" }>): (block: number) => ToolDetail
  (block: number, call: Extract<TranscriptBlock, { _tag: "ToolCall" }>): ToolDetail
} = Function.dual(2, (block: number, call: Extract<TranscriptBlock, { _tag: "ToolCall" }>): ToolDetail => {
  const input = inputValue(call.input)
  const kind = detailKind(call)
  const path = call.files[0]?.path ?? stringValue([input.path, input.file_path, input.file])
  const offset = input.offset === undefined ? undefined : Math.max(0, Math.trunc(input.offset))
  const target = detailTarget(path, offset)
  const displayPath = path === undefined ? undefined : escapePathTarget(path)
  if (kind === "read") return readDetail(block, call, path, target)
  if (kind === "search") return searchDetail(block, call, input, target)
  if (kind === "edit") return withTarget(withLabel(block, summary("Edit", displayPath ?? call.detail)), target)
  return kind === "shell" ? shellDetail(block, call, input) : otherDetail(block, call)
})

export const toolDetails: {
  (unit: Extract<TranscriptUnit, { kind: "tool" }>): (model: Model) => ReadonlyArray<ToolDetail>
  (model: Model, unit: Extract<TranscriptUnit, { kind: "tool" }>): ReadonlyArray<ToolDetail>
} = Function.dual(
  2,
  (model: Model, unit: Extract<TranscriptUnit, { kind: "tool" }>): ReadonlyArray<ToolDetail> =>
    unit.blocks.flatMap((block) => {
      const call = decodeTranscriptBlock(model.blocks[block])
      return call._tag === "ToolCall" ? [toolDetail(block, call)] : []
    }),
)

type ToolFamily = Extract<TranscriptBlock, { _tag: "ToolCall" }>["presentation"]["family"]

const toolKindImpl = (rawName: string, family: ToolFamily | undefined): ToolKind => {
  const name = rawName.toLowerCase()
  if (family === "explore") return readToolNames.has(name) || name === "view_media" ? "read" : "search"
  if (family === "edit") return "edit"
  if (family === "shell") return "shell"
  if (readToolNames.has(name)) return "read"
  if (searchToolNames.has(name)) return "search"
  if (editToolNames.has(name)) return "edit"
  return shellToolNames.has(name) ? "shell" : "other"
}

export const toolKind: {
  (family: ToolFamily | undefined): (rawName: string) => ToolKind
  (rawName: string, family: ToolFamily | undefined): ToolKind
} = Function.dual(2, toolKindImpl)
