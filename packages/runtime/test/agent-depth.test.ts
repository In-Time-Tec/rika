import { describe, expect, it } from "@effect/vitest"
import { childExecutionDepth, childExecutionId, delegationAvailableAtDepth, toolsAtDepth } from "../src/agent-depth"

describe("agent depth", () => {
  it("tracks encoded ancestry and allows only specialists below the root", () => {
    const depthOne = childExecutionId("execution:root", "first")
    const depthTwo = childExecutionId(depthOne, "second")
    const depthThree = childExecutionId(depthTwo, "third")

    expect(childExecutionDepth("execution:root")).toBe(0)
    expect(childExecutionDepth(depthOne)).toBe(1)
    expect(childExecutionDepth(depthTwo)).toBe(2)
    expect(childExecutionDepth(depthThree)).toBe(3)
    expect(delegationAvailableAtDepth("task", 0)).toBe(true)
    expect(delegationAvailableAtDepth("task", 1)).toBe(false)
    expect(delegationAvailableAtDepth("librarian", 1)).toBe(true)
    expect(delegationAvailableAtDepth("librarian", 2)).toBe(false)
    expect(toolsAtDepth(["read", "task", "oracle", "librarian", "review"], 1)).toEqual([
      "read",
      "oracle",
      "librarian",
      "review",
    ])
    expect(toolsAtDepth(["read", "task", "oracle", "librarian", "review"], 2)).toEqual(["read"])
  })

  it("removes the subagent join tool wherever delegation is unavailable", () => {
    expect(toolsAtDepth(["read", "task", "librarian", "await_subagents"], 1)).toEqual([
      "read",
      "librarian",
      "await_subagents",
    ])
    expect(toolsAtDepth(["read", "task", "await_subagents"], 2)).toEqual(["read"])
  })
})
