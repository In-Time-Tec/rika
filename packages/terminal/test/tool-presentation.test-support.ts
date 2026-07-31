import { TextAttributes } from "../src/presentation/markdown/styled-text"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import { expect } from "vitest"
import { buildTranscript } from "../src/opentui/surface/opentui-surface"
import { colors } from "../src/presentation/terminal/terminal-theme"

import { initial, type Model, type TranscriptBlock } from "../src/state/model/terminal-state"

export type ToolCall = Extract<TranscriptBlock, { readonly _tag: "ToolCall" }>

export const call = (
  id: string,
  name: string,
  input: Record<string, unknown>,
  presentation: ToolCall["presentation"],
  changes: Partial<ToolCall> = {},
): ToolCall => ({
  _tag: "ToolCall",
  id,
  name,
  input: JSON.stringify(input),
  status: "complete",
  presentation,
  detail: "",
  files: [],
  ...changes,
})

export const model = (blocks: ReadonlyArray<ToolCall>, expandedRowKeys: ReadonlyArray<string> = []): Model => ({
  ...initial("/workspace", "medium"),
  blocks,
  items: blocks.map((_, index) => ({ _tag: "Block" as const, index, id: `item:${index}`, turnId: "turn" })),
  expandedRowKeys,
})

export const text = (value: Model): string =>
  buildTranscript(value)
    .styled.chunks.map((chunk) => chunk.text)
    .join("")

export type RenderChunk = { readonly text: string; readonly fg?: unknown; readonly attributes?: number }
export const chunkFor = (chunks: ReadonlyArray<RenderChunk>, snippet: string): RenderChunk => {
  const chunk = chunks.find((candidate) => candidate.text.includes(snippet))
  if (chunk === undefined) throw new Error(`Missing styled chunk for ${snippet}`)
  return chunk
}

export const expectForeground = (
  chunks: ReadonlyArray<RenderChunk>,
  expectedText: string,
  _color: typeof colors.text,
): void => {
  const chunk = chunks.find(
    (candidate) =>
      candidate.text === expectedText || (expectedText.startsWith(" ") && candidate.text === expectedText.slice(1)),
  )
  expect(chunk, `missing summary chunk ${JSON.stringify(expectedText)}`).toBeDefined()
}

export const hasAttribute = (chunk: RenderChunk, attribute: number): boolean =>
  ((chunk.attributes ?? TextAttributes.NONE) & attribute) === attribute

export const shellPresentation: ToolCall["presentation"] = {
  family: "shell",
  action: "command",
  activeLabel: "Running",
  completeLabel: "Ran",
}

export const explore = (
  action: string,
  counter: NonNullable<ToolCall["presentation"]["counter"]>,
): ToolCall["presentation"] => ({
  family: "explore",
  action,
  activeLabel: "Exploring",
  completeLabel: "Explored",
  counter,
})

export const streamingBlock = (name: string, partialInput: string): ToolCall => {
  const projection = TranscriptProjection.Projection.project("turn", "prompt", [
    {
      cursor: "0",
      sequence: 0,
      type: "model.toolcall.delta",
      createdAt: 0,
      data: { tool_call_id: "call", tool_name: name, delta: partialInput },
    },
  ])
  const unit = projection.units.find((candidate) => candidate.key === "tool:turn:call")
  if (unit?.content._tag !== "Block" || unit.content.block._tag !== "ToolCall")
    throw new Error("expected a streaming ToolCall block")
  return unit.content.block
}
