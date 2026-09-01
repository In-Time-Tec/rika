import { agentProfile } from "@rika/transcript/subagent-presentation"
import type { Block, Unit } from "@rika/product/execution-transcript-contract"
import type { Card, Node } from "../model"
import type { ProjectorCore } from "../persistence"
import { bounded, projectorNames, toolTextLimit } from "../values"
import { promptText } from "../decoding"
import type { RunEvent } from "generalist/runtime"
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
export const SubagentGroupResult = Schema.Struct({
  status: Schema.optionalKey(Schema.String),
  children: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        key: Schema.String,
        status: Schema.String,
        text: Schema.optionalKey(Schema.String),
        message: Schema.optionalKey(Schema.String),
        reason: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
})
export type SubagentGroupResult = typeof SubagentGroupResult.Type
type ChildLinked = Extract<RunEvent.RunEvent, { readonly _tag: "ChildLinked" }>
type CardStatus = Extract<Block, { readonly _tag: "SubagentCard" }>["status"]
type GroupStatus = Extract<Block, { readonly _tag: "SubagentGroup" }>["status"]

const cardStatusFromGroupMember = (status: string): CardStatus => {
  switch (status.toLowerCase()) {
    case "succeeded":
      return "complete"
    case "failed":
      return "failed"
    case "cancelled":
    case "abandoned":
      return "cancelled"
    case "running":
      return "running"
    default:
      return "queued"
  }
}

const settledGroupStatus = (status: string, isFailure: boolean): GroupStatus => {
  if (isFailure || status === "failed") return "failed"
  if (status === "cancelled" || status === "canceled") return "cancelled"
  return "complete"
}

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
  readonly updateCard: (card: Card, status: CardStatus, output?: string) => void
  readonly groupCards: (node: Node, rawToolCallId: string, params: SubagentGroupParams) => ReadonlyArray<Card>
  readonly settleGroup: (
    node: Node,
    rawToolCallId: string,
    result: SubagentGroupResult | undefined,
    isFailure: boolean,
  ) => void
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

  type CardBlock = Extract<Block, { readonly _tag: "SubagentCard" }>
  type GroupBlock = Extract<Block, { readonly _tag: "SubagentGroup" }>
  const groupIdFor = (node: Node, rawToolCallId: string) => localId("subagent-group", node.publicId, rawToolCallId)
  const groupUnitKeyFor = (node: Node, rawToolCallId: string) =>
    localId("subagent-group-unit", node.publicId, rawToolCallId)
  const groupCounts = (memberIds: ReadonlyArray<string>): GroupBlock["counts"] => {
    const statuses = [...units.values()].flatMap((candidate) => {
      if (candidate.content._tag !== "Block" || candidate.content.block._tag !== "SubagentCard") return []
      return memberIds.includes(candidate.content.block.id) ? [candidate.content.block.status] : []
    })
    const count = (status: CardBlock["status"]) => statuses.filter((candidate) => candidate === status).length
    return {
      total: memberIds.length,
      queued: count("queued"),
      running: count("running"),
      waiting: count("waiting"),
      cancelling: count("cancelling"),
      complete: count("complete"),
      failed: count("failed"),
      cancelled: count("cancelled"),
    }
  }
  const groupStatus = (group: GroupBlock, counts: GroupBlock["counts"]): GroupBlock["status"] => {
    if (!group.settled) {
      if (counts.cancelling > 0) return "cancelling"
      return counts.queued === counts.total ? "queued" : "running"
    }
    if (counts.failed > 0 || group.status === "failed") return "failed"
    if (counts.cancelled > 0 || group.status === "cancelled") return "cancelled"
    return "complete"
  }
  const syncGroups = (memberId?: string) => {
    for (const candidate of units.values()) {
      if (candidate.content._tag !== "Block" || candidate.content.block._tag !== "SubagentGroup") continue
      const group = candidate.content.block
      if (memberId !== undefined && !group.memberIds.includes(memberId)) continue
      const counts = groupCounts(group.memberIds)
      put({
        ...candidate,
        revision: core.revision,
        content: { _tag: "Block", block: { ...group, counts, status: groupStatus(group, counts) } },
      })
    }
  }

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
      name: card.label ?? agentProfile(card.selection),
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

  const updateCard = (card: Card, status: CardStatus, output?: string) => {
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
    syncGroups(card.publicId)
  }

  const groupCards = (node: Node, rawToolCallId: string, params: SubagentGroupParams) => {
    const members = params.members.filter((member) => member.key.length > 0 && member.prompt.length > 0)
    const groupId = groupIdFor(node, rawToolCallId)
    const groupUnitKey = groupUnitKeyFor(node, rawToolCallId)
    const memberIds = members.map((member) =>
      localId("subagent", node.publicId, `${rawToolCallId}:${member.key}`, member.key),
    )
    const current = units.get(groupUnitKey)
    if (current?.content._tag !== "Block" || current.content.block._tag !== "SubagentGroup") {
      const counts = groupCounts(memberIds)
      const block: GroupBlock = {
        _tag: "SubagentGroup",
        id: groupId,
        name: `${memberIds.length} ${memberIds.length === 1 ? "agent" : "agents"}`,
        status: "queued",
        settled: false,
        memberIds,
        counts,
      }
      put(unit(node, groupUnitKey, { _tag: "Block", block }, 0))
    }
    const cards: Array<Card> = []
    for (const [index, member] of members.entries()) {
      const card = cardFor(
        node,
        `${rawToolCallId}:${member.key}`,
        member.selection,
        member.prompt,
        member.label,
        member.key,
        index + 1,
      )
      cards.push(card)
      const cardUnit = units.get(card.unitKey)
      if (cardUnit !== undefined && cardUnit.parentId !== groupId)
        put({ ...cardUnit, revision: core.revision, parentId: groupId })
    }
    syncGroups()
    return cards
  }

  const settleGroup = (
    node: Node,
    rawToolCallId: string,
    result: SubagentGroupResult | undefined,
    isFailure: boolean,
  ) => {
    const candidate = units.get(groupUnitKeyFor(node, rawToolCallId))
    if (candidate?.content._tag !== "Block" || candidate.content.block._tag !== "SubagentGroup") return
    for (const member of result?.children ?? []) {
      const card = cardsByInvocation.get(`${node.rawRunId}\u0000${rawToolCallId}:${member.key}`)
      if (card === undefined) continue
      updateCard(card, cardStatusFromGroupMember(member.status), member.text ?? member.message ?? member.reason)
    }
    const group = {
      ...candidate.content.block,
      settled: true,
      status: settledGroupStatus((result?.status ?? "").toLowerCase(), isFailure),
    }
    const counts = groupCounts(group.memberIds)
    put({
      ...candidate,
      revision: core.revision,
      content: { _tag: "Block", block: { ...group, counts, status: groupStatus(group, counts) } },
    })
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

  return { cardFor, updateCard, groupCards, settleGroup, bindChild }
}
