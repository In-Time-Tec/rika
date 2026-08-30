import { Catalog } from "@rika/coding-tools/coding-tool-catalog"
import type { Block, Unit } from "@rika/product/execution-transcript-contract"
import type { Card, Node } from "../model"
import type { ProjectorCore } from "../persistence"
import { bounded, projectorNames, toolTextLimit } from "../values"
import { promptText } from "../decoding"
import type { RunEvent } from "tenetkit/runtime"
import { Schema } from "effect"

export const SubagentGroupParams = Schema.Struct({
  members: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      selection: Schema.String,
      label: Schema.optionalKey(Schema.String),
      prompt: Schema.String,
    }),
  ),
})
export type SubagentGroupParams = typeof SubagentGroupParams.Type
type ChildLinked = Extract<RunEvent.RunEvent, { readonly _tag: "ChildLinked" }>

export interface SubagentCardProjection {
  readonly cardFor: (
    node: Node,
    rawInvocationId: string,
    selection: string,
    cardPrompt: string,
    label?: string,
    memberKey?: string,
    orderPart?: number,
  ) => Card
  readonly updateCard: (
    card: Card,
    status: "queued" | "running" | "cancelling" | "complete" | "failed" | "cancelled",
    output?: string,
  ) => void
  readonly groupCards: (node: Node, rawToolCallId: string, params: SubagentGroupParams) => ReadonlyArray<Card>
  readonly bindChild: (
    parent: Node,
    childRawRunId: string,
    linked: {
      readonly invocationId: string
      readonly selection: string
      readonly prompt: ChildLinked["prompt"]
      readonly key?: string
      readonly label?: string
      readonly origin?: { readonly parentToolCallId?: string }
    },
  ) => void
}

export interface SubagentCardProjectionInput {
  readonly core: ProjectorCore
  readonly units: Map<string, Unit>
  readonly nodes: Map<string, Node>
  readonly unitKeysByRun: Map<string, Set<string>>
  readonly cardsByInvocation: Map<string, Card>
  readonly cardsByChild: Map<string, Card>
  readonly localId: (family: string, ...parts: ReadonlyArray<string | number>) => string
  readonly put: (unit: Unit) => void
  readonly unit: (node: Node, key: string, content: Unit["content"], part?: number) => Unit
  readonly recoverCard: (card: Card) => void
  readonly recoverNode: (node: Node) => void
}

const invocationIdFor = (linked: {
  readonly invocationId: string
  readonly key?: string
  readonly origin?: { readonly parentToolCallId?: string }
}): string => {
  const parentToolCallId = linked.origin?.parentToolCallId
  return linked.key === undefined || parentToolCallId === undefined
    ? (parentToolCallId ?? linked.invocationId)
    : `${parentToolCallId}:${linked.key}`
}

export const makeSubagentCardProjection = (input: SubagentCardProjectionInput): SubagentCardProjection => {
  const {
    core,
    units,
    nodes,
    unitKeysByRun,
    cardsByInvocation,
    cardsByChild,
    localId,
    put,
    unit,
    recoverCard,
    recoverNode,
  } = input

  const cardFor = (
    node: Node,
    rawInvocationId: string,
    selection: string,
    cardPrompt: string,
    label?: string,
    memberKey?: string,
    orderPart = 0,
  ): Card => {
    const invocationKey = `${node.rawRunId}\u0000${rawInvocationId}`
    const existing = cardsByInvocation.get(invocationKey)
    if (existing !== undefined) return existing
    const publicId = localId("subagent", node.publicId, rawInvocationId, memberKey ?? "")
    const card: Card = {
      parentRawRunId: node.rawRunId,
      rawInvocationId,
      publicId,
      unitKey: localId("subagent-unit", publicId),
      blockId: publicId,
      selection,
      prompt: bounded(cardPrompt, toolTextLimit),
      promptTruncated: cardPrompt.length > toolTextLimit,
    }
    if (label !== undefined) Object.assign(card, { label })
    if (memberKey !== undefined) Object.assign(card, { memberKey })
    cardsByInvocation.set(invocationKey, card)
    recoverCard(card)
    const block: Extract<Block, { readonly _tag: "SubagentCard" }> = {
      _tag: "SubagentCard",
      id: card.publicId,
      name: card.label ?? Catalog.agentProfile(card.selection),
      prompt: card.prompt,
      promptTruncated: card.promptTruncated,
      summary: "",
      status: "queued",
      activity: [],
    }
    const created = unit(node, card.unitKey, { _tag: "Block", block }, orderPart)
    put(created)
    return card
  }

  const updateCard = (
    card: Card,
    status: "queued" | "running" | "cancelling" | "complete" | "failed" | "cancelled",
    output?: string,
  ) => {
    const candidate = units.get(card.unitKey)
    if (candidate?.content._tag !== "Block" || candidate.content.block._tag !== "SubagentCard") return
    put({
      ...candidate,
      revision: core.revision,
      content: {
        _tag: "Block",
        block: {
          ...candidate.content.block,
          status,
        },
      },
    })
    if (output !== undefined && output.length > 0) {
      const updated = units.get(card.unitKey)
      if (updated?.content._tag === "Block" && updated.content.block._tag === "SubagentCard")
        put({
          ...updated,
          revision: core.revision,
          content: { _tag: "Block", block: { ...updated.content.block, summary: bounded(output, toolTextLimit) } },
        })
    }
  }

  const groupCards = (node: Node, rawToolCallId: string, params: SubagentGroupParams) => {
    const cards: Array<Card> = []
    for (const [index, member] of params.members.entries()) {
      if (member.key.length === 0 || member.prompt.length === 0) continue
      cards.push(
        cardFor(
          node,
          `${rawToolCallId}:${member.key}`,
          member.selection,
          member.prompt,
          member.label,
          member.key,
          index,
        ),
      )
    }
    return cards
  }

  const fillPrompt = (card: Card, displayPrompt: string) => {
    if (card.prompt.length > 0 || displayPrompt.length === 0) return
    card.prompt = bounded(displayPrompt, toolTextLimit)
    card.promptTruncated = displayPrompt.length > toolTextLimit
    const candidate = units.get(card.unitKey)
    if (candidate?.content._tag === "Block" && candidate.content.block._tag === "SubagentCard")
      put({
        ...candidate,
        revision: core.revision,
        content: {
          _tag: "Block",
          block: { ...candidate.content.block, prompt: card.prompt, promptTruncated: card.promptTruncated },
        },
      })
    recoverCard(card)
  }

  const bindChild = (
    parent: Node,
    childRawRunId: string,
    linked: {
      readonly invocationId: string
      readonly selection: string
      readonly prompt: ChildLinked["prompt"]
      readonly key?: string
      readonly label?: string
      readonly origin?: { readonly parentToolCallId?: string }
    },
  ) => {
    const invocationId = invocationIdFor(linked)
    let card = cardsByInvocation.get(`${parent.rawRunId}\u0000${invocationId}`)
    const displayPrompt = promptText(linked.prompt)
    if (card === undefined && invocationId !== projectorNames.titleInvocationId)
      card = cardFor(parent, invocationId, linked.selection, displayPrompt, linked.label, linked.key)
    if (card !== undefined) fillPrompt(card, displayPrompt)
    if (card === undefined || card.rawChildRunId !== undefined) return
    card.rawChildRunId = childRawRunId
    cardsByChild.set(childRawRunId, card)
    recoverCard(card)
    const child = nodes.get(childRawRunId)
    if (child !== undefined) {
      const linkedChild = { ...child, parentUnitKey: card.unitKey, parentBlockId: card.blockId }
      nodes.set(childRawRunId, linkedChild)
      recoverNode(linkedChild)
      for (const key of unitKeysByRun.get(childRawRunId) ?? []) {
        const candidate = units.get(key)
        if (candidate !== undefined && candidate.parentId === undefined)
          put({ ...candidate, revision: core.revision, parentId: card.blockId })
      }
    }
  }

  return { cardFor, updateCard, groupCards, bindChild }
}
