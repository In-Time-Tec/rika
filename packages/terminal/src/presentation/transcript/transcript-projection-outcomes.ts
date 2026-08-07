import { Function } from "effect"
import type { Block } from "@rika/transcript/transcript-presentation-model"
import type { Unit } from "@rika/transcript/transcript-unit"
import type { Model } from "../../state/model/terminal-state"
import {
  isDeliveredDelegationOutput,
  isFailedDelegationOutput,
  isSucceededDelegationOutput,
} from "./transcript-agent-response"

type ExecutionOutcome = NonNullable<Unit["executionOutcome"]>
interface ExecutionOutcomeSource {
  readonly owner: string
  readonly outcome: ExecutionOutcome
  readonly revision: number
}

export const outcomeShadow = new WeakMap<Block, { readonly outcome: ExecutionOutcome; readonly applied: Block }>()
const outcomeBase = new WeakMap<Block, Block>()
const outcomeSources = new WeakMap<object, ReadonlyMap<string, ExecutionOutcomeSource>>()

const applyExecutionOutcome = (model: Model, parentId: string, outcome: ExecutionOutcome): Model => {
  const blocks = [...(model.blocks as ReadonlyArray<Block>)]
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
  if (outcome.status === "complete" && isFailedDelegationOutput(base.output)) return model
  if (outcome.status === "failed" && isDeliveredDelegationOutput(base.output)) return model
  const { output: _, ...withoutOutput } = base
  const keepsOutput = outcome.reason === undefined && isSucceededDelegationOutput(base.output)
  const applied = {
    ...(keepsOutput ? base : withoutOutput),
    status: outcome.status,
    ...(outcome.reason === undefined ? {} : { output: outcome.reason }),
  }
  blocks[index] = applied
  outcomeBase.set(applied, base)
  outcomeShadow.set(base, { outcome, applied })
  return { ...model, blocks }
}

const restoreExecutionOutcome = (model: Model, parentId: string): Model => {
  const blocks = model.blocks as ReadonlyArray<Block>
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

const updateExecutionOutcomesImpl = (
  model: Model,
  units: ReadonlyArray<Unit>,
  removedKeys: ReadonlyArray<string>,
  writtenToolIds: ReadonlySet<string>,
  parentId?: string,
): Model => {
  const currentOutcomes = model.childExecutionOutcomes as Readonly<Record<string, ExecutionOutcome>>
  const currentSources = outcomeSources.get(model.childExecutionOutcomes) ?? new Map<string, ExecutionOutcomeSource>()
  let sources = currentSources
  let sourcesChanged = false
  const changedOwners = new Set<string>()
  const writeSources = () => {
    if (sourcesChanged) return sources as Map<string, ExecutionOutcomeSource>
    sources = new Map(sources)
    sourcesChanged = true
    return sources as Map<string, ExecutionOutcomeSource>
  }
  for (const key of removedKeys) {
    const previous = sources.get(key)
    if (previous === undefined) continue
    writeSources().delete(key)
    changedOwners.add(previous.owner)
  }
  for (const candidate of units) {
    const owner = parentId ?? candidate.parentId
    const previous = sources.get(candidate.key)
    if (candidate.executionOutcome === undefined || owner === undefined) {
      if (previous !== undefined) {
        writeSources().delete(candidate.key)
        changedOwners.add(previous.owner)
      }
      continue
    }
    if (
      previous?.owner === owner &&
      previous.outcome === candidate.executionOutcome &&
      previous.revision === candidate.revision
    )
      continue
    writeSources().set(candidate.key, {
      owner,
      outcome: candidate.executionOutcome,
      revision: candidate.revision,
    })
    if (previous !== undefined) changedOwners.add(previous.owner)
    changedOwners.add(owner)
  }
  for (const owner of writtenToolIds) changedOwners.add(owner)
  if (!sourcesChanged && changedOwners.size === 0) return model
  const outcomes = { ...currentOutcomes }
  let outcomesChanged = sourcesChanged
  for (const owner of changedOwners) {
    const next = latestOutcomeFor(sources, owner)
    if (next === undefined) {
      if (outcomes[owner] !== undefined) {
        delete outcomes[owner]
        outcomesChanged = true
      }
    } else if (outcomes[owner] !== next) {
      outcomes[owner] = next
      outcomesChanged = true
    }
  }
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
