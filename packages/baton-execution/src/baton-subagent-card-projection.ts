import { Catalog } from "@rika/coding-tools/coding-tool-catalog"
import type { Block, Unit } from "@rika/product/execution-transcript-contract"
import { type Card, type Node } from "./baton-projector-model"
import { type ProjectorCore } from "./baton-projector-persistence"
import { projectorNames, bounded, record, optionalString, string, toolTextLimit } from "./baton-projector-values"
import { promptText } from "./baton-projector-decoding"

export interface SubagentCardProjection {
  readonly cardFor: (
    node: Node,
    rawInvocationId: string,
    selection: string,
    cardPrompt: string,
    groupKey?: string,
    orderPart?: number,
  ) => Card
  readonly updateCard: (
    card: Card,
    status: "running" | "cancelling" | "complete" | "failed" | "cancelled",
    output?: string,
  ) => void
  readonly groupCards: (node: Node, rawToolCallId: string, params: unknown) => void
  readonly bindFanOut: (node: Node, fanOutId: string, memberCount: number) => void
  readonly bindChild: (
    parent: Node,
    childRawRunId: string,
    invocationId: string,
    selection: string,
    linkedPrompt: unknown,
  ) => void
}

interface PendingGroup {
  readonly parentRawRunId: string
  readonly toolCallId: string
  readonly memberKeys: ReadonlyArray<string>
}

export interface SubagentCardProjectionInput {
  readonly core: ProjectorCore
  readonly units: Map<string, Unit>
  readonly nodes: Map<string, Node>
  readonly unitKeysByRun: Map<string, Set<string>>
  readonly cardsByInvocation: Map<string, Card>
  readonly cardsByChild: Map<string, Card>
  readonly pendingGroups: Array<PendingGroup>
  readonly fanOutTools: Map<string, PendingGroup>
  readonly localId: (family: string, ...parts: ReadonlyArray<string | number>) => string
  readonly put: (unit: Unit) => void
  readonly unit: (node: Node, key: string, content: Unit["content"], part?: number) => Unit
}

export const makeSubagentCardProjection = (input: SubagentCardProjectionInput): SubagentCardProjection => {
  const {
    core,
    units,
    nodes,
    unitKeysByRun,
    cardsByInvocation,
    cardsByChild,
    pendingGroups,
    fanOutTools,
    localId,
    put,
    unit,
  } = input

  const cardFor = (
    node: Node,
    rawInvocationId: string,
    selection: string,
    cardPrompt: string,
    groupKey?: string,
    orderPart = 0,
  ): Card => {
    const invocationKey = `${node.rawRunId}\u0000${rawInvocationId}`
    const existing = cardsByInvocation.get(invocationKey)
    if (existing !== undefined) return existing
    const publicId = localId("subagent", node.publicId, rawInvocationId, groupKey ?? "")
    const card: Card = {
      parentRawRunId: node.rawRunId,
      rawInvocationId,
      publicId,
      unitKey: localId("subagent-unit", publicId),
      blockId: publicId,
      selection: Catalog.agentProfile(selection),
      prompt: bounded(cardPrompt, toolTextLimit),
      promptTruncated: cardPrompt.length > toolTextLimit,
      ...(groupKey === undefined ? {} : { groupKey }),
    }
    cardsByInvocation.set(invocationKey, card)
    const block: Extract<Block, { readonly _tag: "SubagentCard" }> = {
      _tag: "SubagentCard",
      id: card.publicId,
      name: card.selection,
      prompt: card.prompt,
      promptTruncated: card.promptTruncated,
      summary: "",
      status: "running",
      activity: [],
    }
    put(unit(node, card.unitKey, { _tag: "Block", block }, orderPart))
    return card
  }

  const updateCard = (
    card: Card,
    status: "running" | "cancelling" | "complete" | "failed" | "cancelled",
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
    if (!Array.isArray(value.members)) return
    const memberKeys: Array<string> = []
    for (const [index, rawMember] of value.members.entries()) {
      const member = record(rawMember)
      const key = optionalString(member.key)
      const selection = string(member.selection, "Subagent")
      const memberPrompt = optionalString(member.prompt)
      if (key.length === 0 || memberPrompt.length === 0) continue
      memberKeys.push(key)
      cardFor(node, `${rawToolCallId}:${key}`, selection, memberPrompt, key, index)
    }
    pendingGroups.push({ parentRawRunId: node.rawRunId, toolCallId: rawToolCallId, memberKeys })
  }

  const bindFanOut = (node: Node, fanOutId: string, memberCount: number) => {
    const matching = (candidate: PendingGroup) => candidate.parentRawRunId === node.rawRunId
    const index = pendingGroups.findIndex(
      (candidate) => matching(candidate) && candidate.memberKeys.length === memberCount,
    )
    const resolved = index === -1 ? pendingGroups.findIndex(matching) : index
    if (resolved === -1) return
    const [candidate] = pendingGroups.splice(resolved, 1)
    fanOutTools.set(fanOutId, candidate!)
  }

  const groupMemberCard = (parent: Node, invocationId: string): Card | undefined => {
    const separator = invocationId.lastIndexOf(":")
    if (separator === -1) return undefined
    const key = invocationId.slice(separator + 1)
    for (const [fanOutId, group] of fanOutTools) {
      if (group.parentRawRunId !== parent.rawRunId || !invocationId.startsWith(`${fanOutId}:`)) continue
      return cardsByInvocation.get(
        `${parent.rawRunId}\u0000${group.toolCallId}:${invocationId.slice(fanOutId.length + 1)}`,
      )
    }
    for (const group of pendingGroups) {
      if (group.parentRawRunId !== parent.rawRunId || !group.memberKeys.includes(key)) continue
      return cardsByInvocation.get(`${parent.rawRunId}\u0000${group.toolCallId}:${key}`)
    }
    return undefined
  }

  const bindChild = (
    parent: Node,
    childRawRunId: string,
    invocationId: string,
    selection: string,
    linkedPrompt: unknown,
  ) => {
    let card = cardsByInvocation.get(`${parent.rawRunId}\u0000${invocationId}`) ?? groupMemberCard(parent, invocationId)
    const displayPrompt = promptText(linkedPrompt)
    if (card === undefined && invocationId !== projectorNames.titleInvocationId)
      card = cardFor(parent, invocationId, selection, displayPrompt)
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
    }
    if (card === undefined || card.rawChildRunId !== undefined) return
    card.rawChildRunId = childRawRunId
    cardsByChild.set(childRawRunId, card)
    const child = nodes.get(childRawRunId)
    if (child !== undefined) {
      nodes.set(childRawRunId, { ...child, parentUnitKey: card.unitKey, parentBlockId: card.blockId })
      for (const key of unitKeysByRun.get(childRawRunId) ?? []) {
        const candidate = units.get(key)
        if (candidate !== undefined && candidate.parentId === undefined)
          put({ ...candidate, revision: core.revision, parentId: card.blockId })
      }
    }
    updateCard(card, "running")
  }

  return { cardFor, updateCard, groupCards, bindFanOut, bindChild }
}
