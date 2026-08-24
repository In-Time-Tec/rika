import { RunEvent, RunTree } from "tenetkit/runtime"
import { DateTime, Function, Schema } from "effect"
import { TreeProjector } from "../../src/projection/tree/projector"
import type { SemanticTreeEvent } from "../../src/projection/semantic/event"

let position = 0

interface TreeEventOptions {
  readonly rootRunId?: string
  readonly parentRunId?: string
  readonly invocationId?: string
  readonly response?: RunEvent.CompletedModelResponse
}

type RunEventInput = {
  [Tag in RunEvent.RunEvent["_tag"]]: Partial<Extract<RunEvent.RunEvent, { readonly _tag: Tag }>> & {
    readonly _tag: Tag
  }
}[RunEvent.RunEvent["_tag"]]

type ModelResponsePart = Parameters<typeof RunEvent.CompletedModelResponse.make>[0]["content"][number]

const completedModelResponse = (content: ReadonlyArray<ModelResponsePart>): RunEvent.CompletedModelResponse =>
  RunEvent.CompletedModelResponse.make({ content })

export const resetEventPosition = () => {
  position = 0
}

export const occurredAt = (millis: number): string => DateTime.formatIso(DateTime.makeUnsafe(millis))

const treeEventImpl = (runId: string, event: RunEventInput, options: TreeEventOptions = {}): SemanticTreeEvent => {
  position += 1
  const rootRunId = options.rootRunId ?? "raw-root-run"
  const normalizedEvent =
    event._tag === "RunCompleted"
      ? {
          ...event,
          result: {
            turns: 0,
            session: { sessionId: `${runId}:session`, leafId: null },
            ...event.result,
          },
        }
      : event
  const decodedEvent = RunEvent.RunEvent.make({
    specVersion: "1",
    eventId: `${runId}:${position}`,
    runId,
    rootRunId,
    sequence: position,
    executableRef: {
      active: `agent-pin:v1:sha256:${"1".repeat(64)}`,
      executable: `executable-pin:v1:sha256:${"2".repeat(64)}`,
    },
    depth: options.parentRunId === undefined ? 0 : 1,
    occurredAt: occurredAt(position),
    sessionId: `${runId}:session`,
    sessionParentId: null,
    sessionEntryId: `${runId}:entry:${position}`,
    childDepth: options.parentRunId === undefined ? 0 : 1,
    readiness: "ready",
    deliveryId: `${runId}:delivery:${position}`,
    turn: 0,
    trigger: "threshold",
    startedAt: position,
    ...normalizedEvent,
  })
  const semanticEvent: SemanticTreeEvent["event"] =
    decodedEvent._tag === "ModelResponseCommitted" || decodedEvent._tag === "ModelResponseInterrupted"
      ? { ...decodedEvent, response: options.response ?? RunEvent.CompletedModelResponse.make({ content: [] }) }
      : decodedEvent
  const base: SemanticTreeEvent = {
    rootRunId,
    runId,
    event: semanticEvent,
    cursor: RunTree.TreeCursor.make(`tree-cursor-${position}`),
  }
  if (options.parentRunId === undefined) return base
  if (options.invocationId === undefined) return { ...base, parentRunId: options.parentRunId }
  return { ...base, parentRunId: options.parentRunId, invocationId: options.invocationId }
}

export const treeEvent: {
  (runId: string, event: RunEventInput, options?: TreeEventOptions): SemanticTreeEvent
  (event: RunEventInput, options?: TreeEventOptions): (runId: string) => SemanticTreeEvent
} = Function.dual((args) => Schema.is(Schema.String)(args[0]), treeEventImpl)

const modelResponseImpl = (
  runId: string,
  part: ModelResponsePart,
  options: TreeEventOptions = {},
): SemanticTreeEvent => {
  const operationKey = `model-operation-${position + 1}`
  const response = completedModelResponse([part])
  return treeEventImpl(
    runId,
    {
      _tag: "ModelResponseCommitted",
      turn: 0,
      operationKey,
      modelCallId: `model-call-${position + 1}`,
      modelAttemptId: `model-attempt-${position + 1}`,
      attempt: 0,
      digest: `digest-${position + 1}`,
    },
    { ...options, response },
  )
}

export const modelResponse: {
  (runId: string, part: ModelResponsePart, options?: TreeEventOptions): SemanticTreeEvent
  (part: ModelResponsePart, options?: TreeEventOptions): (runId: string) => SemanticTreeEvent
} = Function.dual((args) => Schema.is(Schema.String)(args[0]), modelResponseImpl)

const modelResponseContentImpl = (
  runId: string,
  operationKey: string,
  content: ReadonlyArray<ModelResponsePart>,
  options: TreeEventOptions = {},
): SemanticTreeEvent => {
  const response = completedModelResponse(content)
  return treeEventImpl(
    runId,
    {
      _tag: "ModelResponseCommitted",
      turn: 0,
      operationKey,
      modelCallId: `${operationKey}:call`,
      modelAttemptId: `${operationKey}:attempt`,
      attempt: 0,
      digest: `${operationKey}:digest`,
    },
    { ...options, response },
  )
}

export const modelResponseContent: {
  (
    runId: string,
    operationKey: string,
    content: ReadonlyArray<ModelResponsePart>,
    options?: TreeEventOptions,
  ): SemanticTreeEvent
  (
    operationKey: string,
    content: ReadonlyArray<ModelResponsePart>,
    options?: TreeEventOptions,
  ): (runId: string) => SemanticTreeEvent
} = Function.dual((args) => Array.isArray(args[2]), modelResponseContentImpl)

export const assistantOf = (projector: ReturnType<typeof TreeProjector.make>) =>
  projector.snapshot().units.filter((unit) => unit.content._tag === "Entry" && unit.content.role === "assistant")

type Change = ReturnType<ReturnType<typeof TreeProjector.make>["apply"]>
const blockImpl = (change: Change, tag: string) =>
  change.upsert.find((unit) => unit.content._tag === "Block" && unit.content.block._tag === tag)?.content

export const block: {
  (change: Change, tag: string): ReturnType<typeof blockImpl>
  (tag: string): (change: Change) => ReturnType<typeof blockImpl>
} = Function.dual(2, blockImpl)
