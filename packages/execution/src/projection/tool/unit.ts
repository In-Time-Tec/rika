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
  readonly linkProcessCheck: (node: Node, rawId: string, input: string) => void
  readonly runningToolIds: (node: Node) => ReadonlyArray<string>
}

export interface ToolUnitProjectionInput {
  readonly units: Map<string, Unit>
  readonly localId: (family: string, ...parts: ReadonlyArray<string | number>) => string
  readonly put: (unit: Unit) => void
  readonly unit: (node: Node, key: string, content: Unit["content"], part?: number) => Unit
}

export const makeToolUnitProjection = (dependencies: ToolUnitProjectionInput): ToolUnitProjection => {
  const { units, localId, put, unit } = dependencies

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
    const base = ToolBlock.makeTool(identity.blockId, rawId, name, bounded(input, toolTextLimit), previous)
    const block = mutate === undefined ? base : mutate(base)
    put(unit(node, identity.key, { _tag: "Block", block }))
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

  const linkProcessCheck = (node: Node, rawId: string, encodedInput: string) => {
    const check = ToolBlock.Input.processCheckFromInput(rawId, encodedInput)
    let origin =
      check === undefined
        ? undefined
        : [...node.tools.entries()].find(([candidateRawId]) => {
            const block = toolBlock(node, candidateRawId)
            return (
              block?.name === "bash" &&
              block.toolCallId === candidateRawId &&
              block.process?.processId === check.processId
            )
          })
    if (origin === undefined && check !== undefined) {
      const recovered = [...units.values()].find(
        (candidate) =>
          candidate.parentId === node.parentBlockId &&
          candidate.content._tag === "Block" &&
          candidate.content.block._tag === "ToolCall" &&
          candidate.content.block.name === "bash" &&
          candidate.content.block.process?.processId === check.processId &&
          candidate.content.block.toolCallId !== undefined,
      )
      if (
        recovered?.content._tag === "Block" &&
        recovered.content.block._tag === "ToolCall" &&
        recovered.content.block.toolCallId !== undefined
      ) {
        const recoveredState: ToolState = {
          rawId: recovered.content.block.toolCallId,
          key: recovered.key,
          blockId: recovered.content.block.id,
        }
        node.tools.set(recoveredState.rawId, recoveredState)
        origin = [recoveredState.rawId, recoveredState]
      }
    }
    if (origin === undefined || check === undefined) {
      putTool(node, rawId, "shell_command_status", encodedInput)
      return
    }
    const [originRawId, originState] = origin
    const alias: ToolState = { rawId, key: originState.key, blockId: originState.blockId }
    node.tools.set(rawId, alias)
    updateTool(node, originRawId, (tool) => {
      const checks = [...(tool.process?.checks ?? []).filter((candidate) => candidate.toolCallId !== rawId), check]
      return { ...tool, status: "running", process: { ...tool.process, checks } }
    })
  }

  const runningToolIds = (node: Node): ReadonlyArray<string> => {
    const ids = new Set<string>()
    for (const [rawId] of node.tools) if (toolBlock(node, rawId)?.status === "running") ids.add(rawId)
    for (const candidate of units.values()) {
      if (
        candidate.parentId === node.parentBlockId &&
        candidate.content._tag === "Block" &&
        candidate.content.block._tag === "ToolCall" &&
        candidate.content.block.status === "running" &&
        candidate.content.block.toolCallId !== undefined
      ) {
        const rawId = candidate.content.block.toolCallId
        ids.add(rawId)
        if (!node.tools.has(rawId))
          node.tools.set(rawId, { rawId, key: candidate.key, blockId: candidate.content.block.id })
      }
    }
    return [...ids]
  }

  return { toolState, toolBlock, putTool, updateTool, linkProcessCheck, runningToolIds }
}
