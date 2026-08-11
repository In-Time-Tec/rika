import type { Unit } from "@rika/product/execution-transcript-contract"
import { cellToolName } from "./cell"
import type { ModelResponseCommitted } from "./semantic-event"
export { semanticTreeEvent, type SemanticTreeEvent } from "./semantic-event"
import type { Node } from "./model"
import { encoded } from "./decoding"
import { optionalString, record, string } from "./values"
import { projectorNames, textLimit } from "./values"

export interface SemanticResponseProjectionInput {
  readonly localId: (family: string, ...parts: ReadonlyArray<string | number>) => string
  readonly put: (unit: Unit) => void
  readonly unit: (node: Node, key: string, content: Unit["content"], part?: number) => Unit
  readonly openCell: (node: Node, rawId: string, source: string) => void
  readonly cardFor: (node: Node, rawId: string, selection: string, prompt: string) => unknown
  readonly groupCards: (node: Node, rawId: string, input: unknown) => unknown
  readonly removeTool: (node: Node, rawId: string) => void
  readonly putTool: (node: Node, rawId: string, name: string, input: string) => void
  readonly notice: (
    node: Node,
    family: string,
    title: string,
    detail: string,
    discriminator: string | number,
  ) => unknown
  readonly error: (node: Node, family: string, title: string, detail: string, discriminator: string | number) => unknown
  readonly beginOrderedResponse: () => void
  readonly endOrderedResponse: () => void
}

export const makeSemanticResponseProjection = (input: SemanticResponseProjectionInput) => {
  const putCompletedText = (
    node: Node,
    event: ModelResponseCommitted,
    contentIndex: number,
    kind: "assistant" | "reasoning",
    text: string,
  ) => {
    if (node.hidden || text.length === 0) return
    const chunks = Array.from({ length: Math.ceil(text.length / textLimit) }, (_, index) =>
      text.slice(index * textLimit, (index + 1) * textLimit),
    )
    for (const [chunkIndex, chunk] of chunks.entries()) {
      const key = input.localId(kind, node.publicId, node.phase, event.operationKey, contentIndex, chunkIndex)
      input.put(
        input.unit(
          node,
          key,
          kind === "assistant"
            ? { _tag: "Entry", role: "assistant", text: chunk }
            : { _tag: "Block", block: { _tag: "Reasoning", text: chunk } },
        ),
      )
    }
  }

  const apply = (node: Node, event: ModelResponseCommitted) => {
    input.beginOrderedResponse()
    try {
      for (const [contentIndex, part] of event.response.content.entries()) {
        switch (part.type) {
          case "text":
            putCompletedText(node, event, contentIndex, "assistant", part.text)
            break
          case "reasoning":
            putCompletedText(node, event, contentIndex, "reasoning", part.text)
            break
          case "tool-call":
            if (part.name === cellToolName) input.openCell(node, part.id, string(record(part.params).code, ""))
            else if (part.name === projectorNames.runChild) {
              const toolInput = record(part.params)
              input.cardFor(node, part.id, string(toolInput.selection, "Subagent"), optionalString(toolInput.prompt))
              input.removeTool(node, part.id)
            } else if (part.name === projectorNames.startChildGroup) {
              input.groupCards(node, part.id, part.params)
              input.removeTool(node, part.id)
            } else if (part.name === projectorNames.awaitChildGroup) input.removeTool(node, part.id)
            else input.putTool(node, part.id, part.name, encoded(part.params))
            break
          case "file":
            input.notice(
              node,
              "file",
              "Model attached a file",
              "A model-generated file is available.",
              `${event.operationKey}:${contentIndex}`,
            )
            break
          case "source":
            input.notice(
              node,
              "source",
              "Model cited a source",
              "A model source was recorded.",
              `${event.operationKey}:${contentIndex}`,
            )
            break
          case "error":
            input.error(
              node,
              "model-error",
              "Model response error",
              String(part.error),
              `${event.operationKey}:${contentIndex}`,
            )
            break
          case "tool-approval-request":
          case "response-metadata":
          case "finish":
          case "tool-result":
            break
        }
      }
    } finally {
      input.endOrderedResponse()
    }
  }

  return { apply }
}
