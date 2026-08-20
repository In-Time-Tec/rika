import type { Run, RunEvent } from "tenetkit/runtime"
import * as Projection from "@rika/product/execution-projection"
import * as UnitOrder from "@rika/product/execution-transcript-contract"
import type { Unit } from "@rika/product/execution-transcript-contract"
import { completeTool } from "./tool"
import { makeAuthorizationProjection } from "./authorization"
import { cellToolName, makeCellProjection } from "./cell"
import { makeDiagnosticProjection } from "./diagnostic"
import { makeSubagentCardProjection } from "./subagent-card"
import { makeSemanticResponseProjection } from "./semantic-response"
import type { SemanticTreeEvent } from "./semantic-event"
import { makeSteeringProjection } from "./steering"
import { makeToolUnitProjection } from "./tool-unit"
import { authorizationTarget, makeProjectorCheckpointCodec } from "./checkpoint"
import { makeUsageAccounting } from "./usage"
import { type Card, type Node, type Projector } from "./model"
import { type AuthorizationState, type ModelCallState, type ProjectorCore } from "./persistence"
import { boundedInsert, subagentCardStatus } from "./nodes"
import { makeProjectorRecoveryIndex, type CheckpointInstrumentation } from "./projector-recovery"
import { bounded, boundedHead, optionalString, record, string } from "./values"
import { projectorNames, textLimit, toolTextLimit } from "./values"

import { scopedId } from "./decoding"
import { encoded, providerCostNanoUsd, token } from "./decoding"

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
  const usage = makeUsageAccounting(pricing)
  const { attemptStarts, modelCalls, observeLifecycleAt, activate, deactivate, recordAttempt, settleOpenAttempts } =
    usage
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
  const recovery = makeProjectorRecoveryIndex({
    nodes,
    ...(instrumentation === undefined ? {} : { instrumentation }),
  })
  let changed = new Map<string, Unit>()
  let removed = new Set<string>()
  let createdInBatch = new Set<string>()
  let semanticOrderPart: number | undefined
  let titleSettled = !titleExpected

  const projectionState = (): Projection.ProjectionState => ({
    status: core.rootStatus,
    usage: {
      ...structuredClone(usage.usage()),
      sourceComplete:
        titleSettled &&
        (core.rootStatus === "completed" || core.rootStatus === "failed" || core.rootStatus === "cancelled"),
      contextPending: usage.contextPending(),
      active: usage.activeTime(),
    },
    ...(core.title === undefined ? {} : { title: core.title }),
    steering: steering.summary(core.steeringMessages, core.followUpMessages),
  })

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
    return {
      key,
      turnId,
      ...(parentId === undefined ? {} : { parentId }),
      order: units.get(key)?.order ?? orderFor(node, key, orderPart),
      revision: core.revision,
      content,
    }
  }

  const steering = makeSteeringProjection({ turnId, put, unit })

  const { notice, error, modelFailureError, executionFailureError } = makeDiagnosticProjection({
    turnId,
    localId,
    put,
    unit,
    get: (key) => units.get(key),
  })

  const { putAuthorization, resolveAuthorization, settleAuthorizations } = makeAuthorizationProjection({
    core,
    units,
    authorizations,
    localId,
    put,
    unit,
    recover: recovery.authorizationChanged,
  })

  const { toolState, putTool, updateTool } = makeToolUnitProjection({
    units,
    localId,
    put,
    unit,
    recover: recovery.toolChanged,
  })

  const { openCell, progressCell, completeCell, settleRunningCells } = makeCellProjection({
    units,
    localId,
    put,
    unit,
    recover: recovery.cellChanged,
    activeIds: recovery.activeCellIds,
    notice,
    error,
  })

  const { cardFor, updateCard, groupCards, bindChild } = makeSubagentCardProjection({
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

  const semanticResponse = makeSemanticResponseProjection({
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
    const created: Node = {
      rawRunId: input.runId,
      publicId:
        card?.publicId ??
        (input.parentRunId === undefined ? "root" : localId("subagent", turnId, input.invocationId ?? "orphan")),
      ...(input.parentRunId === undefined ? {} : { parentRawRunId: input.parentRunId }),
      ...(card === undefined ? {} : { parentUnitKey: card.unitKey, parentBlockId: card.blockId }),
      hidden,
      tools: new Map(),
      cells: new Map(),
      phase: -1,
      status: "running",
      lifecycle: "unknown",
      started: false,
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

  const applyRunEvent = (treeEvent: SemanticTreeEvent) => {
    const event = treeEvent.event
    const node = nodeFor(treeEvent)
    switch (event._tag) {
      case "RunAccepted":
        observeLifecycleAt(event)
        if (node.lifecycle === "unknown") node.lifecycle = "accepted"
        return
      case "RunAttemptStarted":
        if (node.attempt !== undefined && event.attempt < node.attempt)
          throw new TypeError(`TenetKit Run ${node.rawRunId} attempt regressed`)
        if (node.attempt === event.attempt) {
          observeLifecycleAt(event)
          return
        }
        node.started = true
        node.attempt = event.attempt
        if (node.lifecycle === "active") observeLifecycleAt(event)
        else activate(node, event)
        const activeCard = cardsByChild.get(node.rawRunId)
        if (activeCard !== undefined) updateCard(activeCard, "running")
        return
      case "TurnStarted":
        node.phase += 1
        return
      case "ModelResponseCommitted":
      case "ModelResponseInterrupted":
        return semanticResponse.apply(node, event)
      case "ToolExecutionStarted":
        if (event.call.name === cellToolName)
          return openCell(node, event.call.id, string(record(event.call.params).code, ""))
        if (event.call.name === projectorNames.runChild) {
          const input = record(event.call.params)
          cardFor(
            node,
            event.call.id,
            string(input.selection, "Subagent"),
            optionalString(input.prompt),
            optionalString(input.label) || undefined,
          )
          return remove(toolState(node, event.call.id).key)
        }
        if (event.call.name === projectorNames.runChildGroup) {
          groupCards(node, event.call.id, event.call.params)
          return remove(toolState(node, event.call.id).key)
        }
        return putTool(node, event.call.id, event.call.name, encoded(event.call.params))
      case "ToolProgress":
        if (node.cells.has(event.toolCallId)) return progressCell(node, event.toolCallId, event.data)
        return updateTool(node, event.toolCallId, (tool) => ({
          ...tool,
          ...(event.message === undefined
            ? {}
            : {
                output: bounded(
                  `${tool.output === undefined ? "" : `${tool.output}\n`}${event.message}`,
                  toolTextLimit,
                ),
              }),
        }))
      case "ToolExecutionCompleted": {
        if (event.call.name === cellToolName)
          return completeCell(node, event.call.id, event.result.result, event.result.isFailure)
        if (event.call.name === projectorNames.runChild) {
          const card = cardsByInvocation.get(`${node.rawRunId}\u0000${event.call.id}`)
          const result = record(event.result.result)
          if (card !== undefined && optionalString(result._tag) !== "Succeeded")
            updateCard(
              card,
              optionalString(result._tag) === "Cancelled" ? "cancelled" : "failed",
              optionalString(result.message ?? result.reason),
            )
          return
        }
        if (event.call.name === projectorNames.runChildGroup) {
          if (event.result.isFailure) {
            const result = record(event.result.result)
            const detail = optionalString(result.message)
            for (const card of groupCards(node, event.call.id, event.call.params))
              if (card.rawChildRunId === undefined) updateCard(card, "failed", detail)
          }
          return
        }
        return updateTool(node, event.call.id, (tool) =>
          completeTool(
            tool,
            event.result.result,
            event.result.isFailure,
            boundedHead(encoded(event.result.result), toolTextLimit),
          ),
        )
      }
      case "ApprovalRequested":
        putAuthorization(node, event.request.approvalId, event.request)
        return
      case "SteeringAccepted":
        return steering.accept(treeEvent.runId, event)
      case "SteeringConsumed":
        return steering.consume(treeEvent.runId, event, node)
      case "SteeringDiscarded":
        return steering.discard(treeEvent.runId, event)
      case "SteeringDrained":
        if (event.queue === "steering") core.steeringMessages += event.count
        else core.followUpMessages += event.count
        return
      case "TurnCompleted":
      case "StructuredOutput":
      case "HandoffRequested":
      case "HandoffCompleted":
      case "HandoffRejected":
        return
      case "ModelCallStarted": {
        const key = `${node.rawRunId}\u0000${event.modelCallId}`
        const rootConversation = node.parentRawRunId === undefined && !node.hidden && event.purpose === "conversation"
        const existing = modelCalls.get(key)
        if (existing !== undefined) {
          if (existing.purpose !== event.purpose)
            throw new TypeError(`Conflicting TenetKit model call: ${event.modelCallId}`)
          return
        }
        const value: ModelCallState = {
          purpose: event.purpose,
          ...(rootConversation ? { requestOrdinal: usage.requestOrdinal() + 1 } : {}),
        }
        if (boundedInsert(modelCalls, key, value, Projection.limits.modelCalls, "model calls") && rootConversation)
          usage.awaitContext(usage.nextRequestOrdinal())
        return
      }
      case "ModelAttemptFirstOutput":
        return
      case "ModelCallCompleted": {
        const key = `${node.rawRunId}\u0000${event.modelCallId}`
        const call = modelCalls.get(key)
        if (call?.requestOrdinal === usage.pendingContextOrdinal()) usage.awaitContext(undefined)
        modelCalls.delete(key)
        return
      }
      case "ModelAttemptStarted": {
        const key = localId("usage", node.publicId, event.modelAttemptId)
        boundedInsert(
          attemptStarts,
          key,
          { startedAt: event.startedAt, modelCallId: event.modelCallId, rawRunId: node.rawRunId },
          Projection.limits.inFlightAttempts,
          "in-flight attempts",
        )
        return
      }
      case "ModelAttemptCompleted": {
        const key = localId("usage", node.publicId, event.modelAttemptId)
        recordAttempt({
          key,
          node,
          modelCallId: event.modelCallId,
          inputTotal: token(event.usage.inputTokens.total),
          inputUncached: token(event.usage.inputTokens.uncached),
          inputCacheRead: token(event.usage.inputTokens.cacheRead),
          inputCacheWrite: token(event.usage.inputTokens.cacheWrite),
          outputTotal: token(event.usage.outputTokens.total),
          outputText: token(event.usage.outputTokens.text),
          outputReasoning: token(event.usage.outputTokens.reasoning),
          costNanoUsd: providerCostNanoUsd(event),
        })
        attemptStarts.delete(key)
        return
      }
      case "ModelAttemptFailed": {
        const key = localId("usage", node.publicId, event.modelAttemptId)
        recordAttempt({
          key,
          node,
          modelCallId: event.modelCallId,
          inputTotal: token(event.providerUsage?.inputTokens),
          outputTotal: token(event.providerUsage?.outputTokens),
          failedProviderTotal: token(event.providerUsage?.totalTokens),
          costNanoUsd: providerCostNanoUsd(event),
        })
        attemptStarts.delete(key)
        return
      }
      case "ModelRetryScheduled":
      case "ModelFallbackScheduled":
        // Retry activity belongs to the single turn-retry status surface; per-attempt
        // notices would make the transcript itself a retry mechanism.
        return
      case "ModelCallFailed": {
        const key = `${node.rawRunId}\u0000${event.modelCallId}`
        const call = modelCalls.get(key)
        if (call?.requestOrdinal === usage.pendingContextOrdinal()) usage.awaitContext(undefined)
        modelCalls.delete(key)
        return modelFailureError(node, event.modelCallId, event.category, event.classification)
      }
      case "CompactionStarted": {
        const key = localId("compaction", node.publicId, event.compactionId)
        put(unit(node, key, { _tag: "Block", block: { _tag: "Compaction", summary: "", status: "running" } }))
        recovery.compactionChanged(key, true)
        return
      }
      case "CompactionSkipped":
      case "CompactionApplied": {
        const key = localId("compaction", node.publicId, event.compactionId)
        const current = units.get(key)
        const previous =
          current?.content._tag === "Block" && current.content.block._tag === "Compaction"
            ? current.content.block
            : undefined
        put(
          unit(node, key, {
            _tag: "Block",
            block: {
              _tag: "Compaction",
              summary: previous?.summary ?? "",
              status: "complete",
              ...(event._tag === "CompactionApplied" ? { checkpoint: event.checkpointId } : {}),
            },
          }),
        )
        recovery.compactionChanged(key, false)
        return
      }
      case "CompactionFailed": {
        const key = localId("compaction", node.publicId, event.compactionId)
        put(unit(node, key, { _tag: "Block", block: { _tag: "Compaction", summary: "", status: "failed" } }))
        recovery.compactionChanged(key, false)
        return
      }
      case "RunWaiting":
        deactivate(node, event, "waiting")
        node.status = "waiting"
        if (node.parentRawRunId === undefined) core.rootStatus = "waiting"
        if (event.wait.reason._tag === "Approval") putAuthorization(node, event.wait.waitId, event.wait.reason.request)
        return
      case "RunResumed":
        if (node.started) activate(node, event)
        else {
          observeLifecycleAt(event)
          node.lifecycle = "unknown"
        }
        node.status = "running"
        if (node.parentRawRunId === undefined) core.rootStatus = "running"
        if (event.resolution._tag === "Approved") resolveAuthorization(node, event.waitId, "approved")
        if (event.resolution._tag === "Denied") resolveAuthorization(node, event.waitId, "denied")
        return
      case "OperationUnknown":
        // A replayPolicy:"never" operation interrupted mid-flight parks the Run in needs-resolution
        // until it is resolved. The Run is waiting, not working, so stop accruing active time.
        if (node.lifecycle === "active") deactivate(node, event, "waiting")
        node.status = "waiting"
        if (node.parentRawRunId === undefined) core.rootStatus = "waiting"
        return error(
          node,
          "operation",
          "Execution needs resolution",
          `Unknown operation ${event.operationId}.`,
          event.operationId,
        )
      case "ChildLinked":
        return bindChild(node, event.childRunId, event)
      case "ChildSettled": {
        const card = cardsByChild.get(event.childRunId)
        if (card !== undefined) {
          const child = nodes.get(event.childRunId)
          if (child !== undefined) updateCard(card, subagentCardStatus(child.status))
        }
        return
      }
      case "FanOutAdmitted":
        return
      case "FanOutJoined":
        return
      case "RunCompleted":
        deactivate(node, event, "terminal")
        settleOpenAttempts(node)
        if (node.hidden) {
          node.status = "completed"
          if ("text" in event.result) core.title = { text: event.result.text }
          return
        }
        return settleNode(node, "completed", event)
      case "RunFailed":
        deactivate(node, event, "terminal")
        settleOpenAttempts(node)
        settleAuthorizations(node, "expired")
        if (node.hidden) {
          node.status = "failed"
          return
        }
        executionFailureError(node, event.error.message, {
          status: "failed",
          ...(event.error.message.length === 0 ? {} : { reason: event.error.message }),
        })
        return settleNode(node, "failed", event, event.error.message)
      case "RunCancellationRequested": {
        const card = cardsByChild.get(node.rawRunId)
        if (card !== undefined) updateCard(card, "cancelling")
        if (node.parentRawRunId === undefined) core.rootStatus = "cancelling"
        return
      }
      case "RunCancelled":
        deactivate(node, event, "terminal")
        settleOpenAttempts(node)
        settleAuthorizations(node, "cancelled")
        if (node.hidden) {
          node.status = "cancelled"
          return
        }
        return settleNode(node, "cancelled", event, event.reason)
      case "ProgramLog":
        if (event.level === "debug" || event.level === "info") return
        return event.level === "error"
          ? error(node, "program-log", event.operation, event.message, event.eventId)
          : notice(node, "program-log", event.operation, event.message, event.eventId)
    }
  }

  const { serialize, restore } = makeProjectorCheckpointCodec({
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
    snapshot: () => {
      const materialized = [...units.values()].toSorted((left, right) =>
        UnitOrder.compareUnitOrder(left.order, right.order),
      )
      return {
        _tag: "ProjectionSnapshot",
        revision: core.revision,
        ...(core.checkpoint === undefined ? {} : { checkpoint: core.checkpoint }),
        units: materialized.slice(-Projection.limits.snapshotUnits),
        hasOlder: core.historyOmitted || materialized.length > Projection.limits.snapshotUnits,
        state: projectionState(),
      }
    },
    apply: (input) => applyAll([input]),
    applyAll: (inputs) => applyAll(inputs),
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

export const TreeProjector = { make, authorizationTarget }
export const titleInvocationId = projectorNames.titleInvocationId
