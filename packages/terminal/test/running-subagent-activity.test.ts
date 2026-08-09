import { describe, expect, test } from "vitest"
import { formatActivity, runningToolsActivity } from "../src/state/model/terminal-activity-state"
import type { Model } from "../src/state/model/terminal-state"

const cell = (id: string, status: string) => ({
  _tag: "Cell",
  id,
  status,
  visual: "ts",
  summary: "await rika.agents.spawn({})",
  source: { text: "await rika.agents.spawn({})", lines: 1, truncated: false },
  output: { stdout: "", stderr: "", droppedBytes: 0, droppedEvents: 0 },
  epoch: 0,
  notices: [],
  files: [],
})

const card = (id: string, status: string) => ({
  _tag: "SubagentCard",
  id,
  name: "Task",
  prompt: "p",
  promptTruncated: false,
  summary: "",
  status,
  activity: [],
})

const model = (blocks: ReadonlyArray<unknown>, items: ReadonlyArray<unknown>): Model =>
  ({ blocks, entries: [], items, width: 100, expandedRowKeys: [] }) as unknown as Model

const block = (index: number, id: string, parentId?: string) => ({
  _tag: "Block",
  index,
  id,
  ...(parentId === undefined ? {} : { parentId }),
})

const activityOf = (blocks: ReadonlyArray<unknown>, items: ReadonlyArray<unknown>) =>
  formatActivity(runningToolsActivity(model(blocks, items)))

describe("running subagent activity", () => {
  test("counts a running subagent card, which is the only shape a delegating cell produces", () => {
    // A cell spawns children, so the card IS the subagent; counting only agent-family ToolCalls
    // reports zero while the user is plainly waiting on a subagent.
    expect(activityOf([cell("k", "complete"), card("c", "running")], [block(0, "k"), block(1, "c", "k")])).toBe(
      "Running 1 subagent",
    )
  })

  test("counts each concurrently admitted child once", () => {
    expect(
      activityOf(
        [cell("k", "complete"), card("a", "running"), card("b", "running")],
        [block(0, "k"), block(1, "a", "k"), block(2, "b", "k")],
      ),
    ).toBe("Running 2 subagents")
  })

  test("leaves a nested child to the subagent that owns it", () => {
    // root cell -> Task card -> Task's cell -> Oracle card. The user delegated once.
    expect(
      activityOf(
        [cell("k", "complete"), card("task", "running"), cell("tk", "complete"), card("oracle", "running")],
        [block(0, "k"), block(1, "task", "k"), block(2, "tk", "task"), block(3, "oracle", "tk")],
      ),
    ).toBe("Running 1 subagent")
  })

  test("stops counting a card once it settles", () => {
    expect(activityOf([cell("k", "complete"), card("c", "complete")], [block(0, "k"), block(1, "c", "k")])).toBe(
      "Running tools",
    )
  })

  test("still counts a running cell as a tool", () => {
    expect(activityOf([cell("k", "running")], [block(0, "k")])).toBe("Running 1 tool")
  })
})
