import { describe, expect, it } from "@effect/vitest"
import {
  childExecutionDepth,
  childExecutionId,
  delegationAvailableAtDepth,
  delegationBudgetAtDepth,
  toolsAtDepth,
} from "../src/agent-depth"

describe("agent depth", () => {
  it("tracks encoded ancestry and stops delegation after depth two", () => {
    const depthOne = childExecutionId("execution:root", "first")
    const depthTwo = childExecutionId(depthOne, "second")
    const depthThree = childExecutionId(depthTwo, "third")

    expect(childExecutionDepth("execution:root")).toBe(0)
    expect(childExecutionDepth(depthOne)).toBe(1)
    expect(childExecutionDepth(depthTwo)).toBe(2)
    expect(childExecutionDepth(depthThree)).toBe(3)
    expect(delegationAvailableAtDepth(0)).toBe(true)
    expect(delegationAvailableAtDepth(1)).toBe(true)
    expect(delegationAvailableAtDepth(2)).toBe(false)
    expect(toolsAtDepth(["read", "task", "oracle", "librarian", "review"], 1)).toEqual([
      "read",
      "task",
      "oracle",
      "librarian",
      "review",
    ])
    expect(toolsAtDepth(["read", "task", "oracle", "librarian", "review"], 2)).toEqual(["read"])
  })

  it("bounds live subagents more tightly below the root", () => {
    expect(delegationBudgetAtDepth(0)).toBe(4)
    expect(delegationBudgetAtDepth(1)).toBe(2)
  })

  it("removes the subagent join tool wherever delegation is unavailable", () => {
    expect(toolsAtDepth(["read", "task", "await_subagents"], 1)).toEqual(["read", "task", "await_subagents"])
    expect(toolsAtDepth(["read", "task", "await_subagents"], 2)).toEqual(["read"])
  })
})
