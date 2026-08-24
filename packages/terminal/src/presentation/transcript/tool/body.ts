import type { TranscriptBlock } from "../../../state/transcript/model"
import { isToolOutputDisplayed } from "../agent-response"
import { inputValue } from "./detail"

export type ToolBody =
  | { readonly _tag: "None" }
  | { readonly _tag: "Text"; readonly text: string }
  | { readonly _tag: "Markdown"; readonly source: string }
  | { readonly _tag: "Patch"; readonly patch: string; readonly path: string }
  | { readonly _tag: "FileWindow"; readonly path: string; readonly start: number; readonly lines: string }

const numberedWindow = /^(\d+):\s?/

export const toolBody = (block: Extract<TranscriptBlock, { _tag: "ToolCall" }>): ToolBody => {
  const patch = block.files[0]?.patch
  if (patch !== undefined && patch.length > 0) return { _tag: "Patch", patch, path: block.files[0]!.path }
  if (!isToolOutputDisplayed(block)) return { _tag: "None" }
  const output = block.output
  if (output === undefined || output.length === 0) return { _tag: "None" }
  if (block.presentation.action === "read-web-page") return { _tag: "Markdown", source: output }
  if (block.presentation.action === "read") {
    const path = inputValue(block.input).path
    const first = numberedWindow.exec(output.split("\n")[0] ?? "")
    if (typeof path === "string" && path.length > 0 && first !== null)
      return { _tag: "FileWindow", path, start: Number(first[1]), lines: output }
  }
  return { _tag: "Text", text: output }
}

export const isExpandableBody = (body: ToolBody): boolean => body._tag !== "None"
