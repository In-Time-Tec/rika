import { Catalog } from "@rika/coding-tools/coding-tool-catalog"
import type { Block, Unit } from "@rika/product/execution-transcript-contract"
import { type Card, type Node } from "../model"
import { type ProjectorCore } from "../persistence"
import { bounded, record, optionalString, string } from "../values"
import { projectorNames, toolTextLimit } from "../values"
import { promptText } from "../decoding"

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
  readonly groupCards: (node: Node, rawToolCallId: string, params: unknown) => ReadonlyArray<Card>
  readonly bindChild: (
    parent: Node,
    childRawRunId: string,
    linked: {
      readonly invocationId: string
      readonly selection: string
      readonly prompt: unknown
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
      ...(label === undefined ? {} : { label }),
      prompt: bounded(cardPrompt, toolTextLimit),
      promptTruncated: cardPrompt.length > toolTextLimit,
      ...(memberKey === undefined ? {} : { memberKey }),
    }
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
          ...(output === undefined || output.length === 0 ? {} : { summary: bounded(output, toolTextLimit) }),
        },
      },
    })
  }

  const groupCards = (node: Node, rawToolCallId: string, params: unknown) => {
    const value = record(params)
    if (!Array.isArray(value.members)) return []
    const cards: Array<Card> = []
    for (const [index, rawMember] of value.members.entries()) {
      const member = record(rawMember)
      const key = optionalString(member.key)
      const selection = string(member.selection, "Subagent")
      const label = optionalString(member.label)
      const memberPrompt = optionalString(member.prompt)
      if (key.length === 0 || memberPrompt.length === 0) continue
      cards.push(cardFor(node, `${rawToolCallId}:${key}`, selection, memberPrompt, label || undefined, key, index))
    }
    return cards
  }

  const bindChild = (
    parent: Node,
    childRawRunId: string,
    linked: {
      readonly invocationId: string
      readonly selection: string
      readonly prompt: unknown
      readonly key?: string
      readonly label?: string
      readonly origin?: { readonly parentToolCallId?: string }
    },
  ) => {
    const parentToolCallId = linked.origin?.parentToolCallId
    const invocationId =
      linked.key === undefined || parentToolCallId === undefined
        ? (parentToolCallId ?? linked.invocationId)
        : `${parentToolCallId}:${linked.key}`
    let card = cardsByInvocation.get(`${parent.rawRunId}\u0000${invocationId}`)
    const displayPrompt = promptText(linked.prompt)
    if (card === undefined && invocationId !== projectorNames.titleInvocationId)
      card = cardFor(parent, invocationId, linked.selection, displayPrompt, linked.label, linked.key)
    if (card !== undefined && card.prompt.length === 0 && displayPrompt.length > 0) {
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
