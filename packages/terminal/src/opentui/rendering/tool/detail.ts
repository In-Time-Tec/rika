import { Function, Schema } from "effect"
import type { Model } from "../../../state/model"
import { decodeTranscriptBlocks, type TranscriptBlock } from "../../../state/transcript/model"
import { inputValue, toolKind } from "../../../presentation/transcript/tool/detail"
import type { ToolKind } from "../../../presentation/transcript/tool/kinds"

export const toolInputValue = inputValue
const inputStringImpl = (
  value: ReturnType<typeof inputValue>,
  keys: ReadonlyArray<keyof ReturnType<typeof inputValue>>,
): string | undefined => {
  for (const key of keys) {
    const candidate = value[key]
    if (Schema.is(Schema.String)(candidate) && candidate.length > 0) return candidate
  }
  return undefined
}

export const inputString: {
  (
    arg1: Parameters<typeof inputStringImpl>[1],
  ): (arg0: Parameters<typeof inputStringImpl>[0]) => ReturnType<typeof inputStringImpl>
  (
    arg0: Parameters<typeof inputStringImpl>[0],
    arg1: Parameters<typeof inputStringImpl>[1],
  ): ReturnType<typeof inputStringImpl>
} = Function.dual(2, inputStringImpl)
export type ToolUnit = {
  readonly kind: ToolKind
  readonly block: Extract<TranscriptBlock, { _tag: "ToolCall" }>
  readonly index: number
}
export const diffCounts = (patch: string): readonly [number, number] => {
  let added = 0
  let removed = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1
  }
  return [added, removed]
}
export const shellCommandText = (block: Extract<TranscriptBlock, { _tag: "ToolCall" }>): string => {
  const value = toolInputValue(block.input)
  const command = block.process?.command || block.detail || inputString(value, ["command", "cmd", "script"]) || ""
  return command || (block.input.trimStart().startsWith("{") ? "" : block.input)
}
export const shellMetadata = (block: Extract<TranscriptBlock, { _tag: "ToolCall" }>): ReadonlyArray<string> => {
  const value = toolInputValue(block.input)
  const workdir = block.process?.workdir ?? inputString(value, ["workdir", "cwd"])
  const processId = block.process?.processId ?? inputString(value, ["processId"])
  const command = shellCommandText(block)
  const script = inputString(value, ["script"])
  const metadata: Array<string> = []
  if (workdir !== undefined) metadata.push(`cwd ${workdir}`)
  if (processId !== undefined) metadata.push(`process ${processId}`)
  if (block.process?.background === true) metadata.push("detached")
  if ((script !== undefined && script.length > 0) || command.includes("\n")) metadata.push("script")
  return metadata
}
export const shellExitCode = (block: Extract<TranscriptBlock, { _tag: "ToolCall" }>): number | undefined =>
  block.process?.exitCode
export const exploreChildLabel = (unit: ToolUnit): string => {
  const value = toolInputValue(unit.block.input)
  const detail =
    unit.block.detail ||
    inputString(value, ["path", "file_path", "file", "pattern", "query", "glob", "name"]) ||
    "workspace"
  if (unit.block.presentation.action === "skill") return detail
  if (unit.block.presentation.action === "media") return `Viewed ${detail}`
  if (unit.block.presentation.action === "git-status") return `Checked ${detail}`
  if (unit.block.presentation.action === "read" || unit.kind === "read") return `Read ${detail}`
  const pattern = inputString(value, ["pattern", "query", "glob", "path"])
  return `${unit.block.presentation.action === "grep" ? "Grep" : "Searched"} ${unit.block.detail || pattern || ""}`.trimEnd()
}
const toolUnitsForImpl = (model: Model, indices: ReadonlyArray<number>): ReadonlyArray<ToolUnit> =>
  indices
    .map((index) => {
      const block = decodeTranscriptBlocks(model.blocks)[index]
      if (block?._tag !== "ToolCall") return undefined
      return { kind: toolKind(block.name, undefined), block, index }
    })
    .filter((unit): unit is ToolUnit => unit !== undefined)

export const toolUnitsFor: {
  (
    arg1: Parameters<typeof toolUnitsForImpl>[1],
  ): (arg0: Parameters<typeof toolUnitsForImpl>[0]) => ReturnType<typeof toolUnitsForImpl>
  (
    arg0: Parameters<typeof toolUnitsForImpl>[0],
    arg1: Parameters<typeof toolUnitsForImpl>[1],
  ): ReturnType<typeof toolUnitsForImpl>
} = Function.dual(2, toolUnitsForImpl)
