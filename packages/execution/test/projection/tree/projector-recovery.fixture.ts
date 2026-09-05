import { expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { ProjectionState } from "@rika/product/execution-projection"
import { TreeProjector } from "../../../src/projection/tree/projector"
import { resetEventPosition, treeEvent } from "../../support/projector-event.fixture"

it("keeps node-specific recovery across sibling progress and rebuild, and clears only resolved nodes", () => {
  resetEventPosition()
  const child = { parentRunId: "raw-root-run", invocationId: "child" }
  const sibling = { parentRunId: "raw-root-run", invocationId: "sibling" }
  const events = [
    treeEvent("raw-root-run", { _tag: "RunAttemptStarted", attempt: 1 }),
    treeEvent("child", { _tag: "RunAttemptStarted", attempt: 1 }, child),
    treeEvent("child", { _tag: "OperationUnknown", operationId: "op-child" }, child),
    treeEvent("sibling", { _tag: "RunAttemptStarted", attempt: 1 }, sibling),
    treeEvent("sibling", { _tag: "TurnStarted", turn: 0 }, sibling),
  ]
  const projector = TreeProjector.make("turn", "delegate")
  projector.applyAll(events)
  expect(projector.snapshot().state.needsResolution).toBe(true)
  const decoded = Schema.decodeSync(Schema.fromJsonString(ProjectionState))(JSON.stringify(projector.snapshot().state))
  expect(decoded.needsResolution).toBe(true)
  const { needsResolution: _, ...oldState } = decoded
  expect(Schema.decodeSync(ProjectionState)(oldState).needsResolution).toBeUndefined()
  const rebuilt = TreeProjector.make("turn", "delegate")
  rebuilt.applyAll(events)
  expect(rebuilt.snapshot().state.needsResolution).toBe(true)
  rebuilt.apply(treeEvent("child", { _tag: "RunResumed", waitId: "wait", resolution: { _tag: "Approved" } }, child))
  expect(rebuilt.snapshot().state.needsResolution).toBeUndefined()
  rebuilt.apply(treeEvent("child", { _tag: "OperationUnknown", operationId: "op-child-2" }, child))
  rebuilt.apply(treeEvent("sibling", { _tag: "OperationUnknown", operationId: "op-sibling" }, sibling))
  rebuilt.apply(treeEvent("child", { _tag: "RunAttemptStarted", attempt: 2 }, child))
  expect(rebuilt.snapshot().state.needsResolution).toBe(true)
  rebuilt.apply(treeEvent("sibling", { _tag: "RunCancelled", reason: "stopped" }, sibling))
  expect(rebuilt.snapshot().state.needsResolution).toBeUndefined()
})
