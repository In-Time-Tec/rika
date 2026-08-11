import type { Unit } from "@rika/product/execution-transcript-contract"
import { type Node } from "./model"
import { textLimit } from "./values"

export interface StreamedTextProjection {
  readonly assistant: (node: Node, delta: string) => void
  readonly reasoning: (node: Node, delta: string) => void
}

export interface StreamedTextProjectionInput {
  readonly units: Map<string, Unit>
  readonly localId: (family: string, ...parts: ReadonlyArray<string | number>) => string
  readonly put: (unit: Unit) => void
  readonly unit: (node: Node, key: string, content: Unit["content"], part?: number) => Unit
}

export const makeStreamedTextProjection = (input: StreamedTextProjectionInput): StreamedTextProjection => {
  const { units, localId, put, unit } = input

  const assistant = (node: Node, delta: string) => {
    if (node.hidden) return
    let chunk = 0
    while (units.has(localId("assistant", node.publicId, node.phase, chunk + 1))) chunk += 1
    let remaining = delta
    do {
      const key = localId("assistant", node.publicId, node.phase, chunk)
      const current = units.get(key)
      const previous = current?.content._tag === "Entry" ? current.content.text : ""
      const capacity = textLimit - previous.length
      const appended = remaining.slice(0, capacity)
      put(unit(node, key, { _tag: "Entry", role: "assistant", text: `${previous}${appended}` }, chunk))
      remaining = remaining.slice(appended.length)
      if (remaining.length > 0) chunk += 1
    } while (remaining.length > 0)
  }

  const reasoning = (node: Node, delta: string) => {
    if (node.hidden) return
    let chunk = 0
    while (units.has(localId("reasoning", node.publicId, node.phase, chunk + 1))) chunk += 1
    let remaining = delta
    do {
      const key = localId("reasoning", node.publicId, node.phase, chunk)
      const current = units.get(key)
      const previous =
        current?.content._tag === "Block" && current.content.block._tag === "Reasoning"
          ? current.content.block.text
          : ""
      const capacity = textLimit - previous.length
      const appended = remaining.slice(0, capacity)
      put(unit(node, key, { _tag: "Block", block: { _tag: "Reasoning", text: `${previous}${appended}` } }, chunk))
      remaining = remaining.slice(appended.length)
      if (remaining.length > 0) chunk += 1
    } while (remaining.length > 0)
  }

  return { assistant, reasoning }
}
