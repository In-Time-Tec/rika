import { RunTree, type RunEvent } from "@batonfx/runtime"
import { DateTime, Function } from "effect"
import { TreeProjector } from "../src/projection/tree"
import type { SemanticTreeEvent } from "../src/projection/semantic-event"

let position = 0

interface TreeEventOptions {
  readonly rootRunId?: string
  readonly parentRunId?: string
  readonly invocationId?: string
}

export const resetEventPosition = () => {
  position = 0
}

export const occurredAt = (millis: number): string => DateTime.formatIso(DateTime.makeUnsafe(millis))

const treeEventImpl = (
  runId: string,
  event: Partial<RunEvent.RunEvent> & { readonly _tag: RunEvent.RunEvent["_tag"] },
  options: TreeEventOptions = {},
): SemanticTreeEvent => {
  position += 1
  const rootRunId = options.rootRunId ?? "raw-root-run"
  return {
    rootRunId,
    runId,
    ...(options.parentRunId === undefined ? {} : { parentRunId: options.parentRunId }),
    ...(options.invocationId === undefined ? {} : { invocationId: options.invocationId }),
    event: {
      specVersion: "1",
      eventId: `${runId}:${position}`,
      runId,
      rootRunId,
      sequence: position,
      executableRef: {} as never,
      occurredAt: occurredAt(position),
      ...event,
    } as SemanticTreeEvent["event"],
    cursor: RunTree.TreeCursor.make(`tree-cursor-${position}`),
  }
}

export const treeEvent: {
  (
    runId: string,
    event: Partial<RunEvent.RunEvent> & { readonly _tag: RunEvent.RunEvent["_tag"] },
    options?: TreeEventOptions,
  ): SemanticTreeEvent
  (
    event: Partial<RunEvent.RunEvent> & { readonly _tag: RunEvent.RunEvent["_tag"] },
    options?: TreeEventOptions,
  ): (runId: string) => SemanticTreeEvent
} = Function.dual((args) => typeof args[0] === "string", treeEventImpl)

const modelResponseImpl = (runId: string, part: unknown, options: TreeEventOptions = {}): SemanticTreeEvent => {
  const operationKey = `model-operation-${position + 1}`
  return treeEventImpl(
    runId,
    {
      _tag: "ModelResponseCommitted",
      turn: 0,
      operationKey,
      modelCallId: `model-call-${position + 1}`,
      modelAttemptId: `model-attempt-${position + 1}`,
      attempt: 0,
      response: { content: [part] },
      digest: `digest-${position + 1}`,
    } as never,
    options,
  )
}

export const modelResponse: {
  (runId: string, part: unknown, options?: TreeEventOptions): SemanticTreeEvent
  (part: unknown, options?: TreeEventOptions): (runId: string) => SemanticTreeEvent
} = Function.dual((args) => typeof args[0] === "string", modelResponseImpl)

const modelResponseContentImpl = (
  runId: string,
  operationKey: string,
  content: ReadonlyArray<unknown>,
  options: TreeEventOptions = {},
): SemanticTreeEvent =>
  treeEventImpl(
    runId,
    {
      _tag: "ModelResponseCommitted",
      turn: 0,
      operationKey,
      modelCallId: `${operationKey}:call`,
      modelAttemptId: `${operationKey}:attempt`,
      attempt: 0,
      response: { content },
      digest: `${operationKey}:digest`,
    } as never,
    options,
  )

export const modelResponseContent: {
  (runId: string, operationKey: string, content: ReadonlyArray<unknown>, options?: TreeEventOptions): SemanticTreeEvent
  (
    operationKey: string,
    content: ReadonlyArray<unknown>,
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
