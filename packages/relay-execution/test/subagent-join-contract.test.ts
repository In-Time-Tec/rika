import { describe, expect, it } from "vitest"

import { planJoin } from "../src/relay/execution/relay-child-join-plan"

describe("planJoin", () => {
  it("separates pending children from terminal children", () => {
    const plan = planJoin({
      children: [
        { childExecutionId: "child-a", status: "completed" },
        { childExecutionId: "child-b", status: "running" },
      ],
    })
    expect(plan).toEqual([
      { _tag: "terminal", childExecutionId: "child-a" },
      { _tag: "pending", childExecutionId: "child-b" },
    ])
  })

  it("keeps the requested order and drops duplicate requests", () => {
    const plan = planJoin({
      children: [
        { childExecutionId: "child-a", status: "completed" },
        { childExecutionId: "child-b", status: "failed" },
      ],
      requested: ["child-b", "child-a", "child-b"],
    })
    expect(plan.map((target) => target.childExecutionId)).toEqual(["child-b", "child-a"])
  })

  it("marks a requested identifier that is not a child of this execution as unknown", () => {
    const plan = planJoin({
      children: [{ childExecutionId: "child-a", status: "completed" }],
      requested: ["child-z"],
    })
    expect(plan).toEqual([{ _tag: "unknown", childExecutionId: "child-z" }])
  })

  it("selects nothing when the execution has no children", () => {
    expect(planJoin({ children: [] })).toEqual([])
  })
})
