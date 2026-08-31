import type { Run, RunEvent } from "generalist/runtime"
import * as Projection from "@rika/product/execution-projection"
import * as UnitOrder from "@rika/product/execution-transcript-contract"
import type { Unit } from "@rika/product/execution-transcript-contract"
import * as Authorization from "../authorization"
import * as Cell from "../cell/state"
import * as Diagnostic from "../diagnostic"
import * as SubagentCard from "../subagent/card"
import * as SemanticResponse from "../semantic/response"
import type { SemanticTreeEvent } from "../semantic/event"
import * as Steering from "../steering"
import * as ToolUnit from "../tool/unit"
import * as Checkpoint from "../checkpoint"
import * as Usage from "../usage"
import type { Card, Node, Projector } from "../model"
import type { AuthorizationState, ProjectorCore } from "../persistence"
import * as ProjectorRecovery from "./projector-recovery"
import type { CheckpointInstrumentation } from "./projector-recovery"
import { projectorNames, textLimit } from "../values"
import type { ProjectorEventContext, ProjectorEventHandler } from "./projector-event-context"
import { RunLifecycleEvents } from "./projector-run-events"
import { ToolCellSubagentEvents } from "./projector-tool-events"
import { ModelUsageCompactionEvents } from "./projector-model-events"
import { SteeringNoopEvents } from "./projector-steering-events"
import { ProjectorSnapshot } from "./projector-snapshot"

import { providerCostNanoUsd, scopedId, token } from "../decoding"
import { Effect, Option } from "effect"
import { format } from "prettier"

export type { Projector }

const make = (
  turnId: string,
  prompt: string,
  resume?: Projection.Checkpoint,
  baselineUnits: ReadonlyArray<Unit> = [],
  titleExpected = false,
  pricing: "included" | "metered" = "metered",
  instrumentation?: CheckpointInstrumentation,
): Projector => {
  const localId = (family: string, ...parts: ReadonlyArray<string | number>): string =>
    scopedId(family, turnId, ...parts)
  const usage = Usage.makeUsageAccounting(pricing)
  const { deactivate, recordAttempt, settleOpenAttempts } = usage
  const core: ProjectorCore = {
    revision: 0,
    checkpoint: undefined,
    historyOmitted: false,
    rootStatus: "running",
    title: undefined,
    steeringMessages: 0,
    followUpMessages: 0,
  }
  const units = new Map<string, Unit>()
  const nodes = new Map<string, Node>()
  const cardsByInvocation = new Map<string, Card>()
  const cardsByChild = new Map<string, Card>()
  const unitKeysByRun = new Map<string, Set<string>>()
  const authorizations = new Map<string, AuthorizationState>()
  const recoveryOptions: Parameters<typeof ProjectorRecovery.makeProjectorRecoveryIndex>[0] =
    instrumentation === undefined ? { nodes } : { instrumentation, nodes }
  const recovery = ProjectorRecovery.makeProjectorRecoveryIndex(recoveryOptions)
  let changed = new Map<string, Unit>()
  let removed = new Set<string>()
  let createdInBatch = new Set<string>()
  let semanticOrderPart: number | undefined
  let titleSettled = !titleExpected

  const projectionState = (): Projection.ProjectionState => {
    const state: Projection.ProjectionState =
      core.title === undefined
        ? {
            status: core.rootStatus,
            usage: {
              ...structuredClone(usage.usage()),
              sourceComplete:
                titleSettled &&
                (core.rootStatus === "completed" || core.rootStatus === "failed" || core.rootStatus === "cancelled"),
              contextPending: usage.contextPending(),
              active: usage.activeTime(),
            },
            steering: steering.summary(core.steeringMessages, core.followUpMessages),
          }
        : {
            status: core.rootStatus,
            steering: steering.summary(core.steeringMessages, core.followUpMessages),
            title: core.title,
            usage: {
              ...structuredClone(usage.usage()),
              sourceComplete:
                titleSettled &&
                (core.rootStatus === "completed" || core.rootStatus === "failed" || core.rootStatus === "cancelled"),
              contextPending: usage.contextPending(),
              active: usage.activeTime(),
            },
          }
    return state
  }

  const put = (unit: Unit) => {
    if (!units.has(unit.key) && !removed.has(unit.key)) createdInBatch.add(unit.key)
    units.set(unit.key, unit)
    changed.set(unit.key, unit)
    removed.delete(unit.key)
  }

  const remove = (key: string) => {
    if (!units.delete(key)) return
    changed.delete(key)
    if (createdInBatch.delete(key)) return
    removed.add(key)
  }

  const parentUnit = (node: Node): Unit | undefined =>
    node.parentUnitKey === undefined ? undefined : units.get(node.parentUnitKey)

  const orderFor = (node: Node, key: string, part = 0): Unit["order"] => {
    const local = UnitOrder.unitOrder(key, core.revision, part)
    const parent = parentUnit(node)
    return parent === undefined ? local : UnitOrder.childOrder(parent.order, node.publicId, local)
  }

  const parentBlockIdOf = (node: Node): string | undefined =>
    node.parentBlockId ?? cardsByChild.get(node.rawRunId)?.blockId

  const unit = (node: Node, key: string, content: Unit["content"], part = 0): Unit => {
    const orderPart = semanticOrderPart === undefined ? part : semanticOrderPart++
    const parentId = parentBlockIdOf(node)
    let emitted = unitKeysByRun.get(node.rawRunId)
    if (emitted === undefined) {
      emitted = new Set()
      unitKeysByRun.set(node.rawRunId, emitted)
    }
    emitted.add(key)
    const order = units.get(key)?.order ?? orderFor(node, key, orderPart)
    return parentId === undefined
      ? { content, key, order, revision: core.revision, turnId }
      : { content, key, order, parentId, revision: core.revision, turnId }
  }

  const steering = Steering.makeSteeringProjection({ turnId, put, unit })

  const { notice, error, modelFailureError, executionFailureError } = Diagnostic.makeDiagnosticProjection({
    turnId,
    localId,
    put,
    unit,
    get: (key) => units.get(key),
  })

  const { putAuthorization, resolveAuthorization, settleAuthorizations } = Authorization.makeAuthorizationProjection({
    core,
    units,
    authorizations,
    localId,
    put,
    unit,
    recover: recovery.authorizationChanged,
  })

  const { toolState, putTool, updateTool } = ToolUnit.makeToolUnitProjection({
    units,
    localId,
    put,
    unit,
    recover: recovery.toolChanged,
  })

  const { openCell, progressCell, completeCell, settleRunningCells } = Cell.makeCellProjection({
    units,
    localId,
    put,
    unit,
    recover: recovery.cellChanged,
    activeIds: recovery.activeCellIds,
    notice,
    error,
  })
  const formattedCellSources = new Map<string, string>()

  const { cardFor, updateCard, groupCards, bindChild } = SubagentCard.makeSubagentCardProjection({
    core,
    units,
    nodes,
    unitKeysByRun,
    cardsByInvocation,
    cardsByChild,
    localId,
    put,
    unit,
    recoverCard: recovery.cardChanged,
    recoverNode: recovery.nodeChanged,
  })

  const semanticResponse = SemanticResponse.makeSemanticResponseProjection({
    localId,
    put,
    unit,
    openCell,
    cardFor,
    groupCards,
    removeTool: (node, rawId) => remove(toolState(node, rawId).key),
    putTool,
    notice,
    beginOrderedResponse: () => {
      semanticOrderPart = 0
    },
    endOrderedResponse: () => {
      semanticOrderPart = undefined
    },
  })

  const nodeFor = (input: SemanticTreeEvent): Node => {
    const current = nodes.get(input.runId)
    if (current !== undefined) return current
    const card = cardsByChild.get(input.runId)
    const hidden = input.invocationId === projectorNames.titleInvocationId
    const base: Node = {
      rawRunId: input.runId,
      publicId:
        card?.publicId ??
        (input.parentRunId === undefined ? "root" : localId("subagent", turnId, input.invocationId ?? "orphan")),
      hidden,
      tools: new Map(),
      cells: new Map(),
      phase: -1,
      status: "running",
      lifecycle: "unknown",
      started: false,
    }
    let created: Node
    if (card !== undefined && input.parentRunId !== undefined) {
      created = { ...base, parentBlockId: card.blockId, parentRawRunId: input.parentRunId, parentUnitKey: card.unitKey }
    } else if (card !== undefined) {
      created = { ...base, parentBlockId: card.blockId, parentUnitKey: card.unitKey }
    } else if (input.parentRunId !== undefined) {
      created = { ...base, parentRawRunId: input.parentRunId }
    } else {
      created = base
    }
    nodes.set(input.runId, created)
    return created
  }

  const settleNodeState = (node: Node, status: "completed" | "failed" | "cancelled", detail?: string) => {
    node.status = status
    settleRunningCells(node, status === "completed" ? "cancelled" : status)
    for (const rawId of recovery.activeToolIds(node))
      updateTool(node, rawId, (tool) =>
        tool.status === "running" && tool.process?.running !== true
          ? { ...tool, status: status === "completed" ? "cancelled" : status }
          : tool,
      )
    const card = cardsByChild.get(node.rawRunId)
    if (card !== undefined) updateCard(card, status === "completed" ? "complete" : status, detail)
    if (node.parentRawRunId === undefined) core.rootStatus = status
    recovery.nodeChanged(node)
  }

  const settleNode = (
    node: Node,
    status: "completed" | "failed" | "cancelled",
    event: RunEvent.RunEvent,
    detail?: string,
  ) => {
    settleNodeState(node, status, detail)
    const descendants: Array<Node> = []
    const collect = (id: string): void => {
      for (const candidate of recovery.childrenOf(id)) {
        descendants.push(candidate)
        collect(candidate.rawRunId)
      }
    }
    collect(node.rawRunId)
    for (const candidate of descendants) {
      if (candidate.status === "completed" || candidate.status === "failed" || candidate.status === "cancelled")
        continue
      if (candidate.lifecycle !== "terminal") {
        deactivate(candidate, event, "terminal")
        settleOpenAttempts(candidate)
        settleAuthorizations(candidate, "cancelled")
      }
      settleNodeState(candidate, "cancelled")
    }
  }

  const eventContext: ProjectorEventContext = {
    core,
    units,
    nodes,
    cardsByInvocation,
    cardsByChild,
    formattedCellSources,
    usage,
    recovery,
    semanticResponse,
    steering,
    localId,
    put,
    remove,
    unit,
    settleNode,
    authorization: { putAuthorization, resolveAuthorization, settleAuthorizations },
    cells: { openCell, progressCell, completeCell },
    diagnostics: { notice, error, modelFailureError, executionFailureError },
    subagents: { cardFor, updateCard, groupCards, bindChild },
    tools: { toolState, putTool, updateTool },
  }
  const eventHandlers: ReadonlyArray<ProjectorEventHandler> = [
    RunLifecycleEvents.handle,
    ToolCellSubagentEvents.handle,
    ModelUsageCompactionEvents.handle,
    SteeringNoopEvents.handle,
  ]

  const applyRunEvent = (treeEvent: SemanticTreeEvent): void => {
    const node = nodeFor(treeEvent)
    if (eventHandlers.some((handler) => handler(eventContext, treeEvent, node))) return
    throw new TypeError(`Unsupported Generalist Run event: ${treeEvent.event._tag}`)
  }

  const { serialize, restore } = Checkpoint.makeProjectorCheckpointCodec({
    turnId,
    baselineUnits,
    core,
    usage,
    units,
    nodes,
    cardsByInvocation,
    cardsByChild,
    authorizations,
    pendingSteering: steering.pending,
    settledSteering: steering.settled,
    recovery,
  })

  if (resume === undefined) {
    const promptKey = `turn:${turnId}:user`
    const chunks =
      prompt.length === 0
        ? [""]
        : Array.from({ length: Math.ceil(prompt.length / textLimit) }, (_, index) =>
            prompt.slice(index * textLimit, (index + 1) * textLimit),
          )
    for (const [index, text] of chunks.entries()) {
      const key = index === 0 ? promptKey : `${promptKey}:chunk:${index}`
      units.set(key, {
        key,
        turnId,
        order: UnitOrder.unitOrder(key, -1, index),
        revision: 0,
        content: { _tag: "Entry", role: "user", text },
      })
    }
  } else restore(resume)

  const applyAll = (inputs: ReadonlyArray<SemanticTreeEvent>): Projection.Patch => {
    const first = inputs[0]
    const last = inputs.at(-1)
    if (first === undefined || last === undefined) throw new RangeError("A projector batch must contain an event")
    if (nodes.size === 0)
      nodes.set(first.rootRunId, {
        rawRunId: first.rootRunId,
        publicId: "root",
        hidden: false,
        tools: new Map(),
        cells: new Map(),
        phase: -1,
        status: "running",
        lifecycle: "unknown",
        started: false,
      })
    changed = new Map()
    removed = new Set()
    createdInBatch = new Set()
    const baseRevision = core.revision
    for (const input of inputs) {
      core.revision += 1
      applyRunEvent(input)
      const node = nodes.get(input.runId)
      if (node !== undefined) recovery.nodeChanged(node)
    }
    core.checkpoint = {
      version: Projection.projectionVersion,
      cursor: String(last.cursor),
      state: serialize(),
    }
    return {
      _tag: "ProjectionPatch",
      baseRevision,
      revision: core.revision,
      checkpoint: core.checkpoint,
      upsert: [...changed.values()],
      remove: [...removed],
      state: projectionState(),
    }
  }

  const applyTitle = (
    text: string | undefined,
    titleUsage: ReadonlyArray<Run.RawUsageFact>,
  ): Projection.Patch | undefined => {
    const checkpoint = core.checkpoint
    if (checkpoint === undefined) throw new RangeError("A root event must be projected before its title")
    const before = JSON.stringify(usage.usage())
    const settlementChanged = !titleSettled
    titleSettled = true
    const titleNode: Node = {
      rawRunId: `${turnId}:title`,
      publicId: "title",
      hidden: true,
      tools: new Map(),
      cells: new Map(),
      phase: 0,
      status: "completed",
      lifecycle: "terminal",
      started: true,
    }
    for (const fact of titleUsage) {
      const key = localId("usage", "title", fact.modelAttemptId)
      if (fact._tag === "Completed")
        recordAttempt({
          key,
          node: titleNode,
          modelCallId: fact.modelCallId,
          inputTotal: token(fact.usage.inputTokens.total),
          inputUncached: token(fact.usage.inputTokens.uncached),
          inputCacheRead: token(fact.usage.inputTokens.cacheRead),
          inputCacheWrite: token(fact.usage.inputTokens.cacheWrite),
          outputTotal: token(fact.usage.outputTokens.total),
          outputText: token(fact.usage.outputTokens.text),
          outputReasoning: token(fact.usage.outputTokens.reasoning),
          costNanoUsd: providerCostNanoUsd(fact),
        })
      else
        recordAttempt({
          key,
          node: titleNode,
          modelCallId: fact.modelCallId,
          inputTotal: token(fact.providerUsage.inputTokens),
          outputTotal: token(fact.providerUsage.outputTokens),
          failedProviderTotal: token(fact.providerUsage.totalTokens),
          costNanoUsd: providerCostNanoUsd(fact),
        })
    }
    const changedTitle = text !== undefined && core.title?.text !== text
    if (!settlementChanged && !changedTitle && JSON.stringify(usage.usage()) === before) return undefined
    changed = new Map()
    removed = new Set()
    createdInBatch = new Set()
    const baseRevision = core.revision
    core.revision += 1
    if (text !== undefined) core.title = { text }
    core.checkpoint = { ...checkpoint, state: serialize() }
    return {
      _tag: "ProjectionPatch",
      baseRevision,
      revision: core.revision,
      checkpoint: core.checkpoint,
      upsert: [],
      remove: [],
      state: projectionState(),
    }
  }

  return {
    snapshot: () => ProjectorSnapshot.snapshot(units, core, projectionState),
    apply: (input) => applyAll([input]),
    applyAll: (inputs) => applyAll(inputs),
    formatCellSource: Effect.fn("TreeProjector.formatCellSource")(function* (
      runId: string,
      id: string,
      source: string,
    ) {
      const key = `${runId}\u0000${id}`
      const formatted = yield* Effect.tryPromise(() =>
        format(source, { parser: "typescript", printWidth: 120, semi: false }),
      ).pipe(Effect.option)
      if (Option.isSome(formatted)) formattedCellSources.set(key, formatted.value)
      else formattedCellSources.delete(key)
    }),
    previewRunIds: () =>
      [...cardsByChild].flatMap(([runId, card]) => {
        const candidate = units.get(card.unitKey)
        if (candidate?.content._tag !== "Block" || candidate.content.block._tag !== "SubagentCard") return [runId]
        const status = candidate.content.block.status
        return status === "complete" || status === "failed" || status === "cancelled" ? [] : [runId]
      }),
    previewParentId: (runId) => cardsByChild.get(runId)?.blockId,
    applyTitle,
  }
}

export const TreeProjector = { make, authorizationTarget: Checkpoint.authorizationTarget }
export const titleInvocationId = projectorNames.titleInvocationId
