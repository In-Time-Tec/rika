import type { Unit } from "@rika/product/execution-transcript-contract"
import { modelResponseId } from "@rika/product/execution-gateway"
import { cellToolName } from "../cell/state"
import type { SemanticModelResponseEvent } from "./event"
import type { Card, Node } from "../model"
import { encoded } from "../decoding"
import { optionalString, projectorNames, record, string } from "../values"
import { Option, Schema } from "effect"
import { SubagentGroupParams, type SubagentGroupParams as SubagentGroupInput } from "../subagent/card"

export interface SemanticResponseProjectionInput {
  readonly localId: (family: string, ...parts: ReadonlyArray<string | number>) => string
  readonly put: (unit: Unit) => void
  readonly unit: (node: Node, key: string, content: Unit["content"], part?: number) => Unit
  readonly openCell: (node: Node, rawId: string, source: string) => void
  readonly cardFor: (node: Node, rawId: string, selection: string, prompt: string, label?: string) => Card
  readonly groupCards: (node: Node, rawId: string, input: SubagentGroupInput) => ReadonlyArray<Card>
  readonly removeTool: (node: Node, rawId: string) => void
  readonly putTool: (node: Node, rawId: string, name: string, input: string) => void
  readonly notice: (node: Node, family: string, title: string, detail: string, discriminator: string | number) => void
  readonly beginOrderedResponse: () => void
  readonly endOrderedResponse: () => void
}

export const makeSemanticResponseProjection = (input: SemanticResponseProjectionInput) => {
  const putCompletedText = (
    node: Node,
    event: SemanticModelResponseEvent,
    contentIndex: number,
    kind: "assistant" | "reasoning",
    text: string,
  ) => {
    if (node.hidden || text.length === 0) return
    const key = input.localId(kind, node.publicId, node.phase, event.operationKey, contentIndex)
    input.put({
      ...input.unit(
        node,
        key,
        kind === "assistant"
          ? { _tag: "Entry", role: "assistant", text }
          : { _tag: "Block", block: { _tag: "Reasoning", text } },
      ),
      modelResponseId: modelResponseId({
        runId: node.rawRunId,
        turn: event.turn,
        modelCallId: event.modelCallId,
        modelAttemptId: event.modelAttemptId,
        attempt: event.attempt,
      }),
    })
  }

  const putToolCall = (
    node: Node,
    part: Extract<SemanticModelResponseEvent["response"]["content"][number], { type: "tool-call" }>,
  ) => {
    if (part.name === cellToolName) return input.openCell(node, part.id, string(record(part.params).code, ""))
    if (part.name === projectorNames.runChild) {
      const toolInput = record(part.params)
      input.cardFor(
        node,
        part.id,
        string(toolInput.selection, "Subagent"),
        optionalString(toolInput.prompt),
        optionalString(toolInput.label) || undefined,
      )
      return input.removeTool(node, part.id)
    }
    if (part.name === projectorNames.runChildGroup) {
      const params = Schema.decodeUnknownOption(SubagentGroupParams)(part.params)
      if (Option.isSome(params)) input.groupCards(node, part.id, params.value)
      return input.removeTool(node, part.id)
    }
    input.putTool(node, part.id, part.name, encoded(part.params))
  }

  const apply = (node: Node, event: SemanticModelResponseEvent) => {
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
            putToolCall(node, part)
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
