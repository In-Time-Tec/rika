import { partialInputRecord } from "@rika/transcript/partial-tool-input"
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
const ToolInputJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

const summary = (primary: string, secondary?: string): ToolSummary => ({
  primary,
  ...(secondary === undefined || secondary.length === 0 ? {} : { secondary: ` ${secondary}` }),
})

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

export const inputValue = (input: string): Record<string, unknown> =>
  Option.getOrElse(Schema.decodeUnknownOption(ToolInputJson)(input), () => partialInputRecord(input))

const stringValue = (value: Record<string, unknown>, keys: ReadonlyArray<string>): string | undefined => {
  for (const key of keys) if (typeof value[key] === "string" && value[key].length > 0) return value[key]
  return undefined
}

export const toolDetail: {
  (call: Extract<TranscriptBlock, { _tag: "ToolCall" }>): (block: number) => ToolDetail
  (block: number, call: Extract<TranscriptBlock, { _tag: "ToolCall" }>): ToolDetail
} = Function.dual(2, (block: number, call: Extract<TranscriptBlock, { _tag: "ToolCall" }>): ToolDetail => {
  const input = inputValue(call.input)
  const kind =
    call.presentation.family === "explore" &&
    (call.presentation.action === "read" || call.presentation.action === "media")
      ? "read"
      : toolKind(call.name, call.presentation.family)
  const path = call.files[0]?.path ?? stringValue(input, ["path", "file_path", "file"])
  const offset =
    typeof input.offset === "number" && Number.isFinite(input.offset)
      ? Math.max(0, Math.trunc(input.offset))
      : undefined
  const target =
    path === undefined
      ? undefined
      : {
          path,
          ...(offset === undefined ? {} : { line: offset + 1, column: 1 }),
        }
  const displayPath = path === undefined ? undefined : escapePathTarget(path)
  if (kind === "read") {
    const verb = call.presentation.action === "media" ? "Viewed" : "Read"
    const location = path === undefined ? undefined : call.detail.match(/\s+L\d+(?:-\d+)?$/)?.[0]
    const detail = path === undefined ? call.detail : `${displayPath}${location ?? ""}`
    return {
      ...withLabel(block, summary(verb, detail || displayPath || call.name)),
      ...(target === undefined ? {} : { target }),
    }
  }
  if (kind === "search") {
    const query = stringValue(input, ["pattern", "query", "glob", "path"])
    return {
      ...withLabel(
        block,
        summary(call.presentation.action === "grep" ? "Grep" : "Searched", call.detail || query || "workspace"),
      ),
      ...(target === undefined ? {} : { target }),
    }
  }
  if (kind === "edit")
    return {
      ...withLabel(block, summary("Edit", displayPath ?? call.detail)),
      ...(target === undefined ? {} : { target }),
    }
  if (kind === "shell") {
    const command = call.detail || stringValue(input, ["command", "cmd", "script"]) || ""
    return withLabel(block, summary("$", command || (call.input.trimStart().startsWith("{") ? "" : call.input)))
  }
  let label = call.presentation.completeLabel
  if (call.status === "running") {
    label = call.presentation.activeLabel
  } else if (call.status === "failed") {
    label = call.presentation.failedLabel ?? call.presentation.completeLabel
  }
  const value = call.presentation.family === "agent" ? agentToolSummary(label) : summary(label, call.detail)
  return {
    ...withLabel(block, value),
  }
})

export const toolDetails: {
  (unit: Extract<TranscriptUnit, { kind: "tool" }>): (model: Model) => ReadonlyArray<ToolDetail>
  (model: Model, unit: Extract<TranscriptUnit, { kind: "tool" }>): ReadonlyArray<ToolDetail>
} = Function.dual(
  2,
  (model: Model, unit: Extract<TranscriptUnit, { kind: "tool" }>): ReadonlyArray<ToolDetail> =>
    unit.blocks.map((block) =>
      toolDetail(block, model.blocks[block] as Extract<TranscriptBlock, { _tag: "ToolCall" }>),
    ),
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
