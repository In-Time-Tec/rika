import { childParentMatch, type Unit } from "@rika/transcript"
import type { Model, TranscriptBlock, TranscriptItem } from "../view-state"
import { projectChildUnits } from "./projection"

export interface ChildProjection {
  readonly units: ReadonlyArray<Unit>
  readonly revision: number
}

export interface AttachmentResult {
  readonly model: Model
  readonly attachments: ReadonlyMap<string, number>
  readonly unattached: ReadonlyArray<string>
}

export const emptyAttachments: ReadonlyMap<string, number> = new Map()

const childParent = (
  model: Model,
  turnId: string,
): Extract<TranscriptBlock, { readonly _tag: "ToolCall" }> | undefined => {
  const blocks = model.blocks as ReadonlyArray<TranscriptBlock>
  const candidates = (model.items as ReadonlyArray<TranscriptItem>).flatMap((item) => {
    if (item._tag !== "Block") return []
    const block = blocks[item.index]
    if ((block as { readonly _tag?: unknown } | undefined)?._tag !== "ToolCall") return []
    const tool = block as Extract<TranscriptBlock, { readonly _tag: "ToolCall" }>
    return [{ id: tool.id, scope: item.turnId ?? "", childId: tool.childId, family: tool.presentation.family, tool }]
  })
  return childParentMatch(candidates, turnId)?.tool
}

export const attachChildProjections = (
  model: Model,
  replayTurns: { readonly has: (turnId: string) => boolean },
  availableProjections: ReadonlyMap<string, ChildProjection>,
  attachments: ReadonlyMap<string, number> = emptyAttachments,
): AttachmentResult => {
  let next = model
  let nextAttachments: Map<string, number> | undefined
  let advanced = true
  while (advanced) {
    advanced = false
    for (const [turnId, projection] of availableProjections) {
      if (replayTurns.has(turnId)) continue
      if ((nextAttachments ?? attachments).get(turnId) === projection.revision) continue
      const parent = childParent(next, turnId)
      if (parent === undefined) continue
      next = projectChildUnits(next, parent.id, projection.units)
      nextAttachments ??= new Map(attachments)
      nextAttachments.set(turnId, projection.revision)
      advanced = true
    }
  }
  const settledAttachments = nextAttachments ?? attachments
  const unattached: Array<string> = []
  for (const [turnId, projection] of availableProjections) {
    if (replayTurns.has(turnId)) continue
    if (settledAttachments.get(turnId) === projection.revision) continue
    if (childParent(next, turnId) === undefined) unattached.push(turnId)
  }
  return { model: next, attachments: settledAttachments, unattached }
}
