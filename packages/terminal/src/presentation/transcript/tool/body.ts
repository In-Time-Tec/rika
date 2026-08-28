import type { TranscriptBlock } from "../../../state/transcript/model"
import { isToolOutputDisplayed } from "../agent-response"
import { Schema } from "effect"

export type ToolBody =
  | { readonly _tag: "None" }
  | { readonly _tag: "Text"; readonly text: string }
  | { readonly _tag: "Markdown"; readonly source: string }
  | { readonly _tag: "Patch"; readonly patch: string; readonly path: string }

const TextResult = Schema.Struct({ text: Schema.String })
const MessageResult = Schema.Struct({ message: Schema.String })

export const toolResultText = (result: Schema.Json | undefined): string | undefined => {
  if (result === undefined) return undefined
  if (Schema.is(Schema.String)(result)) return result
  const decoded = Schema.decodeUnknownOption(TextResult)(result)
  if (decoded._tag === "Some") return decoded.value.text
  return JSON.stringify(result, null, 2)
}

export const toolBody = (block: Extract<TranscriptBlock, { _tag: "ToolCall" }>): ToolBody => {
  const patch = block.files[0]?.patch
  if (patch !== undefined && patch.length > 0) return { _tag: "Patch", patch, path: block.files[0]!.path }
  if (!isToolOutputDisplayed(block)) return { _tag: "None" }
  let output = toolResultText(block.result)
  if (block.status === "failed" && block.result !== undefined) {
    const failure = Schema.decodeUnknownOption(MessageResult)(block.result)
    if (failure._tag === "Some" && failure.value.message !== output)
      output = `${failure.value.message}${output === undefined ? "" : `\n\n${output}`}`
  }
  if (output === undefined || output.length === 0) return { _tag: "None" }
  if (block.presentation.action === "read-web-page") return { _tag: "Markdown", source: output }
  return { _tag: "Text", text: output }
}

export const isExpandableBody = (body: ToolBody): boolean => body._tag !== "None"
