import { Catalog } from "@rika/coding-tools/coding-tool-catalog"
import type { Block } from "../schema/transcript-presentation-model"
import type { SourceEvent } from "../schema/transcript-source-event"
import type { MutableMutation, OwnedFold } from "./transcript-fold-state"
import { foldState } from "./transcript-fold-state"
import { mutationOperations } from "./transcript-fold-mutation"
const { linkedToolFor, removeUnit, updateTool, upsertUnit } = mutationOperations
const { childBlockFrom, enumerateKeys, makeUnit, sourcePayload, string } = foldState
import { identityKey } from "../ordering/transcript-unit-identity"

import { executionKey } from "../ordering/child-parent-correlation"

type ChildStatus = "running" | "complete" | "failed" | "cancelled"

const childLifecycleStatus = (event: SourceEvent): ChildStatus | undefined => {
  switch (event.type) {
    case "child_run.spawned":
    case "child_run.started":
      return "running"
    case "child_run.completed":
      return "complete"
    case "child_run.failed":
      return "failed"
    case "child_run.cancelled":
      return "cancelled"
    default:
      return undefined
  }
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
  const payload = sourcePayload(event)
  const childId = string(payload.child_execution_id)
  const correlatedToolId = string(payload.invocation_id ?? payload.tool_call_id)
  if (childId.length === 0 || correlatedToolId.length === 0) return
  const status = childLifecycleStatus(event) ?? "running"
  const linkedTool = linkedToolFor(value, turnId, childId, correlatedToolId)
  if (linkedTool !== undefined) {
    const id = linkedTool.id
    const updated = updateTool(value, change, id, event.sequence, (tool) => ({
      ...tool,
      childId,
      status,
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
    status,
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
