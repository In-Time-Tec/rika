import { rootExecutionEvents } from "../../src/execution/lifecycle/root-execution-event"
import { describe, expect, it } from "@effect/vitest"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as ExecutionEvent from "@rika/product/execution-event"

const usageEventAt = (executionId: string, cursor: string, sequence: number): ExecutionEvent.Event => ({
  executionId,
  cursor,
  sequence,
  type: "model.usage.reported",
  createdAt: 1,
  data: { model: "test", input_tokens: 100, output_tokens: 10 },
})

const childOf = (executionId: string, callId: string) => `child:${encodeURIComponent(executionId)}:${callId}`

const opaqueCursor = (sequence: number) => Array.from({ length: 20 }, (_, index) => `${sequence}${index}`).join("")

describe("rootExecutionEvents", () => {
  it("keeps root execution events and drops every foreign execution's events", () => {
    const turnId = "turn-1"
    const rootId = `execution:${turnId}`
    const events = [
      usageEventAt(rootId, "cm9vdDE~9Zk", 9),
      usageEventAt(childOf(rootId, "call_a"), "Y2hpbGQ~4Wq", 4526),
      usageEventAt(rootId, "cm9vdDI~30x", 30),
      usageEventAt(childOf(rootId, "title"), "dGl0bGU~8Ab", 8),
      usageEventAt(turnId, "YmFyZQ~40Cd", 40),
      usageEventAt("execution:other-turn", "b3RoZXI~41Ef", 41),
    ]
    const filtered = rootExecutionEvents(turnId, events)
    expect(filtered.map((value) => value.sequence)).toEqual([9, 30, 40])
  })

  it("keeps a poisoned child sequence out of the projected revision", () => {
    const turnId = "turn-2"
    const rootId = `execution:${turnId}`
    const events = [
      usageEventAt(childOf(rootId, "call_a"), "cG9pc29u~4Wq", 4526),
      usageEventAt(rootId, "cm9vdA~9Zk", 9),
    ]
    expect(rootExecutionEvents(turnId, events).every((value) => value.sequence <= 9)).toBe(true)
  })

  it("attributes by execution identity alone and never reads the cursor", () => {
    const turnId = "turn-3"
    const rootId = `execution:${turnId}`
    const events = [
      usageEventAt(rootId, `child:${turnId}:call_a:model:1:usage`, 1),
      usageEventAt(rootId, "execution:some-other-turn:model:2:usage", 2),
      usageEventAt(childOf(rootId, "call_a"), `execution:${turnId}:model:3:usage`, 3),
      usageEventAt("execution:other-turn", `execution:${turnId}:model:4:usage`, 4),
    ]
    const filtered = rootExecutionEvents(turnId, events)
    expect(filtered.map((value) => value.sequence)).toEqual([1, 2])
  })

  it("survives cursors that carry no information at all", () => {
    const turnId = "turn-4"
    const rootId = `execution:${turnId}`
    const events = [
      usageEventAt(rootId, opaqueCursor(1), 1),
      usageEventAt(childOf(rootId, "call_a"), opaqueCursor(2), 2),
      usageEventAt(rootId, opaqueCursor(3), 3),
    ]
    expect(rootExecutionEvents(turnId, events).map((value) => value.cursor)).toEqual([opaqueCursor(1), opaqueCursor(3)])
  })
})
