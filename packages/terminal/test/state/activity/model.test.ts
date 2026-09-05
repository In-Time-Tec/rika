import { describe, expect, test } from "vitest"
import { formatActivity, runningToolsActivity } from "../../../src/state/activity/model"
import { initial, type Model } from "../../../src/state/model"
import type { TranscriptBlock, TranscriptItem } from "../../../src/state/transcript/model"

const tool = (id: string, status: "running" | "complete") => ({
  _tag: "ToolCall" as const,
  id,
  name: "status",
  input: "{}",
  status,
  presentation: {
    family: "explore" as const,
    action: "status",
    activeLabel: "Checking",
    completeLabel: "Checked",
  },
  detail: "workspace",
  files: [],
})

const card = (id: string, status: Extract<TranscriptBlock, { _tag: "SubagentCard" }>["status"]): TranscriptBlock => ({
  _tag: "SubagentCard",
  id,
  name: "Task",
  prompt: "p",
  promptTruncated: false,
  summary: "",
  status,
  activity: [],
})

type ActivityBlock = ReturnType<typeof tool> | ReturnType<typeof card>

const model = (blocks: ReadonlyArray<ActivityBlock>, items: ReadonlyArray<TranscriptItem>): Model => ({
  ...initial("/work"),
  blocks: [...blocks],
  entries: [],
  items: [...items],
  width: 100,
  expandedRowKeys: [],
})

const block = (index: number, id: string, parentId?: string) =>
  parentId === undefined
    ? ({ _tag: "Block", index, id } satisfies TranscriptItem)
    : ({ _tag: "Block", index, id, parentId } satisfies TranscriptItem)

const activityOf = (blocks: ReadonlyArray<ActivityBlock>, items: ReadonlyArray<TranscriptItem>) =>
  formatActivity(runningToolsActivity(model(blocks, items)))

describe("running subagent activity", () => {
  test("counts a running subagent card", () => {
    expect(activityOf([tool("k", "complete"), card("c", "running")], [block(0, "k"), block(1, "c", "k")])).toBe(
      "Running 1 subagent",
    )
  })

  test("counts each concurrently admitted child once", () => {
    expect(
      activityOf(
        [tool("k", "complete"), card("a", "running"), card("b", "running")],
        [block(0, "k"), block(1, "a", "k"), block(2, "b", "k")],
      ),
    ).toBe("Running 2 subagents")
  })

  test("does not count a queued child as running", () => {
    expect(activityOf([tool("k", "complete"), card("c", "queued")], [block(0, "k"), block(1, "c", "k")])).toBe(
      "Running tools",
    )
  })

  test("leaves a nested child to the subagent that owns it", () => {
    expect(
      activityOf(
        [tool("k", "complete"), card("task", "running"), tool("tk", "running"), card("oracle", "running")],
        [
          block(0, "root-tool-unit"),
          block(1, "task-card-unit", "k"),
          block(2, "task-tool-unit", "task"),
          block(3, "oracle-card-unit", "task"),
        ],
      ),
    ).toBe("Running 1 subagent")
  })

  test("stops counting a card once it settles", () => {
    expect(activityOf([tool("k", "complete"), card("c", "complete")], [block(0, "k"), block(1, "c", "k")])).toBe(
      "Running tools",
    )
  })

  test("still counts a running native tool", () => {
    expect(activityOf([tool("k", "running")], [block(0, "k")])).toBe("Running 1 tool")
  })
})
