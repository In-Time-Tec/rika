import { Function, Schema } from "effect"
import { Block } from "@rika/transcript/transcript-presentation-model"
import type { Unit } from "@rika/transcript/transcript-unit"
import type { Model } from "../../state/model"
import { isDeliveredDelegationOutput, isFailedDelegationOutput, isSucceededDelegationOutput } from "./agent-response"

type ExecutionOutcome = NonNullable<Unit["executionOutcome"]>
interface ExecutionOutcomeSource {
  readonly owner: string
  readonly outcome: ExecutionOutcome
  readonly revision: number
}

export const outcomeShadow = new WeakMap<Block, { readonly outcome: ExecutionOutcome; readonly applied: Block }>()
const outcomeBase = new WeakMap<Block, Block>()
const outcomeSources = new WeakMap<object, ReadonlyMap<string, ExecutionOutcomeSource>>()
const decodeBlocks = Schema.decodeUnknownSync(Schema.Array(Block))
const ExecutionOutcomeSchema = Schema.Struct({
  status: Schema.Literals(["cancelled", "complete", "failed"]),
  reason: Schema.optionalKey(Schema.String),
})
const decodeOutcomes = Schema.decodeUnknownSync(Schema.Record(Schema.String, ExecutionOutcomeSchema))

const applyExecutionOutcome = (model: Model, parentId: string, outcome: ExecutionOutcome): Model => {
  const blocks = [...decodeBlocks(model.blocks)]
  const index = blocks.findIndex(
    (block) =>
      (block._tag === "ToolCall" && block.id === parentId && block.presentation.family === "agent") ||
      (block._tag === "SubagentCard" && block.id === parentId),
  )
  const block = blocks[index]
  if (block?._tag === "SubagentCard") {
    if (block.status !== "running") return model
    blocks[index] = { ...block, status: outcome.status }
    return { ...model, blocks }
  }
  if (block?._tag !== "ToolCall") return model
  const base = outcomeBase.get(block) ?? block
  if (base._tag !== "ToolCall") return model
  if (outcome.status === "complete" && isFailedDelegationOutput(base.result)) return model
  if (outcome.status === "failed" && isDeliveredDelegationOutput(base.result)) return model
  const { result: _, ...withoutResult } = base
  const keepsResult = outcome.reason === undefined && isSucceededDelegationOutput(base.result)
  const applied =
    outcome.reason === undefined
      ? { ...(keepsResult ? base : withoutResult), status: outcome.status }
      : { ...withoutResult, status: outcome.status, result: outcome.reason }
  blocks[index] = applied
  outcomeBase.set(applied, base)
  outcomeShadow.set(base, { outcome, applied })
  return { ...model, blocks }
}

const restoreExecutionOutcome = (model: Model, parentId: string): Model => {
  const blocks = decodeBlocks(model.blocks)
  const index = blocks.findIndex(
    (block) => block._tag === "ToolCall" && block.id === parentId && block.presentation.family === "agent",
  )
  const current = blocks[index]
  if (current === undefined) return model
  const base = outcomeBase.get(current)
  if (base === undefined) return model
  const restored = [...blocks]
  restored[index] = base
  return { ...model, blocks: restored }
}

const latestOutcomeFor = (
  sources: ReadonlyMap<string, ExecutionOutcomeSource>,
  owner: string,
): ExecutionOutcome | undefined => {
  let selected: { readonly key: string; readonly source: ExecutionOutcomeSource } | undefined
  for (const [key, source] of sources) {
    if (source.owner !== owner) continue
    if (
      selected === undefined ||
      source.revision > selected.source.revision ||
      (source.revision === selected.source.revision && key > selected.key)
    )
      selected = { key, source }
  }
  return selected?.source.outcome
}

interface SourceUpdate {
  readonly sources: ReadonlyMap<string, ExecutionOutcomeSource>
  readonly changedOwners: ReadonlySet<string>
  readonly changed: boolean
}

const updateSources = (
  current: ReadonlyMap<string, ExecutionOutcomeSource>,
  units: ReadonlyArray<Unit>,
  removedKeys: ReadonlyArray<string>,
  writtenToolIds: ReadonlySet<string>,
  parentId?: string,
): SourceUpdate => {
  const sources = new Map(current)
  const changedOwners = new Set<string>()
  let changed = false
  for (const key of removedKeys) {
    const previous = sources.get(key)
    if (previous === undefined) continue
    sources.delete(key)
    changedOwners.add(previous.owner)
    changed = true
  }
  for (const candidate of units) {
    const owner = parentId ?? candidate.parentId
    const previous = sources.get(candidate.key)
    if (candidate.executionOutcome === undefined || owner === undefined) {
      if (previous === undefined) continue
      sources.delete(candidate.key)
      changedOwners.add(previous.owner)
      changed = true
      continue
    }
    if (
      previous?.owner === owner &&
      previous.outcome === candidate.executionOutcome &&
      previous.revision === candidate.revision
    )
      continue
    sources.set(candidate.key, { owner, outcome: candidate.executionOutcome, revision: candidate.revision })
    if (previous !== undefined) changedOwners.add(previous.owner)
    changedOwners.add(owner)
    changed = true
  }
  for (const owner of writtenToolIds) changedOwners.add(owner)
  return { sources, changedOwners, changed }
}

const reconcileOutcomes = (
  current: Readonly<Record<string, ExecutionOutcome>>,
  sources: ReadonlyMap<string, ExecutionOutcomeSource>,
  changedOwners: ReadonlySet<string>,
): Readonly<Record<string, ExecutionOutcome>> => {
  const changed = new Map(Object.entries(current))
  for (const owner of changedOwners) {
    const next = latestOutcomeFor(sources, owner)
    if (next === undefined) changed.delete(owner)
    else changed.set(owner, next)
  }
  return Object.fromEntries(changed)
}

const updateExecutionOutcomesImpl = (
  model: Model,
  units: ReadonlyArray<Unit>,
  removedKeys: ReadonlyArray<string>,
  writtenToolIds: ReadonlySet<string>,
  parentId?: string,
): Model => {
  const currentOutcomes = decodeOutcomes(model.childExecutionOutcomes)
  const currentSources = outcomeSources.get(model.childExecutionOutcomes) ?? new Map<string, ExecutionOutcomeSource>()
  const sourceUpdate = updateSources(currentSources, units, removedKeys, writtenToolIds, parentId)
  const { sources, changedOwners } = sourceUpdate
  const sourcesChanged = sourceUpdate.changed
  if (!sourcesChanged && changedOwners.size === 0) return model
  const outcomes = reconcileOutcomes(currentOutcomes, sources, changedOwners)
  const outcomesChanged = sourcesChanged || changedOwners.size > 0
  const outcomeRecord = outcomesChanged ? outcomes : currentOutcomes
  if (sourcesChanged) outcomeSources.set(outcomeRecord, sources)
  let projected: Model = outcomesChanged ? { ...model, childExecutionOutcomes: outcomeRecord } : model
  for (const owner of changedOwners) {
    projected = restoreExecutionOutcome(projected, owner)
    const outcome = outcomes[owner]
    if (outcome !== undefined) projected = applyExecutionOutcome(projected, owner, outcome)
  }
  return projected
}

export const updateExecutionOutcomes: {
  (
    arg0: Parameters<typeof updateExecutionOutcomesImpl>[0],
    arg1: Parameters<typeof updateExecutionOutcomesImpl>[1],
    arg2: Parameters<typeof updateExecutionOutcomesImpl>[2],
    arg3: Parameters<typeof updateExecutionOutcomesImpl>[3],
    arg4?: Parameters<typeof updateExecutionOutcomesImpl>[4],
  ): ReturnType<typeof updateExecutionOutcomesImpl>
  (
    arg1: Parameters<typeof updateExecutionOutcomesImpl>[1],
    arg2: Parameters<typeof updateExecutionOutcomesImpl>[2],
    arg3: Parameters<typeof updateExecutionOutcomesImpl>[3],
    arg4?: Parameters<typeof updateExecutionOutcomesImpl>[4],
  ): (arg0: Parameters<typeof updateExecutionOutcomesImpl>[0]) => ReturnType<typeof updateExecutionOutcomesImpl>
} = Function.dual((args) => args.length >= 4, updateExecutionOutcomesImpl)
