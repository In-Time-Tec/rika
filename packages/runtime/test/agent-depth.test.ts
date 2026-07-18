import { describe, expect, it } from "@effect/vitest"
import { childExecutionDepth, childExecutionId, delegationAvailableAtDepth, toolsAtDepth } from "../src/agent-depth"

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
    expect(toolsAtDepth(["read_file", "task", "oracle", "librarian", "review"], 1)).toEqual([
      "read_file",
      "task",
      "oracle",
      "librarian",
      "review",
    ])
    expect(toolsAtDepth(["read_file", "task", "oracle", "librarian", "review"], 2)).toEqual(["read_file"])
  })
})
