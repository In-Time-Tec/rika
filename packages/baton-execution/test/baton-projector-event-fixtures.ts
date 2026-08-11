import { RunTree, type RunEvent } from "@batonfx/runtime"
import { DateTime, Function } from "effect"
import { TreeProjector } from "../src/projection/tree"

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
): RunTree.TreeEvent => {
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
    } as RunEvent.RunEvent,
    cursor: RunTree.TreeCursor.make(`tree-cursor-${position}`),
  }
}

export const treeEvent: {
  (
    runId: string,
    event: Partial<RunEvent.RunEvent> & { readonly _tag: RunEvent.RunEvent["_tag"] },
    options?: TreeEventOptions,
  ): RunTree.TreeEvent
  (
    event: Partial<RunEvent.RunEvent> & { readonly _tag: RunEvent.RunEvent["_tag"] },
    options?: TreeEventOptions,
  ): (runId: string) => RunTree.TreeEvent
} = Function.dual((args) => typeof args[0] === "string", treeEventImpl)

const modelPartImpl = (runId: string, part: unknown, options: TreeEventOptions = {}): RunTree.TreeEvent =>
  treeEventImpl(
    runId,
    {
      _tag: "ModelPart",
      turn: 0,
      modelCallId: "model-call",
      modelAttemptId: "model-attempt",
      attempt: 0,
      part,
    } as never,
    options,
  )

export const modelPart: {
  (runId: string, part: unknown, options?: TreeEventOptions): RunTree.TreeEvent
  (part: unknown, options?: TreeEventOptions): (runId: string) => RunTree.TreeEvent
} = Function.dual((args) => typeof args[0] === "string", modelPartImpl)

export const assistantOf = (projector: ReturnType<typeof TreeProjector.make>) =>
  projector.snapshot().units.filter((unit) => unit.content._tag === "Entry" && unit.content.role === "assistant")

type Change = ReturnType<ReturnType<typeof TreeProjector.make>["apply"]>
const blockImpl = (change: Change, tag: string) =>
  change.upsert.find((unit) => unit.content._tag === "Block" && unit.content.block._tag === tag)?.content

export const block: {
  (change: Change, tag: string): ReturnType<typeof blockImpl>
  (tag: string): (change: Change) => ReturnType<typeof blockImpl>
} = Function.dual(2, blockImpl)
