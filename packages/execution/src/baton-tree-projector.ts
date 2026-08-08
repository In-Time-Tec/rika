import type { RunEvent, RunTree } from "@batonfx/runtime"
import * as Projection from "@rika/product/execution-projection"
import * as UnitOrder from "@rika/product/execution-transcript-contract"
import type { Unit } from "@rika/product/execution-transcript-contract"
import { Function } from "effect"
import { completeTool } from "./baton-tool-projection"
import { makeAuthorizationProjection } from "./baton-authorization-projection"
import { makeDiagnosticProjection } from "./baton-diagnostic-projection"
import { makeStreamedTextProjection } from "./baton-streamed-text-projection"
import { makeSubagentCardProjection } from "./baton-subagent-card-projection"
import { makeToolUnitProjection } from "./baton-tool-unit-projection"
import { makeProjectorCheckpointCodec } from "./baton-projector-checkpoint"
import { makeUsageAccounting } from "./baton-usage-accounting"
import { type Card, type Node, type Projector } from "./baton-projector-model"
import {
  type AuthorizationState,
  type ModelCallState,
  type PersistedProjector,
  type ProjectorCore,
} from "./baton-projector-persistence"
import { boundedInsert, subagentCardStatus } from "./baton-projector-nodes"
import {
  projectorNames,
  bounded,
  boundedHead,
  record,
  optionalString,
  string,
  textLimit,
  toolTextLimit,
} from "./baton-projector-values"
import { scopedId } from "./baton-projector-identity"
import { encoded, providerCostNanoUsd, token } from "./baton-projector-decoding"

export type { Projector }

const make = (
  turnId: string,
  prompt: string,
  resume?: Projection.Checkpoint,
  baselineUnits: ReadonlyArray<Unit> = [],
): Projector => {
  const localId = (family: string, ...parts: ReadonlyArray<string | number>): string =>
    scopedId(family, turnId, ...parts)
  const usage = makeUsageAccounting()
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
  const pendingGroups: Array<{
    readonly parentRawRunId: string
    readonly toolCallId: string
    readonly memberKeys: ReadonlyArray<string>
  }> = []
  const fanOutTools = new Map<
    string,
    { readonly parentRawRunId: string; readonly toolCallId: string; readonly memberKeys: ReadonlyArray<string> }
  >()
  const authorizations = new Map<string, AuthorizationState>()
  let changed = new Map<string, Unit>()
  let removed = new Set<string>()

  const projectionState = (): Projection.ProjectionState => ({
    status: core.rootStatus,
    usage: {
      ...structuredClone(usage.usage()),
      sourceComplete:
        core.rootStatus === "completed" || core.rootStatus === "failed" || core.rootStatus === "cancelled",
      contextPending: usage.contextPending(),
      active: usage.activeTime(),
    },
    ...(core.title === undefined ? {} : { title: core.title }),
    steering: { steeringMessages: core.steeringMessages, followUpMessages: core.followUpMessages },
  })

  const put = (unit: Unit) => {
    units.set(unit.key, unit)
    changed.set(unit.key, unit)
    removed.delete(unit.key)
  }

  const remove = (key: string) => {
    if (!units.delete(key)) return
    changed.delete(key)
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
      order: units.get(key)?.order ?? orderFor(node, key, part),
      revision: core.revision,
      content,
    }
  }

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
  })

  const { toolState, toolBlock, putTool, updateTool } = makeToolUnitProjection({ units, localId, put, unit })

  const { cardFor, updateCard, groupCards, bindFanOut, bindChild } = makeSubagentCardProjection({
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
  })

  const nodeFor = (input: RunTree.TreeEvent): Node => {
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
      phase: -1,
      status: "running",
      lifecycle: "unknown",
      started: false,
    }
    nodes.set(input.runId, created)
    return created
  }

  const settleNode = (node: Node, status: "completed" | "failed" | "cancelled", detail?: string) => {
    node.status = status
    for (const rawId of node.tools.keys())
      updateTool(node, rawId, (tool) =>
        tool.status === "running" && tool.process?.running !== true
          ? { ...tool, status: status === "completed" ? "cancelled" : status }
          : tool,
      )
    const card = cardsByChild.get(node.rawRunId)
    if (card !== undefined) updateCard(card, status === "completed" ? "complete" : status, detail)
    if (node.parentRawRunId === undefined) core.rootStatus = status
  }

  const { assistant, reasoning } = makeStreamedTextProjection({ units, localId, put, unit })

  const applyModelPart = (node: Node, event: Extract<RunEvent.RunEvent, { readonly _tag: "ModelPart" }>) => {
    const part = event.part
    switch (part.type) {
      case "text-delta":
        return assistant(node, part.delta)
      case "reasoning-delta":
        return reasoning(node, part.delta)
      case "tool-params-start":
        return putTool(node, part.id, part.name, "")
      case "tool-params-delta": {
        const previous = toolBlock(node, part.id)
        return putTool(node, part.id, previous?.name ?? "tool", `${previous?.input ?? ""}${part.delta}`)
      }
      case "tool-call":
        if (part.name === projectorNames.runChild) {
          const input = record(part.params)
          cardFor(node, part.id, string(input.selection, "Subagent"), optionalString(input.prompt))
          return remove(toolState(node, part.id).key)
        }
        if (part.name === projectorNames.startChildGroup) {
          groupCards(node, part.id, part.params)
          return remove(toolState(node, part.id).key)
        }
        if (part.name === projectorNames.awaitChildGroup) return remove(toolState(node, part.id).key)
        return putTool(node, part.id, part.name, encoded(part.params))
      case "tool-approval-request":
        return
      case "file":
        return notice(node, "file", "Model attached a file", "A model-generated file is available.", event.sequence)
      case "source":
        return notice(node, "source", "Model cited a source", "A model source was recorded.", event.sequence)
      case "error":
        return error(node, "model-error", "Model stream error", String(part.error), event.sequence)
      case "text-start":
      case "text-end":
      case "reasoning-start":
      case "reasoning-end":
      case "tool-params-end":
      case "response-metadata":
      case "finish":
      case "tool-result":
        return
    }
  }

  const applyRunEvent = (treeEvent: RunTree.TreeEvent) => {
    const event = treeEvent.event
    const node = nodeFor(treeEvent)
    switch (event._tag) {
      case "RunAccepted":
        observeLifecycleAt(event)
        if (node.lifecycle === "unknown") node.lifecycle = "accepted"
        return
      case "RunAttemptStarted":
        if (node.attempt !== undefined && event.attempt < node.attempt)
          throw new TypeError(`Baton Run ${node.rawRunId} attempt regressed`)
        if (node.attempt === event.attempt) {
          observeLifecycleAt(event)
          return
        }
        node.started = true
        node.attempt = event.attempt
        if (node.lifecycle === "active") observeLifecycleAt(event)
        else activate(node, event)
        return
      case "TurnStarted":
        node.phase += 1
        return
      case "ModelPart":
        return applyModelPart(node, event)
      case "ToolExecutionStarted":
        if (event.call.name === projectorNames.runChild) {
          const input = record(event.call.params)
          cardFor(node, event.call.id, string(input.selection, "Subagent"), optionalString(input.prompt))
          return remove(toolState(node, event.call.id).key)
        }
        if (event.call.name === projectorNames.startChildGroup) {
          groupCards(node, event.call.id, event.call.params)
          return remove(toolState(node, event.call.id).key)
        }
        if (event.call.name === projectorNames.awaitChildGroup) return remove(toolState(node, event.call.id).key)
        return putTool(node, event.call.id, event.call.name, encoded(event.call.params))
      case "ToolProgress":
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
        if (event.call.name === projectorNames.startChildGroup || event.call.name === projectorNames.awaitChildGroup)
          return
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
            throw new TypeError(`Conflicting Baton model call: ${event.modelCallId}`)
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
        return
      }
      case "CompactionFailed": {
        const key = localId("compaction", node.publicId, event.compactionId)
        put(unit(node, key, { _tag: "Block", block: { _tag: "Compaction", summary: "", status: "failed" } }))
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
        return bindChild(node, event.childRunId, event.invocationId, event.selection, event.prompt)
      case "ChildSettled": {
        const card = cardsByChild.get(event.childRunId)
        if (card !== undefined) {
          const child = nodes.get(event.childRunId)
          if (child !== undefined) updateCard(card, subagentCardStatus(child.status))
        }
        return
      }
      case "FanOutAdmitted":
        return bindFanOut(node, event.fanOutId, event.memberCount)
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
        return settleNode(node, "completed")
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
        return settleNode(node, "failed", event.error.message)
      case "RunCancellationRequested": {
        const card = cardsByChild.get(node.rawRunId)
        if (card !== undefined) updateCard(card, "cancelling")
        if (node.parentRawRunId === undefined) core.rootStatus = "cancelling"
        return notice(
          node,
          "cancellation",
          "Cancellation requested",
          event.reason ?? "Cancellation was requested.",
          "requested",
        )
      }
      case "RunCancelled":
        deactivate(node, event, "terminal")
        settleOpenAttempts(node)
        settleAuthorizations(node, "cancelled")
        if (node.hidden) {
          node.status = "cancelled"
          return
        }
        return settleNode(node, "cancelled", event.reason)
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
    pendingGroups,
    fanOutTools,
    authorizations,
    localId,
    toolBlock,
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
    apply: (input) => {
      if (nodes.size === 0)
        nodes.set(input.rootRunId, {
          rawRunId: input.rootRunId,
          publicId: "root",
          hidden: false,
          tools: new Map(),
          phase: -1,
          status: "running",
          lifecycle: "unknown",
          started: false,
        })
      changed = new Map()
      removed = new Set()
      const baseRevision = core.revision
      core.revision += 1
      applyRunEvent(input)
      core.checkpoint = {
        version: Projection.projectionVersion,
        cursor: String(input.cursor),
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
    },
  }
}

export interface AuthorizationTarget {
  readonly runId: string
  readonly approvalId: string
}

/** Gateway-private resolution from an opaque persisted projector checkpoint. */
const authorizationTargetImpl = (
  checkpoint: Projection.Checkpoint,
  authorizationId: string,
): AuthorizationTarget | undefined => {
  if (checkpoint.version !== Projection.projectionVersion) return undefined
  try {
    const parsed = JSON.parse(checkpoint.state) as Partial<PersistedProjector>
    if (!Array.isArray(parsed.authorizations)) return undefined
    for (const candidate of parsed.authorizations) {
      if (!Array.isArray(candidate) || candidate.length !== 2) continue
      const value = candidate[1] as Partial<AuthorizationState>
      if (
        value.authorizationId === authorizationId &&
        typeof value.rawRunId === "string" &&
        typeof value.approvalId === "string"
      )
        return { runId: value.rawRunId, approvalId: value.approvalId }
    }
    return undefined
  } catch {
    return undefined
  }
}

export const authorizationTarget: {
  (
    arg0: Parameters<typeof authorizationTargetImpl>[0],
    arg1: Parameters<typeof authorizationTargetImpl>[1],
  ): ReturnType<typeof authorizationTargetImpl>
  (
    arg1: Parameters<typeof authorizationTargetImpl>[1],
  ): (arg0: Parameters<typeof authorizationTargetImpl>[0]) => ReturnType<typeof authorizationTargetImpl>
} = Function.dual(2, authorizationTargetImpl)

export const TreeProjector = { make, authorizationTarget }
export const titleInvocationId = projectorNames.titleInvocationId
