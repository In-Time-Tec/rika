import { Catalog } from "@rika/coding-tools/coding-tool-catalog"
import type { Block } from "../schema/transcript-presentation-model"
import type { SourceEvent } from "../schema/transcript-source-event"
import type { MutableMutation, OwnedFold } from "./transcript-fold-state"
import { foldState } from "./transcript-fold-state"
import { mutationOperations } from "./transcript-fold-mutation"
const { linkedToolFor, removeUnit, updateTool, upsertUnit } = mutationOperations
const { childBlockFrom, enumerateKeys, makeUnit, record, sourcePayload, string } = foldState
import { identityKey } from "../ordering/transcript-unit-identity"

import { executionKey } from "../ordering/child-parent-correlation"
const childStatus = (
  event: SourceEvent,
  value: Record<string, unknown>,
): "running" | "complete" | "failed" | "cancelled" => {
  const raw = string(value.status ?? value.state).toLowerCase()
  if (raw === "failed" || raw === "error") return "failed"
  if (raw === "cancelled" || raw === "canceled") return "cancelled"
  if (raw === "completed" || raw === "complete" || raw === "succeeded" || raw === "terminal") return "complete"
  if (event.type.includes("failed")) return "failed"
  if (event.type.includes("cancel")) return "cancelled"
  if (event.type.includes("terminal") || event.type.includes("completed")) return "complete"
  return "running"
}

const applyChild = ({
  value,
  change,
  turnId,
  event,
}: {
  readonly value: OwnedFold
  readonly change: MutableMutation
  readonly turnId: string
  readonly event: SourceEvent
}): void => {
  const outer = sourcePayload(event)
  const payload = Object.keys(record(outer.member)).length > 0 ? record(outer.member) : outer
  const childId = string(
    payload.child_execution_id ??
      payload.child_run_id ??
      payload.childId ??
      payload.child_id ??
      outer.child_execution_id ??
      outer.child_run_id ??
      outer.childId,
    event.cursor,
  )
  const correlatedToolId = string(payload.tool_call_id ?? payload.parent_tool_call_id)
  const linkedTool = linkedToolFor(value, turnId, childId, correlatedToolId)
  if (linkedTool !== undefined) {
    const id = linkedTool.id
    const nextStatus = childStatus(event, payload)
    const profile = Catalog.agentProfile(string(payload.profile ?? payload.preset_name ?? payload.name))
    const presentation = profile.length === 0 ? linkedTool.presentation : Catalog.resolveAgentPresentation(profile)
    const updated = updateTool(value, change, id, event.sequence, (tool) => ({
      ...tool,
      childId,
      status: nextStatus,
      presentation,
      ...(string(payload.summary ?? payload.output ?? payload.error).length === 0
        ? {}
        : { output: string(payload.summary ?? payload.output ?? payload.error) }),
    }))
    if (updated !== undefined) {
      const childKeys = value.childUnitsById.get(executionKey(childId))
      if (childKeys !== undefined)
        for (const child of enumerateKeys(value, childKeys)) removeUnit(value, change, child.key)
      return
    }
  }
  const key = identityKey("child", turnId, childId)
  const current = value.units.get(key)
  const previous = current === undefined ? undefined : childBlockFrom(current)
  const activity = string(payload.activity ?? payload.event ?? payload.detail ?? event.text)
  const block: Extract<Block, { _tag: "ChildAgent" }> = {
    _tag: "ChildAgent",
    id: childId,
    name: Catalog.agentProfile(
      string(payload.profile ?? payload.preset_name ?? payload.name, previous?.name ?? "child"),
    ),
    summary: string(payload.summary ?? payload.output ?? payload.error, previous?.summary ?? ""),
    status: childStatus(event, payload),
    activity: activity.length === 0 ? (previous?.activity ?? []) : [...(previous?.activity ?? []), activity],
  }
  upsertUnit(
    value,
    change,
    makeUnit(key, turnId, current?.order.at(-1)?.sequence ?? event.sequence, 0, event.sequence, {
      _tag: "Block",
      block,
    }),
  )
}

export { applyChild }
