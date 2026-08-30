import type { Block, Unit } from "@rika/product/execution-transcript-contract"
import * as ToolBlock from "./state"
import type { Node, ToolState } from "../model"
import { bounded, toolTextLimit } from "../values"

export interface ToolUnitProjection {
  readonly toolState: (node: Node, rawId: string) => ToolState
  readonly toolBlock: (node: Node, rawId: string) => Extract<Block, { readonly _tag: "ToolCall" }> | undefined
  readonly putTool: (
    node: Node,
    rawId: string,
    name: string,
    input: string,
    mutate?: (block: Extract<Block, { readonly _tag: "ToolCall" }>) => Extract<Block, { readonly _tag: "ToolCall" }>,
  ) => void
  readonly updateTool: (
    node: Node,
    rawId: string,
    mutate: (block: Extract<Block, { readonly _tag: "ToolCall" }>) => Extract<Block, { readonly _tag: "ToolCall" }>,
  ) => void
}

export interface ToolUnitProjectionInput {
  readonly units: Map<string, Unit>
  readonly localId: (family: string, ...parts: ReadonlyArray<string | number>) => string
  readonly put: (unit: Unit) => void
  readonly unit: (node: Node, key: string, content: Unit["content"], part?: number) => Unit
  readonly recover: (node: Node, tool: ToolState, active: boolean) => void
}

export const makeToolUnitProjection = (dependencies: ToolUnitProjectionInput): ToolUnitProjection => {
  const { units, localId, put, unit, recover } = dependencies

  const toolState = (node: Node, rawId: string): ToolState => {
    const current = node.tools.get(rawId)
    if (current !== undefined) return current
    const created = {
      rawId,
      key: localId("tool-unit", node.publicId, rawId),
      blockId: localId("tool", node.publicId, rawId),
    }
    node.tools.set(rawId, created)
    return created
  }

  const toolBlock = (node: Node, rawId: string): Extract<Block, { readonly _tag: "ToolCall" }> | undefined => {
    const current = node.tools.get(rawId)
    const candidate = current === undefined ? undefined : units.get(current.key)
    return candidate?.content._tag === "Block" && candidate.content.block._tag === "ToolCall"
      ? candidate.content.block
      : undefined
  }

  const putTool = (
    node: Node,
    rawId: string,
    name: string,
    input: string,
    mutate?: (block: Extract<Block, { readonly _tag: "ToolCall" }>) => Extract<Block, { readonly _tag: "ToolCall" }>,
  ) => {
    if (node.hidden) return
    const identity = toolState(node, rawId)
    const previous = toolBlock(node, rawId)
    const base = ToolBlock.makeTool(identity.blockId, name, bounded(input, toolTextLimit), previous)
    const block = mutate === undefined ? base : mutate(base)
    put(unit(node, identity.key, { _tag: "Block", block }))
    recover(node, identity, block.status === "running")
  }

  const updateTool = (
    node: Node,
    rawId: string,
    mutate: (block: Extract<Block, { readonly _tag: "ToolCall" }>) => Extract<Block, { readonly _tag: "ToolCall" }>,
  ) => {
    const current = toolBlock(node, rawId)
    if (current === undefined) return
    putTool(node, rawId, current.name, current.input, mutate)
  }

  return { toolState, toolBlock, putTool, updateTool }
}
