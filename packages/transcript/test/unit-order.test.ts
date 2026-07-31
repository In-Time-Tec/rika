import { describe, expect, it } from "@effect/vitest"
import * as TranscriptProjection from "../src/projection/transcript-projection"
import { withNestedProjections } from "../src/projection/nested-transcript-projection"
import {
  childOrder,
  compareUnitOrder,
  encodeUnitOrder,
  localOrder,
  unitOrder,
} from "../src/ordering/transcript-unit-order"
import type { SourceEvent } from "../src/schema/transcript-source-event"
import type { UnitOrder } from "../src/schema/transcript-unit"

describe("intrinsic transcript unit order", () => {
  it("uses one injective total order in TypeScript and durable binary text", () => {
    const parent = unitOrder("parent/α", 1, 1)
    const local = unitOrder("child/🙂", 0, Number.MAX_SAFE_INTEGER)
    const values: ReadonlyArray<UnitOrder> = [
      unitOrder("negative", -1),
      unitOrder("zero-a", 0, 0),
      unitOrder("zero-b", 0, 0),
      unitOrder("\ud7ff", 0, 0),
      unitOrder("\u{10000}", 0, 0),
      unitOrder("\ue000", 0, 0),
      parent,
      childOrder(parent, "execution/子", local),
      unitOrder("maximum", Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    ]
    const byComparator = values.toSorted(compareUnitOrder).map(encodeUnitOrder)
    const byDurableKey = values.map(encodeUnitOrder).toSorted()
    expect(byComparator).toEqual(byDurableKey)
    expect(new Set(byDurableKey).size).toBe(values.length)
    expect(compareUnitOrder(unitOrder("minimum", -1), unitOrder("zero", 0))).toBeLessThan(0)
    expect(compareUnitOrder(unitOrder("zero", 0), unitOrder("maximum", Number.MAX_SAFE_INTEGER))).toBeLessThan(0)
    expect(
      compareUnitOrder(unitOrder("part-zero", 0, 0), unitOrder("part-maximum", 0, Number.MAX_SAFE_INTEGER)),
    ).toBeLessThan(0)
    expect(compareUnitOrder(parent, childOrder(parent, "execution/子", local))).toBeLessThan(0)
    expect(localOrder(childOrder(parent, "execution/子", local))).toEqual(local)
    expect(encodeUnitOrder(unitOrder("a/b", 0))).not.toBe(
      encodeUnitOrder(childOrder(unitOrder("a", 0), "b", unitOrder("local", 0))),
    )
  })

  it("rejects invalid numbers, malformed text, TranscriptProjection.Projection.empty keys, and runtime mutation", () => {
    for (const sequence of [Number.NaN, Number.POSITIVE_INFINITY, -2, 0.5, Number.MAX_SAFE_INTEGER + 1])
      expect(() => unitOrder("unit", sequence)).toThrow(RangeError)
    for (const part of [Number.NaN, Number.NEGATIVE_INFINITY, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])
      expect(() => unitOrder("unit", 0, part)).toThrow(RangeError)
    expect(() => unitOrder("", 0)).toThrow(RangeError)
    expect(() => unitOrder("\ud800", 0)).toThrow(RangeError)
    expect(() => unitOrder("\udfff", 0)).toThrow(RangeError)

    const order = unitOrder("immutable", 0)
    expect(Object.isFrozen(order)).toBe(true)
    expect(Object.isFrozen(order[0])).toBe(true)
    expect(() => Object.assign(order[0], { sequence: 1 })).toThrow(TypeError)
    expect(encodeUnitOrder(order)).toBe(encodeUnitOrder(unitOrder("immutable", 0)))
  })

  it("keeps a unit's intrinsic order when later source events update it", () => {
    const events: ReadonlyArray<SourceEvent> = [
      {
        cursor: "delta",
        sequence: 0,
        type: "model.toolcall.delta",
        createdAt: 0,
        data: { tool_call_id: "call", tool_name: "read", delta: "{" },
      },
      {
        cursor: "requested",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "call", tool_name: "read", input: { path: "src/a.ts" } },
      },
      {
        cursor: "result",
        sequence: 2,
        type: "tool.result.received",
        createdAt: 2,
        data: { tool_call_id: "call", output: "done" },
      },
    ]
    let projection = TranscriptProjection.Projection.project("turn", "prompt", [])
    const orders: Array<string> = []
    for (const event of events) {
      projection = TranscriptProjection.Projection.applyEvent(projection, event)
      const tool = projection.units.find((unit) => unit.key === "tool:turn:call")
      if (tool !== undefined) orders.push(encodeUnitOrder(tool.order))
    }
    expect(new Set(orders).size).toBe(1)
  })

  it("adds nested units without renumbering any previously projected unit", () => {
    const root = TranscriptProjection.Projection.project("root", "delegate", [
      {
        cursor: "tool",
        sequence: 0,
        type: "tool.call.requested",
        createdAt: 0,
        data: { tool_call_id: "agent", tool_name: "task", input: {} },
      },
      { cursor: "answer", sequence: 1, type: "model.output.completed", createdAt: 1, text: "root answer" },
    ])
    const firstChild = TranscriptProjection.Projection.project("child-a", "", [
      { cursor: "a", sequence: 0, type: "model.output.completed", createdAt: 0, text: "a" },
    ])
    const secondChild = TranscriptProjection.Projection.project("child-b", "", [
      { cursor: "b", sequence: 0, type: "model.output.completed", createdAt: 0, text: "b" },
    ])
    const first = withNestedProjections(root, [{ parentId: "root:agent", projection: firstChild }])
    const second = withNestedProjections(root, [
      { parentId: "root:agent", projection: firstChild },
      { parentId: "root:agent", projection: secondChild },
    ])
    const secondOrders = new Map(second.units.map((unit) => [unit.key, encodeUnitOrder(unit.order)]))
    expect(first.units.map((unit) => [unit.key, encodeUnitOrder(unit.order)])).toEqual(
      first.units.map((unit) => [unit.key, secondOrders.get(unit.key)]),
    )
  })
})
